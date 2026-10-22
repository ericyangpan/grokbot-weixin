import type { BridgeStorage } from "../core/storage.js";

/**
 * SQLite key-value table inside the account Durable Object.
 * One row per key keeps cursor updates to a single write.
 */
export class DoStorage implements BridgeStorage {
  constructor(private readonly sql: SqlStorage) {}

  /** Read one value. */
  async get(key: string): Promise<string | null> {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  /** Insert or replace one value. */
  async set(key: string, value: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, value);
  }

  /** Delete one key. */
  async delete(key: string): Promise<void> {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }
}
