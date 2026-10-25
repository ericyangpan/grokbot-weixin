import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
import { logWarn, publicError } from "./log.js";
import type { HistoryMedia, HistoryQuote, HistoryTurn, InboundEvent, MediaInfo } from "./types.js";

/** Limits applied when a transcript is read or written. */
export interface HistoryLimits {
  maxTurns: number;
  maxChars: number;
  ttlMs: number;
}

const RESET_RE = /^\/(?:new|reset)$/i;

const tails = new Map<string, Promise<void>>();

/**
 * True when the message is only the reset command. Voice transcripts and
 * captions on attachments are left for the routine.
 */
export function isHistoryReset(event: InboundEvent): boolean {
  return event.type === "text" && event.media.length === 0 && event.quote === null && RESET_RE.test(event.text.trim());
}

/**
 * Keep the newest turns that fit the count, the character budget, and the age window.
 * A single turn that is still too long has its text shortened.
 */
export function boundHistory(turns: HistoryTurn[], now: number, limits: HistoryLimits): HistoryTurn[] {
  if (limits.maxTurns <= 0 || limits.maxChars <= 0) return [];
  const minAt = now - limits.ttlMs;
  let kept = turns.filter((turn) => turn.at_ms >= minAt);
  if (kept.length > limits.maxTurns) kept = kept.slice(kept.length - limits.maxTurns);
  while (kept.length > 1 && weight(kept) > limits.maxChars) kept.shift();
  const only = kept[0];
  if (kept.length === 1 && only && weight(kept) > limits.maxChars) {
    const extra = weight(kept) - only.text.length;
    const room = Math.max(0, limits.maxChars - extra);
    kept = [{ ...only, text: only.text.slice(0, room) }];
  }
  return kept;
}

/**
 * Prior turns for this peer, oldest first, then store this inbound message.
 * The returned array does not include `event`. Storage errors are logged.
 * A failed read does not overwrite the stored transcript.
 */
export async function rememberInbound(app: BridgeApp, peerId: string, event: InboundEvent): Promise<HistoryTurn[]> {
  try {
    return await withPeerLock(peerId, async () => {
      const limits = limitsFrom(app);
      const now = appNow(app);
      const prior = await readOrKeep(app, peerId, now, limits);
      if (prior === null) return [];
      const visible = prior.filter((turn) => !(turn.role === "user" && turn.message_id === event.message_id));
      const turn = turnFromEvent(event, now);
      await writeOrLog(app, peerId, [...visible, turn], now, limits);
      return visible;
    });
  } catch (err) {
    logWarn("history_read_failed", { error: publicError(err) });
    return [];
  }
}

/**
 * Record one successful outbound text. Never throws: the send already
 * happened, and a history error must not be reported as a failed send.
 * A failed read does not overwrite the stored transcript.
 */
export async function rememberOutbound(
  app: BridgeApp,
  peerId: string,
  input: { text: string; messageId: string; atMs: number },
): Promise<void> {
  try {
    await withPeerLock(peerId, async () => {
      const limits = limitsFrom(app);
      const now = appNow(app);
      const prior = await readOrKeep(app, peerId, now, limits);
      if (prior === null) return;
      const turn: HistoryTurn = {
        role: "assistant",
        text: input.text,
        type: "text",
        media: [],
        quote: null,
        at_ms: input.atMs,
        message_id: input.messageId,
      };
      const withoutDuplicate = prior.filter((item) => !(item.role === "assistant" && item.message_id === input.messageId));
      await writeOrLog(app, peerId, [...withoutDuplicate, turn], now, limits);
    });
  } catch (err) {
    logWarn("history_write_failed", { error: publicError(err) });
  }
}

/**
 * Read the bounded transcript for one peer. Null means storage could not be read.
 * Does not write, so a viewer cannot erase history.
 */
export async function loadPeerHistory(app: BridgeApp, peerId: string): Promise<HistoryTurn[] | null> {
  try {
    return await withPeerLock(peerId, () => readOrKeep(app, peerId, appNow(app), limitsFrom(app)));
  } catch (err) {
    logWarn("history_read_failed", { error: publicError(err) });
    return null;
  }
}

/** Delete the stored transcript for one peer. Storage errors are logged. */
export async function clearPeerHistory(app: BridgeApp, peerId: string): Promise<void> {
  try {
    await withPeerLock(peerId, async () => {
      await app.storage.delete(await historyStorageKey(peerId));
    });
  } catch (err) {
    logWarn("history_write_failed", { error: publicError(err) });
  }
}

/** Storage key for a peer. Hashed so ids with `@` or spaces stay valid file names. */
export async function historyStorageKey(peerId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(peerId));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return `h_${hex.slice(0, 40)}`;
}

function limitsFrom(app: BridgeApp): HistoryLimits {
  return {
    maxTurns: app.config.historyMaxTurns,
    maxChars: app.config.historyMaxChars,
    ttlMs: app.config.historyTtlMs,
  };
}

function turnFromEvent(event: InboundEvent, now: number): HistoryTurn {
  const at = typeof event.timestamp_ms === "number" && event.timestamp_ms > 0 ? event.timestamp_ms : now;
  return {
    role: "user",
    text: event.text,
    type: event.type,
    media: event.media.map(summarizeMedia),
    quote: summarizeQuote(event),
    at_ms: at,
    message_id: event.message_id,
  };
}

function summarizeQuote(event: InboundEvent): HistoryQuote | null {
  const quote = event.quote;
  if (!quote) return null;
  return {
    title: quote.title,
    text: quote.text,
    message_id: quote.message_id,
    media: quote.media.map(summarizeMedia),
  };
}

