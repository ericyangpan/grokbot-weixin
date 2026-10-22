import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileStorage } from "../src/node/file-storage.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file storage", () => {
  it("creates a 0700 directory and 0600 files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grokbot-weixin-"));
    dirs.push(dir);
    const storage = new FileStorage(dir);
    await storage.set("session", "secret");
    expect(await storage.get("session")).toBe("secret");
    const directory = await stat(dir);
    const file = await stat(path.join(dir, "session"));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    await storage.delete("session");
    expect(await storage.get("session")).toBeNull();
    await expect(storage.set("../escape", "no")).rejects.toThrow(/invalid storage key/);
  });
});
