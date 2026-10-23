import type { BridgeApp } from "./app.js";
import { appFetch, appNow, appSleep } from "./app.js";
import {
  HISTORY_RESET_ACK,
  MAX_LONG_POLL_MS,
  MESSAGE_TYPE_BOT,
  MIN_LONG_POLL_MS,
  SESSION_PAUSE_MS,
  STALE_TOKEN_ERRCODE,
  TYPING_TICKET_TTL_MS,
} from "./constants.js";
import { clearPeerHistory, isHistoryReset, rememberInbound } from "./history.js";
import { KEYS } from "./keys.js";
import { logError, logInfo, logWarn, publicError } from "./log.js";
import { isForwardable, messageDedupeId, normalizeInbound } from "./normalize.js";
import { resolveInboundMedia, sweepMedia } from "./media.js";
import {
  readAllowlist,
  readContextTokens,
  readDedupe,
  readSession,
  readTypingTickets,
  rememberId,
  writeAllowlist,
  writeContextTokens,
  writeDedupe,
  writeTypingTickets,
  type StoredSession,
} from "./state.js";
import { sendBridgeText } from "./send.js";
import type { GetUpdatesResp, WeixinMessage } from "./types.js";
import { postWebhook } from "./webhook.js";

export interface PollStepOutcome {
  /** Delay before the next poll. The long poll itself already waited. */
  nextDelayMs: number;
  /** False when there is no session, so the Worker should not arm another alarm. */
  schedule: boolean;
  polled: boolean;
}

/**
 * One getUpdates round: persist the cursor, dedupe, forward allowlisted DMs,
 * and optionally send a typing indicator. A single bad message cannot throw
 * out of this function.
 */
export async function runPollStep(app: BridgeApp): Promise<PollStepOutcome> {
  const session = await readSession(app.storage);
  if (!session) return { nextDelayMs: 5_000, schedule: false, polled: false };
  const now = appNow(app);
  const pausedFor = await pauseRemaining(app, now);
  if (pausedFor > 0) return { nextDelayMs: pausedFor, schedule: true, polled: false };

  const baseUrl = session.baseUrl || app.config.ilinkApiBase;
  await notifyOnce(app, session, baseUrl);
  const cursor = (await app.storage.get(KEYS.cursor)) ?? "";
  const timeoutMs = await nextTimeout(app);
  const started = appNow(app);

  let response: GetUpdatesResp;
  try {
    response = await app.client.getUpdates({
      baseUrl,
      token: session.botToken,
      cursor,
      timeoutMs,
    });
  } catch (err) {
    const delay = await failureDelay(app);
    logError("getupdates_failed", { error: publicError(err) });
    return { nextDelayMs: delay, schedule: true, polled: true };
  }

  if (isApiError(response)) {
    if (response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE) {
      const until = now + SESSION_PAUSE_MS;
      await app.storage.set(KEYS.pauseUntil, String(until));
      await app.storage.set(KEYS.pollFailures, "0");
      logError("session_paused", { account_id: session.accountId, until });
      return { nextDelayMs: SESSION_PAUSE_MS, schedule: true, polled: true };
    }
    const delay = await failureDelay(app);
    logError("getupdates_rejected", {
      ret: response.ret ?? null,
      errcode: response.errcode ?? null,
    });
    return { nextDelayMs: delay, schedule: true, polled: true };
  }

  const failureFlag = await app.storage.get(KEYS.pollFailures);
  if (failureFlag && failureFlag !== "0") await app.storage.set(KEYS.pollFailures, "0");
  await rememberServerTimeout(app, response.longpolling_timeout_ms, timeoutMs);
  await sweepMedia(app);
  await dispatchMessages(app, session, response.msgs ?? []);
  const nextCursor = response.get_updates_buf;
  if (nextCursor && nextCursor !== cursor) await app.storage.set(KEYS.cursor, nextCursor);
  // A real long poll already waited inside getUpdates. If the API returns an
  // empty batch immediately, wait out the poll window before the next call so
  // a Worker alarm loop stays inside the Free plan request quota.
  const elapsed = Math.max(0, appNow(app) - started);
  const idle = (response.msgs ?? []).length === 0;
  const nextDelayMs = idle && elapsed < 1_000 ? timeoutMs : 250;
  return { nextDelayMs, schedule: true, polled: true };
}

