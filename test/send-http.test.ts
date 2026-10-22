import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "../src/core/auth.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { KEYS } from "../src/core/keys.js";
import { writeAllowlist, writeContextTokens, writeSession } from "../src/core/state.js";
import { makeApp, mockFetch } from "./support.js";

async function loggedInApp(fetchImpl: typeof fetch, overrides: Parameters<typeof makeApp>[1] = {}) {
  const app = makeApp(fetchImpl, overrides);
  await writeSession(app.storage, {
    botToken: "bot-secret",
    accountId: "bot@im.wechat",
    baseUrl: "https://acct.example",
    savedAt: 1,
  });
  await writeAllowlist(app.storage, ["owner@im.wechat"]);
  await writeContextTokens(app.storage, { "owner@im.wechat": "stored-ctx" });
  return app;
}

function send(body: unknown, token = "test-token"): Request {
  return new Request("http://127.0.0.1/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("bridge auth", () => {
  it("compares equal strings and rejects different lengths", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
  });
});

describe("POST /send", () => {
  it("requires the bearer token, the allowlist, and uses the stored context token", async () => {
    const mock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: 0, message_id: "55" }) }));
    const app = await loggedInApp(mock.fetchImpl);
    const health = await handleBridgeRequest(new Request("http://127.0.0.1/health"), app);
    const healthBody = await health.json() as Record<string, unknown>;
    expect(healthBody.logged_in).toBe(true);
    expect(JSON.stringify(healthBody)).not.toContain("bot-secret");
    expect(JSON.stringify(healthBody)).not.toContain("stored-ctx");

    expect((await handleBridgeRequest(send({ to: "owner@im.wechat", text: "hi" }, ""), app)).status).toBe(401);
    expect((await handleBridgeRequest(send({ to: "owner@im.wechat", text: "hi" }, "nope"), app)).status).toBe(401);
    expect((await handleBridgeRequest(send({ to: "other@im.wechat", text: "hi" }), app)).status).toBe(403);

    const ok = await handleBridgeRequest(send({ to: "owner@im.wechat", text: "hi" }), app);
    expect(ok.status).toBe(200);
    const payload = JSON.parse(mock.calls[0]?.body ?? "{}") as { msg: { context_token?: string; to_user_id: string } };
    expect(mock.calls[0]?.url.hostname).toBe("acct.example");
    expect(payload.msg.context_token).toBe("stored-ctx");
    expect(payload.msg.to_user_id).toBe("owner@im.wechat");
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer bot-secret");
  });

  it("rate limits and reports a rejected context token", async () => {
    const limited = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: 0 }) }));
    const limitedApp = await loggedInApp(limited.fetchImpl, { rateLimitPerMinute: 1 });
    expect((await handleBridgeRequest(send({ to: "owner@im.wechat", text: "one" }), limitedApp)).status).toBe(200);
    expect((await handleBridgeRequest(send({ to: "owner@im.wechat", text: "two" }), limitedApp)).status).toBe(429);

    const rejected = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: -2, errmsg: "" }) }));
    const rejectedApp = await loggedInApp(rejected.fetchImpl);
    await rejectedApp.storage.delete(KEYS.contextTokens);
    const response = await handleBridgeRequest(
      send({ to: "owner@im.wechat", text: "hi", context_token: "stale" }),
      rejectedApp,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "context_token_rejected" });
  });

  it("imports a session from the admin endpoint without echoing the token", async () => {
    const app = makeApp(mockFetch(() => ({ status: 200, body: "{}" })).fetchImpl);
    let armed = false;
    app.onLoggedIn = async () => {
      armed = true;
    };
    const response = await handleBridgeRequest(
      new Request("http://127.0.0.1/admin/session", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: "imported-secret", account_id: "bot@im.wechat", user_id: "owner@im.wechat" }),
      }),
      app,
    );
    const body = await response.json() as { ok: boolean; account_id: string };
    expect(body).toEqual({ ok: true, account_id: "bot@im.wechat" });
    expect(JSON.stringify(body)).not.toContain("imported-secret");
    expect(armed).toBe(true);
    expect(await app.storage.get(KEYS.session)).toContain("imported-secret");
  });
});
