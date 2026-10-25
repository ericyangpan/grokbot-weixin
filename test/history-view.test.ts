import { describe, expect, it } from "vitest";

import { isHistoryRoute, requestForAccount } from "../src/core/account-request.js";
import { configFromEnv } from "../src/core/config.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { historyStorageKey } from "../src/core/history.js";
import { redactRequestPath } from "../src/core/history-view.js";
import { writeAllowlist } from "../src/core/state.js";
import { makeApp } from "./support.js";
import type { BridgeApp } from "../src/core/app.js";

const NOW = 1_700_000_000_000;
const DINNER = "what time is the dinner?";
const TOKEN = "test-token";

describe("history view", () => {
  it("mints a one-shot link, redeems it into a cookie, and renders oldest first", async () => {
    const app = viewApp();
    await seedHistory(app);
    let code = "";
    const logs = await captureLogs(async () => {
      const minted = await handleBridgeRequest(mintRequest(), app);
      expect(minted.status).toBe(200);
      expect(minted.headers.get("cache-control")).toContain("no-store");
      const cookie = minted.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/history");
      expect(cookie).toContain("Secure");
      expect(cookie).not.toContain(TOKEN);
      const body = (await minted.json()) as { ok: boolean; url: string; expires_at_ms: number };
      expect(body.ok).toBe(true);
      expect(body.expires_at_ms).toBe(NOW + 60_000);
      expect(body.url).toMatch(/^https:\/\/bridge\.example\/history\/r\/[0-9a-f]{64}$/);
      expect(body.url).not.toContain("?");
      expect(body.url).not.toContain(TOKEN);
      expect(JSON.stringify(body)).not.toContain("owner@im.wechat");
      code = body.url.split("/").pop() ?? "";

      const direct = await handleBridgeRequest(historyRequest(cookieValue(cookie)), app);
      expect(direct.status).toBe(200);
      const directHtml = await direct.text();
      expect(directHtml.indexOf(DINNER)).toBeLessThan(directHtml.indexOf("photo.jpg"));
      expect(directHtml).toContain("Oldest first");
      expect(directHtml).toContain("seven thirty");
      expect(directHtml).toContain("plans");
      expect(directHtml).not.toContain("<script>");
      expect(directHtml).toContain("&lt;script&gt;");
      expect(directHtml).not.toMatch(/https?:\/\//);
      expect(direct.headers.get("cache-control")).toContain("no-store");

      const redeemed = await handleBridgeRequest(new Request(body.url), app);
      expect(redeemed.status).toBe(303);
      expect(redeemed.headers.get("location")).toBe("/history");
      expect(redeemed.headers.get("cache-control")).toContain("no-store");
      const redeemedCookie = redeemed.headers.get("set-cookie") ?? "";
      expect(redeemedCookie).toContain("HttpOnly");
      expect(redeemedCookie).not.toContain(TOKEN);
      expect(redeemedCookie).not.toContain(code);
      const page = await handleBridgeRequest(historyRequest(cookieValue(redeemedCookie)), app);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(DINNER);

      const again = await handleBridgeRequest(new Request(body.url), app);
      expect(again.status).toBe(404);
      expect(await again.text()).not.toContain(DINNER);
    });
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(code);
  });

  it("rejects missing auth, expired sessions, and the bridge token as a view credential", async () => {
    const app = viewApp();
    await seedHistory(app);
    const anonymous = await handleBridgeRequest(mintRequest(""), app);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain(DINNER);

    const minted = await handleBridgeRequest(mintRequest(), app);
    const body = (await minted.json()) as { url: string };
    const secret = cookieValue(minted.headers.get("set-cookie") ?? "");
    app.now = () => NOW + 60_001;
    const expiredPage = await handleBridgeRequest(historyRequest(secret), app);
    expect(expiredPage.status).toBe(401);
    expect(await expiredPage.text()).not.toContain(DINNER);
    const expiredLink = await handleBridgeRequest(new Request(body.url), app);
    expect(expiredLink.status).toBe(404);
    expect(await expiredLink.text()).not.toContain(DINNER);

    app.now = () => NOW;
    const bearer = await handleBridgeRequest(
      new Request("https://bridge.example/history", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      app,
    );
    expect(bearer.status).toBe(401);
    expect(await bearer.text()).not.toContain(DINNER);
    const query = await handleBridgeRequest(new Request(`https://bridge.example/history?t=${TOKEN}`), app);
    expect(query.status).toBe(401);
    expect(await query.text()).not.toContain(DINNER);
    const asCookie = await handleBridgeRequest(historyRequest(TOKEN), app);
    expect(asCookie.status).toBe(401);
    expect(await asCookie.text()).not.toContain(DINNER);
    const asPath = await handleBridgeRequest(new Request(`https://bridge.example/history/r/${TOKEN}`), app);
    expect(await asPath.text()).not.toContain(DINNER);
    const bare = await handleBridgeRequest(new Request("https://bridge.example/history"), app);
    expect(bare.status).toBe(401);
    expect(await bare.text()).not.toContain(DINNER);
  });

  it("requires a peer when the allowlist is not a single sender", async () => {
    const app = viewApp();
    await writeAllowlist(app.storage, ["owner@im.wechat", "second@im.wechat"]);
    const missing = await handleBridgeRequest(mintRequest(), app);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: "peer_required" });
    const stranger = await handleBridgeRequest(mintRequest(TOKEN, { peer: "other@im.wechat" }), app);
    expect(stranger.status).toBe(403);
    const chosen = await handleBridgeRequest(mintRequest(TOKEN, { peer: "second@im.wechat" }), app);
    expect(chosen.status).toBe(200);
    const url = ((await chosen.json()) as { url: string }).url;
    expect(url).not.toContain("second@im.wechat");

    const empty = viewApp();
    const none = await handleBridgeRequest(mintRequest(), empty);
    expect(none.status).toBe(400);

    const unpublished = viewApp({ bridgePublicUrl: "" });
    await writeAllowlist(unpublished.storage, ["owner@im.wechat"]);
    const missingUrl = await handleBridgeRequest(mintRequest(), unpublished);
    expect(missingUrl.status).toBe(409);
    expect(await unpublished.storage.get("history_views")).toBeNull();
  });

  it("routes a Durable Object request whose host is not the public origin", async () => {
    const app = viewApp();
    await seedHistory(app);
    const incoming = mintRequest();
    const forwarded = requestForAccount(incoming);
    expect(forwarded.method).toBe("POST");
    expect(new URL(forwarded.url).pathname).toBe("/history/session");
    expect(new URL(forwarded.url).host).toBe("bridge.internal");
    expect(isHistoryRoute("/history/session")).toBe(true);
    expect(isHistoryRoute("/send")).toBe(false);

    const minted = await handleBridgeRequest(forwarded, app);
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { url: string };
    expect(body.url).toMatch(/^https:\/\/bridge\.example\/history\/r\/[0-9a-f]{64}$/);

    const placeholder = await handleBridgeRequest(
      new Request("https://fake-host/history/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      }),
      app,
    );
    expect(placeholder.status).toBe(200);

    const health = await handleBridgeRequest(new Request("https://fake-host/health"), app);
    expect(await health.json()).toMatchObject({ ok: true, history_view: true });
  });

  it("clamps the view ttl and redacts codes in request paths", () => {
    expect(configFromEnv({}).historyViewTtlMs).toBe(900_000);
    expect(configFromEnv({ HISTORY_VIEW_TTL_MS: "99999999" }).historyViewTtlMs).toBe(1_800_000);
    expect(configFromEnv({ HISTORY_VIEW_TTL_MS: "1000" }).historyViewTtlMs).toBe(60_000);
    const code = "a".repeat(64);
    expect(redactRequestPath(`/history/r/${code}`)).toBe("/history/r/:code");
    expect(redactRequestPath(`/history/r/${code}`)).not.toContain(code);
  });
});

function viewApp(overrides: Parameters<typeof makeApp>[1] = {}): BridgeApp {
  return makeApp(async () => new Response(""), { historyViewTtlMs: 60_000, ...overrides });
}

async function seedHistory(app: BridgeApp): Promise<void> {
  await writeAllowlist(app.storage, ["owner@im.wechat"]);
  await app.storage.set(
    await historyStorageKey("owner@im.wechat"),
    JSON.stringify([
      {
        role: "assistant",
        text: DINNER,
        type: "text",
        media: [],
        quote: null,
        at_ms: NOW - 2_000,
        message_id: "a1",
      },
      {
        role: "user",
        text: "<script>alert(1)</script>",
        type: "mixed",
        media: [{ kind: "image", file_name: "photo.jpg", transcript: "seven thirty" }],
        quote: { title: "plans", text: "dinner", message_id: "q1", media: [] },
        at_ms: NOW - 1_000,
        message_id: "u1",
      },
    ]),
  );
}

function mintRequest(token = TOKEN, body: unknown = {}): Request {
  return new Request("https://bridge.example/history/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function historyRequest(secret: string): Request {
  return new Request("https://bridge.example/history", {
    headers: { Cookie: `gb_hist=${encodeURIComponent(secret)}` },
  });
}

function cookieValue(header: string): string {
  const match = /gb_hist=([^;]+)/.exec(header);
  return decodeURIComponent(match?.[1] ?? "");
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines.join("\n");
}
