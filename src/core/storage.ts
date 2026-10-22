/** Key-value storage injected by each adapter. Values are UTF-8 strings. */
export interface BridgeStorage {
  /** Return the stored string, or null when the key is absent. */
  get(key: string): Promise<string | null>;
  /** Replace the value for a key. */
  set(key: string, value: string): Promise<void>;
  /** Remove a key. Missing keys are not an error. */
  delete(key: string): Promise<void>;
}

/** Parse a JSON value, returning the fallback when the key is missing or corrupt. */
export async function readJson<T>(storage: BridgeStorage, key: string, fallback: T): Promise<T> {
  const raw = await storage.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Store a JSON value. */
export async function writeJson(storage: BridgeStorage, key: string, value: unknown): Promise<void> {
  await storage.set(key, JSON.stringify(value));
}
