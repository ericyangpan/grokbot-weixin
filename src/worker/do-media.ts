import { MEDIA_CHUNK_BYTES } from "../core/constants.js";
import { logWarn, publicError } from "../core/log.js";
import {
  idsToEvict,
  joinChunks,
  newMediaId,
  splitChunks,
  type MediaObject,
  type MediaPut,
  type MediaRecord,
  type MediaStore,
} from "../core/media-store.js";

type ObjectRow = {
  id: string;
  mime_type: string;
  file_name: string;
  size: number;
  expires_at_ms: number;
  created_at_ms: number;
};

type ChunkRow = {
  idx: number;
  data: SqlStorageValue;
};

/**
 * Create the media tables next to the kv table. Safe to call on every boot.
 */
export function ensureMediaSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS media_object (
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS media_chunk (
      id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (id, idx)
    )`,
  );
}

/**
 * Decrypted attachments in the account Durable Object.
 * Blobs are split into 64 KB chunks because a SQLite row cannot exceed 2 MB.
 */
export class DoMediaStore implements MediaStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Insert one object inside a storage transaction. */
  async put(input: MediaPut): Promise<MediaRecord> {
    const records = this.listRecords();
    const evict = idsToEvict(records, input.createdAtMs, input.bytes.byteLength, input.maxTotalBytes);
    const live = records
      .filter((record) => record.expiresAtMs > input.createdAtMs && !evict.includes(record.id))
      .reduce((sum, record) => sum + record.size, 0);
    if (input.bytes.byteLength > input.maxTotalBytes || live + input.bytes.byteLength > input.maxTotalBytes) {
      throw new Error("storage_failed");
    }
    const record = freshRecord(input, records);
    const chunks = splitChunks(input.bytes, MEDIA_CHUNK_BYTES);
    try {
      this.storage.transactionSync(() => {
        for (const id of evict) this.removeRows(id);
        this.sql.exec(
          "INSERT INTO media_object (id, mime_type, file_name, size, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          record.id,
          record.mimeType,
          record.fileName,
          record.size,
          record.expiresAtMs,
          record.createdAtMs,
        );
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (!chunk) continue;
          this.sql.exec("INSERT INTO media_chunk (id, idx, data) VALUES (?, ?, ?)", record.id, index, exactBuffer(chunk));
        }
      });
    } catch (err) {
      logWarn("media_store_failed", { error: publicError(err) });
      throw new Error("storage_failed");
    }
    return record;
  }

  /** Reassemble chunks in index order. A gap deletes the object. */
  async get(id: string): Promise<MediaObject | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    const row = this.sql
      .exec<ObjectRow>("SELECT id, mime_type, file_name, size, expires_at_ms, created_at_ms FROM media_object WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    const chunks = this.sql
      .exec<ChunkRow>("SELECT idx, data FROM media_chunk WHERE id = ? ORDER BY idx ASC", id)
      .toArray();
    const parts: Uint8Array[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.idx !== index) {
        await this.delete(id);
        return null;
      }
      parts.push(asBytes(chunk.data));
    }
    const bytes = joinChunks(parts);
    if (bytes.byteLength !== row.size) {
      await this.delete(id);
      return null;
    }
    return {
      id: row.id,
      mimeType: row.mime_type,
      fileName: row.file_name,
      size: row.size,
      expiresAtMs: row.expires_at_ms,
      createdAtMs: row.created_at_ms,
      bytes,
    };
  }

  /** Delete the object and its chunks. */
  async delete(id: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(id)) return;
    this.storage.transactionSync(() => {
      this.removeRows(id);
    });
  }

  /** Delete every expired object. */
  async deleteExpired(nowMs: number): Promise<void> {
    const stale = this.listRecords().filter((record) => record.expiresAtMs <= nowMs);
    if (stale.length === 0) return;
    this.storage.transactionSync(() => {
      for (const record of stale) this.removeRows(record.id);
    });
  }

  /** SQL handle for this object. */
  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Metadata rows only. */
  private listRecords(): MediaRecord[] {
    const rows = this.sql
      .exec<ObjectRow>("SELECT id, mime_type, file_name, size, expires_at_ms, created_at_ms FROM media_object")
      .toArray();
    return rows.map((row) => ({
      id: row.id,
      mimeType: row.mime_type,
      fileName: row.file_name,
      size: row.size,
      expiresAtMs: row.expires_at_ms,
      createdAtMs: row.created_at_ms,
    }));
  }

  /** Remove both tables' rows for one id. Caller holds the transaction. */
  private removeRows(id: string): void {
    this.sql.exec("DELETE FROM media_chunk WHERE id = ?", id);
    this.sql.exec("DELETE FROM media_object WHERE id = ?", id);
  }
}

/** Copy a SQL blob into a Uint8Array. Workerd may return ArrayBuffer or a view. */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("storage_failed");
}

/** An ArrayBuffer that contains only `bytes`, for a SQL BLOB binding. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}

/** Allocate an id that is not already in `existing`. */
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
