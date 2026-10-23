import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "../src/core/auth.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { KEYS } from "../src/core/keys.js";
import { runPollStep } from "../src/core/poll.js";
import { writeAllowlist, writeContextTokens, writeSession } from "../src/core/state.js";
import { makeApp, mockFetch, type CapturedRequest } from "./support.js";

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

  it("sends to the sole allowlisted peer when to is omitted", async () => {
    const mock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: 0, message_id: "70" }) }));
    const app = await loggedInApp(mock.fetchImpl);
    const response = await handleBridgeRequest(send({ text: "proactive" }), app);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("owner@im.wechat");
    const sent = JSON.parse(mock.calls[0]?.body ?? "{}") as { msg: { to_user_id: string; context_token?: string } };
    expect(sent.msg.to_user_id).toBe("owner@im.wechat");
    expect(sent.msg.context_token).toBe("stored-ctx");

    const blank = await handleBridgeRequest(send({ to: "  ", text: "also" }), app);
    expect(blank.status).toBe(200);
    const second = JSON.parse(mock.calls[1]?.body ?? "{}") as { msg: { to_user_id: string } };
    expect(second.msg.to_user_id).toBe("owner@im.wechat");
  });

  it("requires a recipient when the allowlist is empty", async () => {
    const mock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: 0 }) }));
    const app = await loggedInApp(mock.fetchImpl);
    await writeAllowlist(app.storage, []);
    const response = await handleBridgeRequest(send({ text: "hi" }), app);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "recipient_required" });
    expect(mock.calls).toHaveLength(0);

    await writeAllowlist(app.storage, ["owner@im.wechat", "second@im.wechat"]);
    const several = await handleBridgeRequest(send({ text: "hi" }), app);
    expect(several.status).toBe(400);
    expect(await several.json()).toEqual({ ok: false, error: "recipient_required" });
    expect(mock.calls).toHaveLength(0);
  });

  it("sends to a pinned sender that fails the explicit peer-id check", async () => {
    const pinned = "wei xin@im.wechat";
    const mock = mockFetch((request) => {
      if (request.url.pathname.endsWith("/getupdates")) {
        return {
          status: 200,
          body: JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: "42",
                from_user_id: pinned,
                message_type: 1,
                message_state: 2,
                context_token: "ctx-pinned",
                item_list: [{ type: 1, text_item: { text: "hi" } }],
              },
            ],
            get_updates_buf: "c1",
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ ret: 0, message_id: "77" }) };
    });
    const app = makeApp(mock.fetchImpl);
    await writeSession(app.storage, {
      botToken: "bot-secret",
      accountId: "bot@im.wechat",
      savedAt: 1,
    });
    await runPollStep(app);

    const omitted = await handleBridgeRequest(send({ text: "x" }), app);
    expect(omitted.status).toBe(200);
    const omittedBody = await omitted.json() as Record<string, unknown>;
    expect(omittedBody.ok).toBe(true);
    expect(JSON.stringify(omittedBody)).not.toContain(pinned);

    const blank = await handleBridgeRequest(send({ text: "x", to: "" }), app);
    expect(blank.status).toBe(200);

    const explicit = await handleBridgeRequest(send({ text: "x", to: pinned }), app);
    expect(explicit.status).toBe(200);

    const other = await handleBridgeRequest(send({ text: "x", to: "a@b" }), app);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ ok: false, error: "not_allowlisted" });

    const sent = mock.calls
      .filter((call: CapturedRequest) => call.url.pathname.endsWith("/sendmessage"))
      .map((call) => (JSON.parse(call.body) as { msg: { to_user_id: string; context_token?: string } }).msg);
    expect(sent.map((msg) => msg.to_user_id)).toEqual([pinned, pinned, pinned]);
    expect(sent[0]?.context_token).toBe("ctx-pinned");
  });

  it("still rejects an explicit recipient that is not allowlisted", async () => {
    const mock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ret: 0 }) }));
    const app = await loggedInApp(mock.fetchImpl);
    const response = await handleBridgeRequest(send({ to: "other@im.wechat", text: "hi" }), app);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "not_allowlisted" });
    expect(mock.calls).toHaveLength(0);
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
