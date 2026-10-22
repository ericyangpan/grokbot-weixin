import { describe, expect, it } from "vitest";

import { KEYS } from "../src/core/keys.js";
import { applyQrStatus, advanceQrLogin, beginQrLogin, type QrLoginSession } from "../src/core/login.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { readSession } from "../src/core/state.js";
import { makeApp, mockFetch, type CapturedRequest } from "./support.js";

function session(overrides: Partial<QrLoginSession> = {}): QrLoginSession {
  return {
    qrcode: "qr",
    qrcodeUrl: "https://qr.example/content",
    startedAt: 1_000,
    apiBaseUrl: "https://ilink.test",
    refreshCount: 1,
    phase: "wait",
    message: "",
    ...overrides,
  };
}

describe("QR login state machine", () => {
  it("walks redirect, verify-code, and confirmation", () => {
    const redirected = applyQrStatus(session(), { status: "scaned_but_redirect", redirect_host: "ilink-sg.example" });
    expect(redirected.effect.type).toBe("continue");
    expect(redirected.session.apiBaseUrl).toBe("https://ilink-sg.example");

    const missingHost = applyQrStatus(session(), { status: "scaned_but_redirect" });
    expect(missingHost.session.apiBaseUrl).toBe("https://ilink.test");

    const needsCode = applyQrStatus(session(), { status: "need_verifycode" });
    expect(needsCode.effect).toEqual({ type: "needs_verify_code", retry: false });
    const mismatch = applyQrStatus(session({ pendingVerifyCode: "0000" }), { status: "need_verifycode" });
    expect(mismatch.effect).toEqual({ type: "needs_verify_code", retry: true });
    expect(mismatch.session.pendingVerifyCode).toBeUndefined();

    const confirmed = applyQrStatus(session(), {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot@im.wechat",
      baseurl: "https://acct.example",
      ilink_user_id: "owner@im.wechat",
    });
    expect(confirmed.effect.type).toBe("confirmed");
    expect(confirmed.session.botToken).toBe("bot-secret");
    expect(confirmed.session.accountId).toBe("bot@im.wechat");
    expect(confirmed.session.userId).toBe("owner@im.wechat");

    const incomplete = applyQrStatus(session(), { status: "confirmed", ilink_bot_id: "bot@im.wechat" });
    expect(incomplete.effect.type).toBe("failed");
    expect(applyQrStatus(session(), { status: "binded_redirect" }).effect.type).toBe("already_connected");
    expect(applyQrStatus(session(), { status: "surprise" }).effect.type).toBe("continue");
  });

  it("refreshes twice and then stops, matching the upstream counter", () => {
    let current = session();
    const first = applyQrStatus(current, { status: "expired" });
    expect(first.effect.type).toBe("refresh_qr");
    current = first.session;
    const second = applyQrStatus(current, { status: "verify_code_blocked" });
    expect(second.effect.type).toBe("refresh_qr");
    expect(second.session.refreshCount).toBe(3);
    const third = applyQrStatus(second.session, { status: "expired" });
    expect(third.effect.type).toBe("failed");
  });

  it("follows a redirect host on the next status poll", async () => {
    const mock = mockFetch((request) => {
      if (request.url.pathname.endsWith("/get_bot_qrcode")) {
        return { status: 200, body: JSON.stringify({ qrcode: "qr-1", qrcode_img_content: "https://qr.example/1" }) };
      }
      if (request.url.hostname === "ilink.test") {
        return { status: 200, body: JSON.stringify({ status: "scaned_but_redirect", redirect_host: "edge.example" }) };
      }
      return { status: 200, body: JSON.stringify({ status: "wait" }) };
    });
    const app = makeApp(mock.fetchImpl);
    const started = await beginQrLogin(app.client, {
      apiBase: "https://ilink.test",
      botType: "3",
      localTokens: [],
      now: 1_000,
    });
    const advanced = await advanceQrLogin(app.client, started, {
      apiBase: "https://ilink.test",
      botType: "3",
      localTokens: [],
      timeoutMs: 1000,
      now: 1_000,
    });
    expect(advanced.session.apiBaseUrl).toBe("https://edge.example");
    await advanceQrLogin(app.client, advanced.session, {
      apiBase: "https://ilink.test",
      botType: "3",
      localTokens: [],
      timeoutMs: 1000,
      now: 1_000,
    });
    const hosts = mock.calls.filter((call) => call.url.pathname.includes("get_qrcode_status")).map((call) => call.url.hostname);
    expect(hosts).toEqual(["ilink.test", "edge.example"]);
  });
});

describe("login HTTP flow", () => {
  it("stores credentials and does not return the bot token", async () => {
    let statusCalls = 0;
    const mock = mockFetch((request: CapturedRequest) => {
      if (request.url.pathname.endsWith("/get_bot_qrcode")) {
        return { status: 200, body: JSON.stringify({ qrcode: "qr-secret", qrcode_img_content: "https://qr.example/show" }) };
      }
      statusCalls += 1;
      if (statusCalls === 1) return { status: 200, body: JSON.stringify({ status: "wait" }) };
      return {
        status: 200,
        body: JSON.stringify({
          status: "confirmed",
          bot_token: "bot-secret",
          ilink_bot_id: "bot@im.wechat",
          ilink_user_id: "owner@im.wechat",
          baseurl: "https://acct.example",
        }),
      };
    });
    const app = makeApp(mock.fetchImpl, { allowFrom: [], pinFirstSender: true });
    const denied = await handleBridgeRequest(new Request("http://localhost/login/start", { method: "POST" }), app);
    expect(denied.status).toBe(401);

    const started = await handleBridgeRequest(
      new Request("http://localhost/login/start", { method: "POST", headers: { Authorization: "Bearer test-token" } }),
      app,
    );
    const startBody = (await started.json()) as { qrcode_url: string; qr_svg: string };
    expect(startBody.qrcode_url).toBe("https://qr.example/show");
    expect(startBody.qr_svg).toContain("<svg");
    expect(JSON.stringify(startBody)).not.toContain("qr-secret");

    await handleBridgeRequest(
      new Request("http://localhost/login/status", { headers: { Authorization: "Bearer test-token" } }),
      app,
    );
    const confirmed = await handleBridgeRequest(
      new Request("http://localhost/login/status", { headers: { Authorization: "Bearer test-token" } }),
      app,
    );
    const body = await confirmed.json() as { phase: string; account_id: string; user_id: string };
    expect(body.phase).toBe("confirmed");
    expect(body.account_id).toBe("bot@im.wechat");
    expect(JSON.stringify(body)).not.toContain("bot-secret");
    const stored = await readSession(app.storage);
    expect(stored?.botToken).toBe("bot-secret");
    expect(stored?.baseUrl).toBe("https://acct.example");
    expect(await app.storage.get(KEYS.allowlist)).toContain("owner@im.wechat");
    expect(app.onLoggedIn).toBeUndefined();
  });
});
