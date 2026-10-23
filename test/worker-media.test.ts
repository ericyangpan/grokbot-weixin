import { createCipheriv, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

/**
 * Durable Object path: download, decrypt, store two SQL chunks, and serve
 * GET /media/:id. The plaintext is larger than one 64 KB chunk.
 */
describe("Worker media", () => {
  let server: http.Server;
  let worker: Unstable_DevWorker;
  const hits: { path: string; raw: string }[] = [];
  const key = randomBytes(16);
  const plain = Buffer.alloc(70 * 1024, 7);
  plain[0] = 0xff;
  plain[1] = 0xd8;
  plain[2] = 0xff;
  const cipher = encryptEcb(plain, key);

  afterAll(async () => {
    await worker?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("decrypts an image into the Durable Object and requires the bearer token", async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/c2c/download") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(cipher);
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        hits.push({ path, raw });
        res.setHeader("content-type", "application/json");
        if (path.endsWith("/getupdates")) {
          const body = JSON.parse(raw) as { get_updates_buf?: string };
          if (body.get_updates_buf) {
            res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: body.get_updates_buf }));
            return;
          }
          res.end(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: "9",
                  from_user_id: "owner@im.wechat",
                  to_user_id: "bot@im.wechat",
                  message_type: 1,
                  message_state: 2,
                  context_token: "ctx-media",
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        aeskey: key.toString("hex"),
                        media: { encrypt_query_param: "pic" },
                      },
                    },
                  ],
                },
              ],
              get_updates_buf: "c-media",
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

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
        ILINK_API_BASE: base,
        ILINK_CDN_BASE: `${base}/c2c`,
        WEIXIN_BOT_TOKEN: "bot-secret",
        WEIXIN_ACCOUNT_ID: "bot@im.wechat",
        WEIXIN_ALLOW_FROM: "owner@im.wechat",
        GROK_WEBHOOK_URL: `${base}/hook`,
        SEND_TYPING: "false",
        LONG_POLL_TIMEOUT_MS: "5000",
        MEDIA_TRANSCODE_VOICE: "false",
      },
      experimental: {
        disableExperimentalWarning: true,
        forceLocal: true,
        showInteractiveDevSession: false,
      },
    });

    const deadline = Date.now() + 20_000;
    let hook = "";
    while (Date.now() < deadline) {
      await worker.fetch("http://bridge.example/health");
      hook = hits.find((hit) => hit.path === "/hook")?.raw ?? "";
      if (hook.includes("image/jpeg")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(hook).toContain("image/jpeg");
    const event = JSON.parse(hook) as { media: Array<{ url: string; error: string | null; size: number }> };
    expect(event.media[0]?.error).toBeNull();
    expect(event.media[0]?.size).toBe(plain.length);
    const id = event.media[0]?.url.split("/").pop() ?? "";

    const denied = await worker.fetch(`http://bridge.example/media/${id}`);
    expect(denied.status).toBe(401);

    const saved = await worker.fetch(`http://bridge.example/media/${id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("content-type")).toBe("image/jpeg");
    const body = Buffer.from(await saved.arrayBuffer());
    expect(body.equals(plain)).toBe(true);
  }, 40_000);
});

/** AES-128-ECB PKCS#7 ciphertext, matching the iLink CDN. */
function encryptEcb(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
