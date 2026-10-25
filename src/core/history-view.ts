import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
import { timingSafeEqual } from "./auth.js";
import { MAX_HISTORY_VIEW_GRANTS } from "./constants.js";
import { loadPeerHistory } from "./history.js";
import { KEYS } from "./keys.js";
import { logInfo, logWarn } from "./log.js";
import { readJson, writeJson } from "./storage.js";
import type { HistoryMedia, HistoryQuote, HistoryTurn } from "./types.js";

/** Cookie set when a view link is minted or redeemed. Not the bridge token. */
export const HISTORY_COOKIE = "gb_hist";

const CODE_RE = /^[0-9a-f]{64}$/;

interface ViewGrant {
  peer: string;
  expires_at_ms: number;
}

interface ViewBook {
  codes: Record<string, ViewGrant>;
  sessions: Record<string, ViewGrant>;
}

export interface MintedHistoryView {
  code: string;
  sessionSecret: string;
  expiresAtMs: number;
}

const tails = new Map<string, Promise<void>>();

/**
 * Create a one-shot code and a matching cookie secret for one allowlisted peer.
 * Both die at the same absolute time. The raw values are not stored or logged.
 */
export async function mintHistoryView(app: BridgeApp, peer: string): Promise<MintedHistoryView> {
  const code = randomHex(32);
  const sessionSecret = randomHex(32);
  const expiresAtMs = appNow(app) + app.config.historyViewTtlMs;
  const codeHash = await sha256Hex(code);
  const sessionHash = await sha256Hex(sessionSecret);
  await withViewLock(async () => {
    const book = await loadBook(app);
    prune(book, appNow(app));
    book.codes[codeHash] = { peer, expires_at_ms: expiresAtMs };
    book.sessions[sessionHash] = { peer, expires_at_ms: expiresAtMs };
    cap(book.codes);
    cap(book.sessions);
    await writeJson(app.storage, KEYS.historyViews, book);
  });
  logInfo("history_view_minted", { expires_at_ms: expiresAtMs });
  return { code, sessionSecret, expiresAtMs };
}

/**
 * Spend a one-shot code. Returns the cookie secret and the original expiry,
 * or null when the code is unknown, expired, or already used.
 */
export async function redeemHistoryCode(app: BridgeApp, code: string): Promise<MintedHistoryView | null> {
  if (!CODE_RE.test(code)) return null;
  if (await timingSafeEqual(code, app.config.bridgeToken)) {
    logWarn("history_view_rejected");
    return null;
  }
  const codeHash = await sha256Hex(code);
  const now = appNow(app);
  const redeemed = await withViewLock(async () => {
    const book = await loadBook(app);
    prune(book, now);
    const grant = book.codes[codeHash];
    delete book.codes[codeHash];
    if (!grant || grant.expires_at_ms <= now) {
      await writeJson(app.storage, KEYS.historyViews, book);
      return null;
    }
    const sessionSecret = randomHex(32);
    book.sessions[await sha256Hex(sessionSecret)] = grant;
    cap(book.sessions);
    await writeJson(app.storage, KEYS.historyViews, book);
    return { code: "", sessionSecret, expiresAtMs: grant.expires_at_ms };
  });
  if (!redeemed) {
    logWarn("history_view_rejected");
    return null;
  }
  logInfo("history_view_redeemed", { expires_at_ms: redeemed.expiresAtMs });
  return redeemed;
}

/**
 * Peer and expiry bound to a view cookie, or null when the cookie is missing, forged, or expired.
 * The bridge bearer token is never a valid view cookie.
 */
export async function peerForHistoryCookie(
  app: BridgeApp,
  secret: string | null,
): Promise<{ peer: string; expiresAtMs: number } | null> {
  if (!secret || !CODE_RE.test(secret)) return null;
  if (await timingSafeEqual(secret, app.config.bridgeToken)) return null;
  const now = appNow(app);
  const grant = prune(await loadBook(app), now).sessions[await sha256Hex(secret)];
  if (!grant || grant.expires_at_ms <= now) return null;
  return { peer: grant.peer, expiresAtMs: grant.expires_at_ms };
}

/** Drop expired grants. Called from the page path so a dead cookie cannot linger. */
export async function sweepHistoryViews(app: BridgeApp): Promise<void> {
  await withViewLock(async () => {
    const book = await loadBook(app);
    const before = JSON.stringify(book);
    prune(book, appNow(app));
    if (JSON.stringify(book) !== before) await writeJson(app.storage, KEYS.historyViews, book);
  });
}

/** HTML transcript for one peer. Oldest first. Media URLs are not rendered. */
export async function renderHistoryDocument(app: BridgeApp, peer: string, expiresAtMs: number): Promise<string> {
  const turns = await loadPeerHistory(app, peer);
  return renderPage(peer, expiresAtMs, turns);
}

/** Short page used for a missing or expired view. Contains no transcript. */
export function renderHistoryDenied(): string {
  return document("Link expired", "<h1>Link expired</h1><p>Open a new history link.</p>");
}