function summarizeMedia(item: MediaInfo): HistoryMedia {
  const id = mediaIdFromStoredUrl(item.url);
  const mime = storedMime(item.mime_type);
  return {
    kind: item.kind,
    file_name: item.file_name,
    transcript: item.transcript,
    ...(id ? { id } : {}),
    ...(mime ? { mime_type: mime } : {}),
  };
}

/** Pull a stored object id out of a bridge media URL. Other URLs are ignored. */
function mediaIdFromStoredUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const match = /^\/media\/([0-9a-f]{32})$/.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function storedMime(value: string | null): string | null {
  if (!value || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value) || value.length > 80) return null;
  return value.toLowerCase();
}

/**
 * Stored turns, or null when the read itself failed. Null means the caller
 * must not write, so a transient storage error cannot replace a good transcript.
 */
async function readOrKeep(
  app: BridgeApp,
  peerId: string,
  now: number,
  limits: HistoryLimits,
): Promise<HistoryTurn[] | null> {
  try {
    return await readTurns(app, peerId, now, limits);
  } catch (err) {
    logWarn("history_read_failed", { error: publicError(err) });
    return null;
  }
}

/** Write turns. Logs and swallows storage errors. */
async function writeOrLog(
  app: BridgeApp,
  peerId: string,
  turns: HistoryTurn[],
  now: number,
  limits: HistoryLimits,
): Promise<void> {
  try {
    await writeTurns(app, peerId, turns, now, limits);
  } catch (err) {
    logWarn("history_write_failed", { error: publicError(err) });
  }
}

async function readTurns(app: BridgeApp, peerId: string, now: number, limits: HistoryLimits): Promise<HistoryTurn[]> {
  if (limits.maxTurns <= 0 || limits.maxChars <= 0) return [];
  const raw = await app.storage.get(await historyStorageKey(peerId));
  if (!raw) return [];
  try {
    return boundHistory(parseTurns(JSON.parse(raw)), now, limits);
  } catch {
    return [];
  }
}

async function writeTurns(
  app: BridgeApp,
  peerId: string,
  turns: HistoryTurn[],
  now: number,
  limits: HistoryLimits,
): Promise<void> {
  const key = await historyStorageKey(peerId);
  const bounded = boundHistory(turns, now, limits);
  if (bounded.length === 0) {
    await app.storage.delete(key);
    return;
  }
  await app.storage.set(key, JSON.stringify(bounded));
}

function parseTurns(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: HistoryTurn[] = [];
  for (const item of value) {
    const turn = parseTurn(item);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseTurn(value: unknown): HistoryTurn | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const role = record.role === "user" || record.role === "assistant" ? record.role : null;
  const type = typeof record.type === "string" ? record.type : "";
  const text = typeof record.text === "string" ? record.text : null;
  const at = typeof record.at_ms === "number" && Number.isFinite(record.at_ms) ? record.at_ms : null;
  const messageId = typeof record.message_id === "string" && record.message_id.length > 0 ? record.message_id : null;
  if (!role || text === null || at === null || !messageId || !isInboundType(type)) return null;
  return {
    role,
    text,
    type,
    media: parseMediaList(record.media),
    quote: parseQuote(record.quote),
    at_ms: at,
    message_id: messageId,
  };
}

function parseQuote(value: unknown): HistoryQuote | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : null,
    text: typeof record.text === "string" ? record.text : null,
    message_id: typeof record.message_id === "string" ? record.message_id : null,
    media: parseMediaList(record.media),
  };
}

function parseMediaList(value: unknown): HistoryMedia[] {
  if (!Array.isArray(value)) return [];
  const media: HistoryMedia[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== "image" && kind !== "voice" && kind !== "file" && kind !== "video") continue;
    const id = typeof record.id === "string" && /^[0-9a-f]{32}$/.test(record.id) ? record.id : null;
    const mime = storedMime(typeof record.mime_type === "string" ? record.mime_type : null);
    media.push({
      kind,
      file_name: typeof record.file_name === "string" ? record.file_name : null,
      transcript: typeof record.transcript === "string" ? record.transcript : null,
      ...(id ? { id } : {}),
      ...(mime ? { mime_type: mime } : {}),
    });
  }
  return media;
}

function isInboundType(value: string): value is HistoryTurn["type"] {
  return value === "text" || value === "image" || value === "voice" || value === "file" || value === "video" || value === "mixed" || value === "unknown";
}

function weight(turns: HistoryTurn[]): number {
  let total = 0;
  for (const turn of turns) total += turnWeight(turn);
  return total;
}

function turnWeight(turn: HistoryTurn): number {
  let total = turn.text.length;
  for (const item of turn.media) total += mediaWeight(item);
  if (turn.quote) {
    total += turn.quote.title?.length ?? 0;
    total += turn.quote.text?.length ?? 0;
    for (const item of turn.quote.media) total += mediaWeight(item);
  }
  return total;
}

function mediaWeight(item: HistoryMedia): number {
  return item.kind.length + (item.file_name?.length ?? 0) + (item.transcript?.length ?? 0) + (item.id?.length ?? 0) + (item.mime_type?.length ?? 0);
}

/**
 * Run one history update at a time per peer. The poll loop and POST /send
 * share an isolate, and a reply must be stored after the user turn it answers.
 */
async function withPeerLock<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(peerId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(peerId, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(peerId) === gate) tails.delete(peerId);
  }
}
