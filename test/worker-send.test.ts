import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

/**
 * Pinned sender with a space. `isPeerId` rejects it, which is the production
 * bad_request branch for an omitted `to`. The string is synthetic.
 */
const PINNED = "wei xin@im.wechat";

interface Hit {
  path: string;
  raw: string;
}

describe("Worker POST /send", () => {
  let server: http.Server;
  let base: string;
  let worker: Unstable_DevWorker;
  const hits: Hit[] = [];

  afterAll(async () => {
    await worker?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("sends to the sender pinned by the poll loop when to is omitted", async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
                  message_id: "42",
                  from_user_id: PINNED,
                  to_user_id: "bot@im.wechat",
                  message_type: 1,
                  message_state: 2,
                  context_token: "ctx-pinned",
                  item_list: [{ type: 1, text_item: { text: "hi" } }],
                },
              ],
              get_updates_buf: "c1",
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, message_id: "77" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
        ILINK_API_BASE: base,
        WEIXIN_BOT_TOKEN: "bot-secret",
        WEIXIN_ACCOUNT_ID: "bot@im.wechat",
        GROK_WEBHOOK_URL: `${base}/hook`,
        SEND_TYPING: "false",
        LONG_POLL_TIMEOUT_MS: "5000",
      },
      experimental: {
        disableExperimentalWarning: true,
        forceLocal: true,
        showInteractiveDevSession: false,
      },
    });

    const deadline = Date.now() + 8_000;
    let health = "";
    while (Date.now() < deadline) {
      const response = await worker.fetch("http://bridge.example/health");
      health = await response.text();
      if (health.includes('"allowlist_count":1')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(health).toContain('"logged_in":true');
    expect(health).toContain('"allowlist_count":1');

    const call = (body: unknown) =>
      worker.fetch("http://bridge.example/send", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const omitted = await call({ text: "x" });
    const omittedText = await omitted.text();
    expect(omitted.status).toBe(200);
    expect(omittedText).not.toContain(PINNED);

    const blank = await call({ text: "x", to: "" });
    expect(blank.status).toBe(200);
    expect(await blank.text()).not.toContain(PINNED);

    const other = await call({ text: "x", to: "a@b" });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ ok: false, error: "not_allowlisted" });

    const explicit = await call({ text: "x", to: PINNED });
    expect(explicit.status).toBe(200);

    const sent = hits
      .filter((hit) => hit.path.endsWith("/sendmessage"))
      .map((hit) => (JSON.parse(hit.raw) as { msg: { to_user_id: string; context_token?: string } }).msg);
    expect(sent.map((msg) => msg.to_user_id)).toEqual([PINNED, PINNED, PINNED]);
    expect(sent[0]?.context_token).toBe("ctx-pinned");
  }, 20_000);
});