async function dispatchMessages(app: BridgeApp, session: StoredSession, messages: WeixinMessage[]): Promise<void> {
  let seen = await readDedupe(app.storage);
  let seenChanged = false;
  let allow = await syncAllowlist(app);
  let allowChanged = false;
  let tokens = await readContextTokens(app.storage);
  let tokensChanged = false;

  for (const msg of messages) {
    try {
      const outcome = await handleMessage(app, session, msg, allow, seen, tokens);
      if (outcome.seen !== seen) {
        seen = outcome.seen;
        seenChanged = true;
      }
      if (outcome.allow) {
        allow = outcome.allow;
        allowChanged = true;
      }
      if (outcome.tokens) {
        tokens = outcome.tokens;
        tokensChanged = true;
      }
    } catch (err) {
      logError("inbound_failed", {
        message_id: msg.message_id ?? null,
        error: publicError(err),
      });
    }
  }

  if (allowChanged) await writeAllowlist(app.storage, allow);
  if (tokensChanged) await writeContextTokens(app.storage, tokens);
  if (seenChanged) await writeDedupe(app.storage, seen);
}

async function handleMessage(
  app: BridgeApp,
  session: StoredSession,
  msg: WeixinMessage,
  allow: string[],
  seen: string[],
  tokens: Record<string, string>,
): Promise<{ seen: string[]; allow?: string[]; tokens?: Record<string, string> }> {
  const sender = msg.from_user_id ?? "";
  if (msg.group_id) {
    logInfo("ignored_group", { sender: sender || null });
    return { seen };
  }
  if (msg.message_type === MESSAGE_TYPE_BOT || (sender && sender === session.accountId)) {
    return { seen };
  }
  const id = messageDedupeId(msg);
  let nextSeen = seen;
  if (id) {
    const remembered = rememberId(seen, id);
    if (remembered.duplicate) return { seen };
    nextSeen = remembered.seen;
  }
  let nextAllow = allow;
  if (sender && nextAllow.length === 0 && app.config.pinFirstSender && app.config.allowFrom.length === 0) {
    nextAllow = [sender];
    logInfo("pinned_sender", { sender });
  }
  if (!sender || !nextAllow.includes(sender)) {
    logInfo("ignored_sender", { sender: sender || null });
    return { seen: nextSeen, ...(nextAllow !== allow ? { allow: nextAllow } : {}) };
  }
  let nextTokens = tokens;
  if (msg.context_token && tokens[sender] !== msg.context_token) {
    nextTokens = { ...tokens, [sender]: msg.context_token };
  }
  const built = normalizeInbound(msg, session.accountId, app.config.bridgePublicUrl);
  const event = await resolveInboundMedia(app, built);
  if (isForwardable(event)) {
    if (app.config.historyReset && isHistoryReset(event)) {
      await clearPeerHistory(app, sender);
      logInfo("history_reset", { sender });
      const ack = await sendBridgeText(app, {
        to: sender,
        text: HISTORY_RESET_ACK,
        ...(msg.context_token ? { contextToken: msg.context_token } : {}),
      });
      if (ack.ok) await clearPeerHistory(app, sender);
      return {
        seen: nextSeen,
        ...(nextAllow !== allow ? { allow: nextAllow } : {}),
        ...(nextTokens !== tokens ? { tokens: nextTokens } : {}),
      };
    }
    event.history = await rememberInbound(app, sender, event);
    const result = await postWebhook(
      {
        url: app.config.webhookUrl,
        key: app.config.webhookKey,
        headerName: app.config.webhookHeader,
        scheme: app.config.webhookScheme,
        maxAttempts: app.config.webhookMaxAttempts,
      },
      event,
      appFetch(app),
      appSleep(app),
    );
    logInfo("inbound_forwarded", {
      sender,
      message_id: event.message_id,
      type: event.type,
      ok: result.ok,
      status: result.status ?? null,
    });
    if (result.ok && app.config.sendTyping && msg.context_token) {
      await sendTypingBestEffort(app, session, sender, msg.context_token);
    }
  }
  return {
    seen: nextSeen,
    ...(nextAllow !== allow ? { allow: nextAllow } : {}),
    ...(nextTokens !== tokens ? { tokens: nextTokens } : {}),
  };
}