/** Build the Set-Cookie header for a view session. Secure only on HTTPS. */
export function historySessionCookie(secret: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${HISTORY_COOKIE}=${encodeURIComponent(secret)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/history",
    `Max-Age=${Math.max(1, maxAgeSec)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Hide one-shot codes and media ids before a path is written to a log. */
export function redactRequestPath(path: string): string {
  return path
    .replace(/^\/history\/r\/[0-9a-f]{64}$/, "/history/r/:code")
    .replace(/^\/media\/[0-9a-f]{32}$/, "/media/:id");
}

function renderPage(peer: string, expiresAtMs: number, turns: HistoryTurn[] | null): string {
  const when = new Date(expiresAtMs).toISOString();
  const body = [
    "<h1>Conversation</h1>",
    `<p class="meta">Oldest first. Expires ${escapeHtml(when)}. Peer ${escapeHtml(peer)}.</p>`,
  ];
  if (turns === null) {
    body.push("<p>History could not be loaded.</p>");
  } else if (turns.length === 0) {
    body.push("<p>No messages in this window.</p>");
  } else {
    const ordered = turns
      .map((turn, index) => ({ turn, index }))
      .sort((left, right) => left.turn.at_ms - right.turn.at_ms || left.index - right.index);
    for (const item of ordered) body.push(renderTurn(item.turn));
  }
  return document("Conversation", body.join(""));
}

function renderTurn(turn: HistoryTurn): string {
  const who = turn.role === "assistant" ? "Assistant" : "You";
  const at = Number.isFinite(turn.at_ms) ? new Date(turn.at_ms).toISOString() : "";
  const bits = [
    `<article class="${turn.role === "assistant" ? "assistant" : "user"}">`,
    `<div class="who">${who} <span class="when">${escapeHtml(at)}</span></div>`,
    `<div class="text">${escapeHtml(turn.text)}</div>`,
    renderMedia(turn.media),
    renderQuote(turn.quote),
    "</article>",
  ];
  return bits.filter((part) => part.length > 0).join("");
}

function renderMedia(media: HistoryMedia[]): string {
  if (media.length === 0) return "";
  const lines = media.map((item) => {
    const name = item.file_name ? ` · ${item.file_name}` : "";
    const transcript = item.transcript ? `<div>Transcript: ${escapeHtml(item.transcript)}</div>` : "";
    return `<div>${escapeHtml(item.kind + name)}</div>${transcript}`;
  });
  return `<div class="media">${lines.join("")}</div>`;
}

function renderQuote(quote: HistoryQuote | null): string {
  if (!quote) return "";
  const title = quote.title ? `<div>${escapeHtml(quote.title)}</div>` : "";
  const text = quote.text ? `<div>${escapeHtml(quote.text)}</div>` : "";
  return `<div class="quote"><div class="who">Quoted</div>${title}${text}${renderMedia(quote.media)}</div>`;
}

function document(title: string, main: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.45 system-ui,sans-serif}",
    "main{max-width:40rem;margin:0 auto;padding:1rem}",
    "h1{font-size:1.15rem;margin:0 0 .4rem}",
    ".meta{color:#52525b;font-size:.85rem}",
    "article{margin:.7rem 0;padding:.75rem .85rem;border-radius:.8rem;background:#fff}",
    "article.assistant{background:#e7f0ea}",
    ".who{font-size:.75rem;font-weight:650}",
    ".when{color:#71717a;font-weight:400}",
    ".text{white-space:pre-wrap;word-break:break-word}",
    ".media,.quote{margin-top:.45rem;font-size:.9rem;color:#3f3f46}",
    "</style></head><body><main>",
    main,
    "</main></body></html>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadBook(app: BridgeApp): Promise<ViewBook> {
  return parseBook(await readJson<unknown>(app.storage, KEYS.historyViews, null));
}

function parseBook(value: unknown): ViewBook {
  const book: ViewBook = { codes: {}, sessions: {} };
  if (!value || typeof value !== "object") return book;
  const raw = value as { codes?: unknown; sessions?: unknown };
  book.codes = parseGrants(raw.codes);
  book.sessions = parseGrants(raw.sessions);
  return book;
}

function parseGrants(value: unknown): Record<string, ViewGrant> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, ViewGrant> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CODE_RE.test(key) || !item || typeof item !== "object") continue;
    const row = item as { peer?: unknown; expires_at_ms?: unknown };
    if (typeof row.peer !== "string" || row.peer.length === 0 || row.peer.length > 200) continue;
    if (typeof row.expires_at_ms !== "number" || !Number.isFinite(row.expires_at_ms)) continue;
    out[key] = { peer: row.peer, expires_at_ms: row.expires_at_ms };
  }
  return out;
}

function prune(book: ViewBook, now: number): ViewBook {
  for (const [key, grant] of Object.entries(book.codes)) {
    if (grant.expires_at_ms <= now) delete book.codes[key];
  }
  for (const [key, grant] of Object.entries(book.sessions)) {
    if (grant.expires_at_ms <= now) delete book.sessions[key];
  }
  return book;
}

function cap(grants: Record<string, ViewGrant>): void {
  const entries = Object.entries(grants);
  if (entries.length <= MAX_HISTORY_VIEW_GRANTS) return;
  entries.sort((left, right) => left[1].expires_at_ms - right[1].expires_at_ms);
  for (const [key] of entries.slice(0, entries.length - MAX_HISTORY_VIEW_GRANTS)) delete grants[key];
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let hex = "";
  for (const byte of buffer) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function withViewLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tails.get("view") ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set("view", gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get("view") === gate) tails.delete("view");
  }
}
