import { isAuthorized, isPeerId, timingSafeEqual } from "./auth.js";
import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
import { BODY_MAX_BYTES, QR_LOGIN_TTL_MS, QR_STATUS_TIMEOUT_MS, SEND_TEXT_MAX, VERSION } from "./constants.js";
import { KEYS } from "./keys.js";
import { advanceQrLogin, beginQrLogin, type QrLoginSession } from "./login.js";
import { renderLoginApp, renderTokenForm } from "./login-page.js";
import { logWarn, publicError } from "./log.js";
import { persistConfirmedLogin } from "./persist.js";
import { qrSvg } from "./qr.js";
import { readAllowlist, readSession, localBotTokens, writeAllowlist } from "./state.js";
import { readJson, writeJson } from "./storage.js";
import { sendBridgeText } from "./send.js";
import { takeSendSlot } from "./state.js";

/** HTTP API shared by the Node server and the Worker. */
export async function handleBridgeRequest(request: Request, app: BridgeApp): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method === "GET" && path === "/health") return json(await healthReport(app));
    if (request.method === "GET" && path === "/login") return loginPage(request, app);
    if (request.method === "POST" && path === "/login/session") return loginSession(request, app);
    if (!(await isAuthorized(request, app.config.bridgeToken))) return json({ ok: false, error: "unauthorized" }, 401);
    if (request.method === "POST" && path === "/login/start") return loginStart(request, app, url);
    if (request.method === "GET" && path === "/login/status") return loginStatus(app);
    if (request.method === "POST" && path === "/login/verify") return loginVerify(request, app);
    if (request.method === "POST" && path === "/admin/session") return adminSession(request, app);
    if (request.method === "POST" && path === "/admin/allowlist") return adminAllowlist(request, app);
    if (request.method === "POST" && path === "/send") return send(request, app);
    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, error: err.code }, err.status);
    logWarn("http_failed", { path, error: publicError(err) });
    return json({ ok: false, error: "internal" }, 500);
  }
}

/** Public health view. It does not include ids, cursors, or secrets. */
export async function healthReport(app: BridgeApp): Promise<Record<string, unknown>> {
  const session = await readSession(app.storage);
  const allow = await readAllowlist(app.storage);
  const pauseRaw = await app.storage.get(KEYS.pauseUntil);
  const pauseUntil = pauseRaw ? Number(pauseRaw) : 0;
  const paused = Number.isFinite(pauseUntil) && pauseUntil > appNow(app);
  return {
    ok: true,
    version: VERSION,
    logged_in: Boolean(session),
    allowlist_count: allow.length,
    paused,
    paused_until: paused ? pauseUntil : null,
    webhook_configured: Boolean(app.config.webhookUrl),
    public_url_configured: Boolean(app.config.bridgePublicUrl),
  };
}

async function loginPage(request: Request, app: BridgeApp): Promise<Response> {
  if (!(await isAuthorized(request, app.config.bridgeToken))) {
    return html(renderTokenForm(), 200, false);
  }
  return html(renderLoginApp(), 200, new URL(request.url).protocol === "https:");
}

async function loginSession(request: Request, app: BridgeApp): Promise<Response> {
  const proof = await readProof(request);
  if (!proof || !(await timingSafeEqual(proof, app.config.bridgeToken)) || !app.config.bridgeToken) {
    return html(renderTokenForm(), 401, false);
  }
  const secure = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": sessionCookie(app.config.bridgeToken, secure),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function loginStart(request: Request, app: BridgeApp, url: URL): Promise<Response> {
  const force = url.searchParams.get("force") === "1";
  const now = appNow(app);
  if (!force) {
    const existing = await readLogin(app);
    if (existing && now - existing.startedAt < QR_LOGIN_TTL_MS && existing.phase !== "failed" && existing.phase !== "confirmed") {
      return json(publicLogin(existing));
    }
  }
  const session = await beginQrLogin(app.client, {
    apiBase: app.config.ilinkApiBase,
    botType: app.config.ilinkBotType,
    localTokens: await localBotTokens(app.storage),
    now,
  });
  await writeJson(app.storage, KEYS.login, session);
  return json(publicLogin(session));
}

async function loginStatus(app: BridgeApp): Promise<Response> {
  const current = await readLogin(app);
  if (!current) return json({ ok: false, error: "no_login" }, 404);
  const advanced = await advanceQrLogin(app.client, current, {
    apiBase: app.config.ilinkApiBase,
    botType: app.config.ilinkBotType,
    localTokens: await localBotTokens(app.storage),
    timeoutMs: QR_STATUS_TIMEOUT_MS,
    now: appNow(app),
  });
  if (advanced.effect.type === "confirmed") {
    await persistConfirmedLogin(app, advanced.session);
    return json(publicLogin(advanced.session));
  }
  if (advanced.effect.type === "already_connected") {
    await app.storage.delete(KEYS.login);
    const existing = await readSession(app.storage);
    if (existing) await app.onLoggedIn?.();
    return json(publicLogin(advanced.session));
  }
  await writeJson(app.storage, KEYS.login, advanced.session);
  return json(publicLogin(advanced.session));
}

async function loginVerify(request: Request, app: BridgeApp): Promise<Response> {
  const body = await readJsonBody(request);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(code)) return json({ ok: false, error: "bad_request" }, 400);
  const current = await readLogin(app);
  if (!current) return json({ ok: false, error: "no_login" }, 404);
  current.pendingVerifyCode = code;
  current.phase = "need_verifycode";
  await writeJson(app.storage, KEYS.login, current);
  return json({ ok: true });
}