async function sendTypingBestEffort(
  app: BridgeApp,
  session: StoredSession,
  userId: string,
  contextToken: string,
): Promise<void> {
  const baseUrl = session.baseUrl || app.config.ilinkApiBase;
  try {
    const tickets = await readTypingTickets(app.storage);
    const cached = tickets[userId];
    let ticket = cached && appNow(app) - cached.fetchedAt < TYPING_TICKET_TTL_MS ? cached.ticket : "";
    if (!ticket) {
      const config = await app.client.getConfig({
        baseUrl,
        token: session.botToken,
        userId,
        contextToken,
      });
      if (config.ret !== undefined && config.ret !== 0) return;
      if (!config.typing_ticket) return;
      ticket = config.typing_ticket;
      tickets[userId] = { ticket, fetchedAt: appNow(app) };
      await writeTypingTickets(app.storage, tickets);
    }
    await app.client.sendTyping({
      baseUrl,
      token: session.botToken,
      userId,
      typingTicket: ticket,
    });
  } catch (err) {
    logWarn("typing_failed", { sender: userId, error: publicError(err) });
    const tickets = await readTypingTickets(app.storage);
    if (tickets[userId]) {
      delete tickets[userId];
      await writeTypingTickets(app.storage, tickets);
    }
  }
}

async function syncAllowlist(app: BridgeApp): Promise<string[]> {
  if (app.config.allowFrom.length === 0) return readAllowlist(app.storage);
  const current = await readAllowlist(app.storage);
  if (!sameList(current, app.config.allowFrom)) await writeAllowlist(app.storage, app.config.allowFrom);
  return app.config.allowFrom;
}

async function notifyOnce(app: BridgeApp, session: StoredSession, baseUrl: string): Promise<void> {
  const flag = await app.storage.get(KEYS.notifyStarted);
  if (flag === session.accountId) return;
  try {
    await app.client.notifyStart({ baseUrl, token: session.botToken });
    await app.storage.set(KEYS.notifyStarted, session.accountId);
  } catch (err) {
    logWarn("notify_start_failed", { error: publicError(err) });
  }
}

async function pauseRemaining(app: BridgeApp, now: number): Promise<number> {
  const raw = await app.storage.get(KEYS.pauseUntil);
  if (!raw) return 0;
  const until = Number(raw);
  if (!Number.isFinite(until) || until <= now) {
    await app.storage.delete(KEYS.pauseUntil);
    return 0;
  }
  return Math.max(1_000, until - now);
}

async function nextTimeout(app: BridgeApp): Promise<number> {
  const raw = await app.storage.get(KEYS.nextTimeoutMs);
  const parsed = raw ? Number(raw) : app.config.longPollTimeoutMs;
  if (!Number.isFinite(parsed)) return app.config.longPollTimeoutMs;
  return clamp(parsed, MIN_LONG_POLL_MS, MAX_LONG_POLL_MS);
}

async function rememberServerTimeout(app: BridgeApp, suggested: number | undefined, current: number): Promise<void> {
  if (suggested === undefined || suggested <= 0) return;
  const next = clamp(suggested, MIN_LONG_POLL_MS, MAX_LONG_POLL_MS);
  if (next !== current) await app.storage.set(KEYS.nextTimeoutMs, String(next));
}

async function failureDelay(app: BridgeApp): Promise<number> {
  const raw = await app.storage.get(KEYS.pollFailures);
  const failures = (Number(raw ?? "0") || 0) + 1;
  if (failures >= 3) {
    await app.storage.set(KEYS.pollFailures, "0");
    return 30_000;
  }
  await app.storage.set(KEYS.pollFailures, String(failures));
  return 2_000;
}

function isApiError(response: GetUpdatesResp): boolean {
  const retBad = response.ret !== undefined && response.ret !== 0;
  const codeBad = response.errcode !== undefined && response.errcode !== 0;
  return retBad || codeBad;
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
