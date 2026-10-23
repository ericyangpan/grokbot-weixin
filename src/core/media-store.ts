import { MEDIA_CHUNK_BYTES } from "./constants.js";

/** Metadata kept for one decrypted object. `id` is unguessable. */
export interface MediaRecord {
  id: string;
  mimeType: string;
  fileName: string;
  size: number;
  expiresAtMs: number;
  createdAtMs: number;
}

/** A stored object plus its plaintext bytes. */
export interface MediaObject extends MediaRecord {
  bytes: Uint8Array;
}

/** What the resolver hands the store. The store assigns `id`. */
export interface MediaPut {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  expiresAtMs: number;
  createdAtMs: number;
  maxTotalBytes: number;
}

/** Short-lived blob store. Implementations delete expired rows themselves. */
export interface MediaStore {
  /** Save bytes and evict expired or oldest objects until the budget fits. */
  put(input: MediaPut): Promise<MediaRecord>;
  /** Return the object, including one that is already expired. */
  get(id: string): Promise<MediaObject | null>;
  /** Remove one object. Missing ids are not an error. */
  delete(id: string): Promise<void>;
  /** Remove every object whose `expiresAtMs` is at or before `nowMs`. */
  deleteExpired(nowMs: number): Promise<void>;
}

/** 32 hex characters from a CSPRNG. */
export function newMediaId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}

/**
 * Ids to remove before a put: everything expired, then oldest live objects
 * until `incomingBytes` fits in `maxTotalBytes`.
 */
export function idsToEvict(
  records: MediaRecord[],
  nowMs: number,
  incomingBytes: number,
  maxTotalBytes: number,
): string[] {
  const expired: string[] = [];
  const live: MediaRecord[] = [];
  for (const record of records) {
    if (record.expiresAtMs <= nowMs) expired.push(record.id);
    else live.push(record);
  }
  live.sort((left, right) => left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  let total = 0;
  for (const record of live) total += record.size;
  const evict = [...expired];
  for (const record of live) {
    if (total + incomingBytes <= maxTotalBytes) break;
    evict.push(record.id);
    total -= record.size;
  }
  return evict;
}

/** Split `bytes` into independent chunks of at most `size` bytes. */
export function splitChunks(bytes: Uint8Array, size: number = MEDIA_CHUNK_BYTES): Uint8Array[] {
  if (size < 1) throw new Error("storage_failed");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + size)));
  }
  return chunks;
}

/** Join chunks that were produced by `splitChunks`. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** In-memory store used by tests and as the shape the other stores follow. */
export class MemoryMediaStore implements MediaStore {
  private readonly objects = new Map<string, MediaObject>();

  /** Save a copy of `input.bytes`. */
  async put(input: MediaPut): Promise<MediaRecord> {
    const records = [...this.objects.values()];
    const evict = idsToEvict(records, input.createdAtMs, input.bytes.byteLength, input.maxTotalBytes);
    for (const id of evict) this.objects.delete(id);
    const live = [...this.objects.values()].reduce((sum, object) => sum + object.size, 0);
    if (input.bytes.byteLength > input.maxTotalBytes || live + input.bytes.byteLength > input.maxTotalBytes) {
      throw new Error("storage_failed");
    }
    const record = this.freshRecord(input, records);
    this.objects.set(record.id, { ...record, bytes: new Uint8Array(input.bytes) });
    return record;
  }

  /** Return the stored object, or null. */
  async get(id: string): Promise<MediaObject | null> {
    return this.objects.get(id) ?? null;
  }

  /** Drop one object. */
  async delete(id: string): Promise<void> {
    this.objects.delete(id);
  }

  /** Drop expired objects. */
  async deleteExpired(nowMs: number): Promise<void> {
    for (const [id, object] of this.objects) {
      if (object.expiresAtMs <= nowMs) this.objects.delete(id);
    }
  }

  /** Allocate an id that is not already stored. */
  private freshRecord(input: MediaPut, existing: MediaRecord[]): MediaRecord {
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
}