async function adminSession(request: Request, app: BridgeApp): Promise<Response> {
  const body = await readJsonBody(request);
  const botToken = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
  const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!botToken || !isPeerId(accountId) || (userId && !isPeerId(userId))) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  await persistConfirmedLogin(app, {
    qrcode: "",
    qrcodeUrl: "",
    startedAt: appNow(app),
    apiBaseUrl: app.config.ilinkApiBase,
    refreshCount: 1,
    phase: "confirmed",
    message: "Session imported",
    botToken,
    accountId,
    ...(baseUrl ? { accountBaseUrl: baseUrl } : {}),
    ...(userId ? { userId } : {}),
  });
  return json({ ok: true, account_id: accountId });
}

async function adminAllowlist(request: Request, app: BridgeApp): Promise<Response> {
  const body = await readJsonBody(request);
  if (!Array.isArray(body.allow_from) || body.allow_from.length > 20) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const ids: string[] = [];
  for (const item of body.allow_from) {
    if (typeof item !== "string" || !isPeerId(item)) return json({ ok: false, error: "bad_request" }, 400);
    ids.push(item);
  }
  await writeAllowlist(app.storage, ids);
  return json({ ok: true, allowlist_count: ids.length });
}

/**
 * Send a text message. `to` may be omitted when the allowlist has exactly one
 * id. That stored id is used as pinned; it is not run through `isPeerId`.
 * The response does not echo it. An explicit `to` that is not allowlisted
 * must still match `isPeerId` or the request is rejected.
 */
async function send(request: Request, app: BridgeApp): Promise<Response> {
  const body = await readJsonBody(request);
  const requestedTo = typeof body.to === "string" ? body.to.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  const contextToken = typeof body.context_token === "string" ? body.context_token : undefined;
  const account = typeof body.account === "string" ? body.account.trim() : undefined;
  if (text.trim().length === 0 || text.length > SEND_TEXT_MAX) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (contextToken !== undefined && (contextToken.length === 0 || contextToken.length > 4096)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  // Pinning stores from_user_id with no alphabet check. Re-checking that id
  // here turned a one-entry allowlist into bad_request instead of a send.
  const allow = await readAllowlist(app.storage);
  let to = requestedTo;
  if (!to) {
    if (allow.length !== 1) return json({ ok: false, error: "recipient_required" }, 400);
    const only = allow[0];
    if (!only) return json({ ok: false, error: "recipient_required" }, 400);
    to = only;
  } else if (!allow.includes(to) && !isPeerId(to)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const session = await readSession(app.storage);
  if (!session) return json({ ok: false, error: "not_logged_in" }, 409);
  if (account && account !== session.accountId) return json({ ok: false, error: "not_allowlisted" }, 403);
  if (!allow.includes(to)) return json({ ok: false, error: "not_allowlisted" }, 403);
  const allowed = await takeSendSlot(app.storage, app.config.rateLimitPerMinute, appNow(app));
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);
  const result = await sendBridgeText(app, {
    to,
    text,
    ...(contextToken ? { contextToken } : {}),
    ...(account ? { accountId: account } : {}),
  });
  if (!result.ok) {
    const status = result.error === "not_allowlisted" ? 403 : result.error === "not_logged_in" ? 409 : result.error === "context_token_rejected" ? 409 : 502;
    return json({ ok: false, error: result.error }, status);
  }
  return json({
    ok: true,
    client_id: result.clientId,
    ...(result.messageId ? { message_id: result.messageId } : {}),
    context_token_missing: result.contextTokenMissing,
  });
}

function publicLogin(session: QrLoginSession): Record<string, unknown> {
  const showQr = session.phase !== "confirmed" && session.phase !== "failed" && session.qrcodeUrl.length > 0;
  return {
    ok: true,
    phase: session.phase,
    message: session.message,
    qrcode_url: showQr ? session.qrcodeUrl : null,
    qr_svg: showQr ? qrSvg(session.qrcodeUrl) : null,
    account_id: session.accountId ?? null,
    user_id: session.userId ?? null,
    already_connected: session.alreadyConnected === true,
  };
}

async function readLogin(app: BridgeApp): Promise<QrLoginSession | null> {
  const value = await readJson<unknown>(app.storage, KEYS.login, null);
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<QrLoginSession>;
  if (typeof row.qrcode !== "string" || typeof row.qrcodeUrl !== "string") return null;
  if (typeof row.startedAt !== "number" || typeof row.apiBaseUrl !== "string") return null;
  if (typeof row.refreshCount !== "number" || typeof row.phase !== "string" || typeof row.message !== "string") {
    return null;
  }
  return row as QrLoginSession;
}

async function readProof(request: Request): Promise<string | null> {
  const type = request.headers.get("Content-Type") ?? "";
  const raw = await readLimited(request);
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      return typeof parsed.token === "string" ? parsed.token : null;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(raw).get("token");
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await readLimited(request);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "bad_request");
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_request");
  }
}

async function readLimited(request: Request): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > BODY_MAX_BYTES) throw new HttpError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > BODY_MAX_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(step.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `gb_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=43200",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function html(body: string, status: number, secure: boolean): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}
