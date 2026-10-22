import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeStorage } from "../core/storage.js";

const KEY_RE = /^[a-z0-9_]{1,64}$/;

/**
 * File-backed storage under one directory. The directory is mode 0700 and each
 * value file is mode 0600, which matters because the session file holds the bot token.
 */
export class FileStorage implements BridgeStorage {
  constructor(private readonly dir: string) {}

  /** Read a key. Missing files return null. */
  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.file(key), "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /** Atomically replace a key and force mode 0600. */
  async set(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const dest = this.file(key);
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, value, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, dest);
    await chmod(dest, 0o600);
  }

  /** Remove a key. Missing keys are ignored. */
  async delete(key: string): Promise<void> {
    try {
      await unlink(this.file(key));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  private file(key: string): string {
    if (!KEY_RE.test(key)) throw new Error("invalid storage key");
    return path.join(this.dir, key);
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
