import { DEDUPE_LIMIT, RATE_WINDOW_MS } from "./constants.js";
import { KEYS } from "./keys.js";
import { readJson, writeJson, type BridgeStorage } from "./storage.js";

/** Persisted iLink login. The bot token is the only credential. */
export interface StoredSession {
  botToken: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
  savedAt: number;
}

export interface TypingTicket {
  ticket: string;
  fetchedAt: number;
}

export interface RateWindow {
  windowStart: number;
  count: number;
}

/** Load the account session, or null when it is missing or incomplete. */
export async function readSession(storage: BridgeStorage): Promise<StoredSession | null> {
  const value = await readJson<unknown>(storage, KEYS.session, null);
  if (!isRecord(value)) return null;
  const botToken = asString(value.botToken);
  const accountId = asString(value.accountId);
  if (!botToken || !accountId) return null;
  const baseUrl = asString(value.baseUrl);
  const userId = asString(value.userId);
  const savedAt = typeof value.savedAt === "number" ? value.savedAt : 0;
  return {
    botToken,
    accountId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
    savedAt,
  };
}

/** Replace the stored account session. */
export async function writeSession(storage: BridgeStorage, session: StoredSession): Promise<void> {
  await writeJson(storage, KEYS.session, session);
}

/** Load the sender allowlist. Corrupt data becomes an empty list. */
export async function readAllowlist(storage: BridgeStorage): Promise<string[]> {
  const value = await readJson<unknown>(storage, KEYS.allowlist, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Replace the sender allowlist. */
export async function writeAllowlist(storage: BridgeStorage, ids: string[]): Promise<void> {
  await writeJson(storage, KEYS.allowlist, ids);
}

/** Load recent message ids used to drop redeliveries. */
export async function readDedupe(storage: BridgeStorage): Promise<string[]> {
  const value = await readJson<unknown>(storage, KEYS.dedupe, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Replace the recent message-id ring. */
export async function writeDedupe(storage: BridgeStorage, ids: string[]): Promise<void> {
  await writeJson(storage, KEYS.dedupe, ids);
}

/** Remember a message id. Returns whether it was already present. */
export function rememberId(
  seen: string[],
  id: string,
  limit = DEDUPE_LIMIT,
): { seen: string[]; duplicate: boolean } {
  if (seen.includes(id)) return { seen, duplicate: true };
  const next = seen.length >= limit ? seen.slice(seen.length - limit + 1) : seen.slice();
  next.push(id);
  return { seen: next, duplicate: false };
}

/** Load per-peer context tokens. Keys are sender ids. */
export async function readContextTokens(storage: BridgeStorage): Promise<Record<string, string>> {
  const value = await readJson<unknown>(storage, KEYS.contextTokens, {});
  if (!isRecord(value)) return {};
  const tokens: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.length > 0) tokens[key] = item;
  }
  return tokens;
}

/** Replace the context-token map. */
export async function writeContextTokens(
  storage: BridgeStorage,
  tokens: Record<string, string>,
): Promise<void> {
  await writeJson(storage, KEYS.contextTokens, tokens);
}

/** Load cached typing tickets. */
export async function readTypingTickets(storage: BridgeStorage): Promise<Record<string, TypingTicket>> {
  const value = await readJson<unknown>(storage, KEYS.typingTickets, {});
  if (!isRecord(value)) return {};
  const tickets: Record<string, TypingTicket> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    if (typeof item.ticket !== "string" || typeof item.fetchedAt !== "number") continue;
    tickets[key] = { ticket: item.ticket, fetchedAt: item.fetchedAt };
  }
  return tickets;
}

/** Replace the typing-ticket cache. */
export async function writeTypingTickets(
  storage: BridgeStorage,
  tickets: Record<string, TypingTicket>,
): Promise<void> {
  await writeJson(storage, KEYS.typingTickets, tickets);
}

/**
 * Consume one slot from the send rate window.
 * Returns false when the caller should be rejected.
 */
export async function takeSendSlot(
  storage: BridgeStorage,
  limit: number,
  now: number,
): Promise<boolean> {
  const value = await readJson<unknown>(storage, KEYS.rateSend, null);
  let windowStart = now;
  let count = 0;
  if (isRecord(value) && typeof value.windowStart === "number" && typeof value.count === "number") {
    if (now - value.windowStart < RATE_WINDOW_MS) {
      windowStart = value.windowStart;
      count = value.count;
    }
  }
  if (count >= limit) return false;
  const next: RateWindow = { windowStart, count: count + 1 };
  await writeJson(storage, KEYS.rateSend, next);
  return true;
}

/** Bot tokens already stored locally, capped the way the upstream QR request is. */
export async function localBotTokens(storage: BridgeStorage): Promise<string[]> {
  const session = await readSession(storage);
  return session ? [session.botToken] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
