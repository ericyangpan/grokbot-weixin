import { describe, expect, it } from "vitest";

import { bufferedAccountBody, isHistoryRoute, requestForAccount } from "../src/core/account-request.js";
import { configFromEnv } from "../src/core/config.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { historyStorageKey, loadPeerHistory, rememberInbound } from "../src/core/history.js";
import { redactRequestPath } from "../src/core/history-view.js";
import { writeAllowlist } from "../src/core/state.js";
import { makeApp } from "./support.js";
import type { BridgeApp } from "../src/core/app.js";
import type { InboundEvent } from "../src/core/types.js";

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
      expect(directHtml).not.toContain("Transcript:");
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
    const bytes = await bufferedAccountBody(incoming);
    const forwarded = requestForAccount(incoming, bytes);
    const replay = requestForAccount(incoming, bytes);
    expect(await replay.text()).toBe("{}");
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

  it("shows a voice transcript once and plays only browser audio that is still stored", async () => {
    const app = viewApp();
    await writeAllowlist(app.storage, ["owner@im.wechat"]);
    const put = (mimeType: string, fileName: string, bytes: number[]) =>
      app.media.put({
        bytes: Uint8Array.from(bytes),
        mimeType,
        fileName,
        createdAtMs: NOW,
        expiresAtMs: NOW + 60_000,
        maxTotalBytes: 1_000_000,
      });
    const wav = await put("audio/wav", "voice.wav", [82, 73, 70, 70]);
    const silk = await put("audio/silk", "voice.silk", [2, 3, 4, 5]);
    const image = await put("image/jpeg", "photo.jpg", [255, 216]);
    const gone = await put("audio/wav", "old.wav", [1]);
    await app.media.delete(gone.id);
    await app.storage.set(
      await historyStorageKey("owner@im.wechat"),
      JSON.stringify([
        {
          role: "user",
          text: "seven thirty",
          type: "voice",
          media: [{ kind: "voice", file_name: "voice.wav", transcript: "seven thirty", id: wav.id, mime_type: "audio/wav" }],
          quote: null,
          at_ms: NOW - 4_000,
          message_id: "v1",
        },
        {
          role: "user",
          text: "on my way",
          type: "voice",
          media: [{ kind: "voice", file_name: "voice.silk", transcript: "leaving now", id: silk.id, mime_type: "audio/silk" }],
          quote: null,
          at_ms: NOW - 3_000,
          message_id: "v2",
        },
        {
          role: "user",
          text: "see this",
          type: "image",
          media: [{ kind: "image", file_name: "photo.jpg", transcript: null, id: image.id, mime_type: "image/jpeg" }],
          quote: null,
          at_ms: NOW - 2_000,
          message_id: "v3",
        },
        {
          role: "user",
          text: "too late",
          type: "voice",
          media: [{ kind: "voice", file_name: "old.wav", transcript: "too late", id: gone.id, mime_type: "audio/wav" }],
          quote: null,
          at_ms: NOW - 1_000,
          message_id: "v4",
        },
      ]),
    );

    const minted = await handleBridgeRequest(mintRequest(), app);
    const secret = cookieValue(minted.headers.get("set-cookie") ?? "");
    const page = await handleBridgeRequest(historyRequest(secret), app);
    const html = await page.text();
    expect(times(html, "seven thirty")).toBe(1);
    expect(times(html, "leaving now")).toBe(1);
    expect(times(html, "on my way")).toBe(1);
    expect(times(html, "too late")).toBe(1);
    expect(html).not.toContain("Transcript:");
    expect(html).toContain(`<audio controls preload="none" src="/history/media/${wav.id}"></audio>`);
    expect(html).toContain(`<img src="/history/media/${image.id}" alt="photo.jpg">`);
    expect(html).toContain("Voice message");
    expect(html).not.toContain("audio/silk");
    expect(html).not.toContain(silk.id);
    expect(html).not.toContain(gone.id);
    expect(html).not.toContain(TOKEN);
    expect(html.match(/<audio /g)?.length ?? 0).toBe(1);

    const audio = await handleBridgeRequest(historyRequest(secret, `/history/media/${wav.id}`), app);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toContain("audio/wav");
    const missingCookie = await handleBridgeRequest(new Request(`https://bridge.example/history/media/${wav.id}`), app);
    expect(missingCookie.status).toBe(401);
    const bearer = await handleBridgeRequest(
      new Request(`https://bridge.example/history/media/${wav.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      app,
    );
    expect(bearer.status).toBe(401);
    const stranger = await handleBridgeRequest(historyRequest(secret, `/history/media/${"ab".repeat(16)}`), app);
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).not.toContain("seven thirty");
  });

  it("stores a media id on history without keeping the download url", async () => {
    const app = viewApp();
    const id = "12".repeat(16);
    await rememberInbound(app, "owner@im.wechat", voiceEvent(id));
    const turns = await loadPeerHistory(app, "owner@im.wechat");
    expect(turns?.[0]?.media[0]).toEqual({
      kind: "voice",
      file_name: "voice.wav",
      transcript: "seven thirty",
      id,
      mime_type: "audio/wav",
    });
    expect(JSON.stringify(turns)).not.toContain("https://");
    expect(JSON.stringify(turns)).not.toContain(TOKEN);
  });

  it("clamps the view ttl and redacts codes in request paths", () => {
    expect(configFromEnv({}).historyViewTtlMs).toBe(900_000);
    expect(configFromEnv({ HISTORY_VIEW_TTL_MS: "99999999" }).historyViewTtlMs).toBe(1_800_000);
    expect(configFromEnv({ HISTORY_VIEW_TTL_MS: "1000" }).historyViewTtlMs).toBe(60_000);
    const code = "a".repeat(64);
    expect(redactRequestPath(`/history/r/${code}`)).toBe("/history/r/:code");
    expect(redactRequestPath(`/history/r/${code}`)).not.toContain(code);
    const media = "ab".repeat(16);
    expect(redactRequestPath(`/history/media/${media}`)).toBe("/history/media/:id");
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

function historyRequest(secret: string, path = "/history"): Request {
  return new Request(`https://bridge.example${path}`, {
    headers: { Cookie: `gb_hist=${encodeURIComponent(secret)}` },
  });
}

function times(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function voiceEvent(id: string): InboundEvent {
  return {
    schema: "grokbot-weixin.inbound.v1",
    account_id: "bot@im.wechat",
    sender: { id: "owner@im.wechat", name: null },
    message_id: "v1",
    timestamp_ms: NOW,
    type: "voice",
    state: "finished",
    text: "seven thirty",
    media: [
      {
        kind: "voice",
        file_name: "voice.wav",
        transcript: "seven thirty",
        has_cdn_reference: true,
        mime_type: "audio/wav",
        size: 4,
        url: `https://bridge.example/media/${id}`,
        expires_at_ms: NOW + 60_000,
        duration_ms: 1_200,
        error: null,
      },
    ],
    quote: null,
    history: [],
    context_token: null,
    chat_type: "direct",
    reply: {
      method: "POST",
      url: "https://bridge.example/send",
      headers: { "Content-Type": "application/json", Authorization: "Bearer <BRIDGE_TOKEN>" },
      body: { to: "owner@im.wechat", text: "<reply text>", context_token: null, account: "bot@im.wechat" },
      notes: "",
    },
  };
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
