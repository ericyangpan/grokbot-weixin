import { afterAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

describe("Worker history view", () => {
  let worker: Unstable_DevWorker;

  afterAll(async () => {
    await worker?.stop();
  });

  it("mints a session when the request is forwarded into the Durable Object", async () => {
    worker = await unstable_dev("src/worker/index.ts", {
      config: "wrangler.toml",
      local: true,
      persist: false,
      inspectorPort: 0,
      ip: "127.0.0.1",
      port: 0,
      logLevel: "error",
      vars: {
        BRIDGE_TOKEN: "test-token",
        BRIDGE_PUBLIC_URL: "https://bridge.example",
        WEIXIN_ALLOW_FROM: "owner@im.wechat",
        SEND_TYPING: "false",
        LONG_POLL_TIMEOUT_MS: "5000",
      },
      experimental: {
        disableExperimentalWarning: true,
        forceLocal: true,
        showInteractiveDevSession: false,
      },
    });

    const health = await worker.fetch("http://bridge.example/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ history_view: true });

    const minted = await worker.fetch("http://bridge.example/history/session", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: "{}",
    });
    const text = await minted.text();
    expect(minted.status).toBe(200);
    expect(text).toContain("/history/r/");
    expect(text).not.toContain("test-token");
    expect(text).not.toContain("owner@im.wechat");
    expect(text).not.toContain("not_found");

    const cookie = minted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("gb_hist=");
    const wasm = await worker.fetch("http://bridge.example/history/silk.wasm", { headers: { Cookie: cookie } });
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toContain("application/wasm");
    const magic = new Uint8Array(await wasm.arrayBuffer());
    expect(String.fromCharCode(...magic.subarray(0, 4))).toBe("\0asm");
    const anon = await worker.fetch("http://bridge.example/history/silk.js");
    expect(anon.status).toBe(401);
    const bearer = await worker.fetch("http://bridge.example/history/player.js", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.text()).not.toContain("test-token");
  }, 60_000);
});
