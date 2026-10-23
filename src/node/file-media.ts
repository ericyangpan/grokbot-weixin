import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { idsToEvict, newMediaId, type MediaObject, type MediaPut, type MediaRecord, type MediaStore } from "../core/media-store.js";

const ID_RE = /^[0-9a-f]{32}$/;

/**
 * Decrypted attachments on disk. The directory is mode 0700 and each file is
 * mode 0600. Names are the random id, never the sender's file name.
 */
export class FileMediaStore implements MediaStore {
  constructor(private readonly dir: string) {}

  /** Write the bytes and a JSON sidecar, evicting until the budget fits. */
  async put(input: MediaPut): Promise<MediaRecord> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const records = await this.readRecords();
    const evict = idsToEvict(records, input.createdAtMs, input.bytes.byteLength, input.maxTotalBytes);
    for (const id of evict) await this.delete(id);
    const live = records
      .filter((record) => record.expiresAtMs > input.createdAtMs && !evict.includes(record.id))
      .reduce((sum, record) => sum + record.size, 0);
    if (input.bytes.byteLength > input.maxTotalBytes || live + input.bytes.byteLength > input.maxTotalBytes) {
      throw new Error("storage_failed");
    }
    const record = freshRecord(input, records);
    const bin = this.binPath(record.id);
    const meta = this.metaPath(record.id);
    const binTmp = `${bin}.${process.pid}.tmp`;
    await writeFile(binTmp, input.bytes, { mode: 0o600 });
    await rename(binTmp, bin);
    await chmod(bin, 0o600);
    try {
      const metaTmp = `${meta}.${process.pid}.tmp`;
      await writeFile(metaTmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      await rename(metaTmp, meta);
      await chmod(meta, 0o600);
    } catch (err) {
      await this.delete(record.id);
      throw err;
    }
    return record;
  }

  /** Read one object. A size mismatch is treated as missing. */
  async get(id: string): Promise<MediaObject | null> {
    if (!ID_RE.test(id)) return null;
    const record = await this.readOne(id);
    if (!record) return null;
    try {
      const bytes = new Uint8Array(await readFile(this.binPath(id)));
      if (bytes.byteLength !== record.size) return null;
      return { ...record, bytes };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /** Remove the sidecar and the bytes. */
  async delete(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await rm(this.binPath(id));
    await rm(this.metaPath(id));
  }

  /** Remove every expired sidecar. */
  async deleteExpired(nowMs: number): Promise<void> {
    const records = await this.readRecords();
    for (const record of records) {
      if (record.expiresAtMs <= nowMs) await this.delete(record.id);
    }
  }

  /** List sidecars. Corrupt files are deleted. */
  private async readRecords(): Promise<MediaRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const records: MediaRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!ID_RE.test(id)) continue;
      const record = await this.readOne(id);
      if (record) records.push(record);
      else await this.delete(id);
    }
    return records;
  }

  /** Parse one sidecar. */
  private async readOne(id: string): Promise<MediaRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(id), "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    return parseRecord(raw, id);
  }

  /** Path of the plaintext file. `id` is already checked against ID_RE. */
  private binPath(id: string): string {
    return path.join(this.dir, `${id}.bin`);
  }

  /** Path of the JSON sidecar. */
  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}

/** Build a record with an id that is not in `existing`. */
function freshRecord(input: MediaPut, existing: MediaRecord[]): MediaRecord {
  const taken = new Set(existing.map((record) => record.id));
  let id = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    id = newMediaId();
    if (!taken.has(id)) break;
    id = "";
  }
  if (!id) throw new Error("storage_failed");
  return {
    id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    size: input.bytes.byteLength,
    expiresAtMs: input.expiresAtMs,
    createdAtMs: input.createdAtMs,
  };
}

/** Accept only the fields this store writes. */
function parseRecord(raw: string, id: string): MediaRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<MediaRecord>;
    if (!value || value.id !== id) return null;
    if (typeof value.mimeType !== "string" || typeof value.fileName !== "string") return null;
    if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) return null;
    if (typeof value.expiresAtMs !== "number" || !Number.isInteger(value.expiresAtMs)) return null;
    if (typeof value.createdAtMs !== "number" || !Number.isInteger(value.createdAtMs)) return null;
    return {
      id,
      mimeType: value.mimeType,
      fileName: value.fileName,
      size: value.size,
      expiresAtMs: value.expiresAtMs,
      createdAtMs: value.createdAtMs,
    };
  } catch {
    return null;
  }
}

/** Unlink a file and ignore a missing path. */
async function rm(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/** True for a missing file or directory. */
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
