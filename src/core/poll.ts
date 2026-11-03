import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
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
import { replyWithAI } from "./deepseek.js";
import { fetchAvailableModels, type AIProvider } from "./models.js";

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
    response = await app.client.getUpdates({ baseUrl, token: session.botToken, cursor, timeoutMs });
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
    logError("getupdates_rejected", { ret: response.ret ?? null, errcode: response.errcode ?? null });
    return { nextDelayMs: delay, schedule: true, polled: true };
  }

  const failureFlag = await app.storage.get(KEYS.pollFailures);
  if (failureFlag && failureFlag !== "0") await app.storage.set(KEYS.pollFailures, "0");
  await rememberServerTimeout(app, response.longpolling_timeout_ms, timeoutMs);
  await sweepMedia(app);
  await dispatchMessages(app, session, response.msgs ?? []);
  const nextCursor = response.get_updates_buf;
  if (nextCursor && nextCursor !== cursor) await app.storage.set(KEYS.cursor, nextCursor);
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
      if (outcome.seen !== seen) { seen = outcome.seen; seenChanged = true; }
      if (outcome.allow) { allow = outcome.allow; allowChanged = true; }
      if (outcome.tokens) { tokens = outcome.tokens; tokensChanged = true; }
    } catch (err) {
      logError("inbound_failed", { message_id: msg.message_id ?? null, error: publicError(err) });
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
  if (msg.group_id) { logInfo("ignored_group", { sender: sender || null }); return { seen }; }
  if (msg.message_type === MESSAGE_TYPE_BOT || (sender && sender === session.accountId)) return { seen };
  const id = messageDedupeId(msg);
  let nextSeen = seen;
  if (id) {
    const remembered = rememberId(seen, id);
    if (remembered.duplicate) return { seen };
    nextSeen = remembered.seen;
  }
  const nextAllow = allow;
  if (!sender || !nextAllow.includes(sender)) {
    logInfo("ignored_sender", { sender: sender || null });
    return { seen: nextSeen };
  }
  let nextTokens = tokens;
  if (msg.context_token && tokens[sender] !== msg.context_token) nextTokens = { ...tokens, [sender]: msg.context_token };
  const built = normalizeInbound(msg, session.accountId, app.config.bridgePublicUrl);
  const event = await resolveInboundMedia(app, built);
  if (isForwardable(event)) {
    if (await handleProviderCommand(app, event)) {
      return { seen: nextSeen, ...(nextTokens !== tokens ? { tokens: nextTokens } : {}) };
    }
    if (await handleModelCommand(app, event)) {
      return { seen: nextSeen, ...(nextTokens !== tokens ? { tokens: nextTokens } : {}) };
    }
    if (app.config.historyReset && isHistoryReset(event)) {
      await clearPeerHistory(app, sender);
      logInfo("history_reset", { sender });
      const ack = await sendBridgeText(app, { to: sender, text: HISTORY_RESET_ACK, ...(msg.context_token ? { contextToken: msg.context_token } : {}) });
      if (ack.ok) await clearPeerHistory(app, sender);
      return { seen: nextSeen, ...(nextTokens !== tokens ? { tokens: nextTokens } : {}) };
    }
    try {
      event.history = await rememberInbound(app, sender, event);
    } catch (err) {
      event.history = [];
      logWarn("history_read_failed", { sender, error: publicError(err) });
    }
    const provider = normalizeProvider((await app.storage.get(KEYS.aiProvider)) ?? "opendoor");
    const model = await readProviderModel(app, provider);
    const aiApp = provider === "deepseek"
      ? {
          ...app,
          config: {
            ...app.config,
            aiApiBase: "https://api.deepseek.com",
            aiApiKey: app.config.deepseekApiKey,
            aiModel: model || "deepseek-chat",
            aiApiProtocol: "chat_completions" as const,
          },
        }
      : provider === "zhongdiwa"
        ? {
            ...app,
            config: {
              ...app.config,
              aiApiBase: app.config.zhongdiwaApiBase,
              aiApiKey: app.config.zhongdiwaApiKey,
              aiModel: model || app.config.zhongdiwaModel,
              aiApiProtocol: "responses" as const,
            },
          }
        : {
            ...app,
            config: {
              ...app.config,
              aiApiProtocol: "chat_completions" as const,
              aiModel: model || app.config.aiModel,
            },
          };
    const ok = await replyWithAI(aiApp, event);
    logInfo("inbound_replied", { sender, message_id: event.message_id, type: event.type, provider, ok });
    if (ok && app.config.sendTyping && msg.context_token) await sendTypingBestEffort(app, session, sender, msg.context_token);
  }
  return { seen: nextSeen, ...(nextTokens !== tokens ? { tokens: nextTokens } : {}) };
}

async function handleProviderCommand(app: BridgeApp, event: import("./types.js").InboundEvent): Promise<boolean> {
  const raw = event.text.trim();
  if (!/^\/provider(?:\s|$)/i.test(raw)) return false;
  const selection = raw.slice("/provider".length).trim().toLowerCase();
  const current = normalizeProvider((await app.storage.get(KEYS.aiProvider)) ?? "opendoor");
  if (!selection || selection === "help" || selection === "list") {
    await sendCommandReply(app, event, [
      `当前服务商：${providerLabel(current)}`,
      "",
      "/provider deepseek —— DeepSeek 官方 API",
      "/provider opendoor —— OpenDoor 中转 API",
      "/provider zhongdiwa —— 中低洼 Responses API",
      "/model list —— 查看当前服务商的模型",
    ].join("\n"));
    return true;
  }
  if (selection !== "deepseek" && selection !== "opendoor" && selection !== "custom" && selection !== "zhongdiwa") {
    await sendCommandReply(app, event, "不支持这个服务商。发送 /provider 查看可用服务商。");
    return true;
  }
  const provider = normalizeProvider(selection);
  const key = provider === "deepseek" ? app.config.deepseekApiKey : provider === "zhongdiwa" ? app.config.zhongdiwaApiKey : app.config.aiApiKey;
  if (!key.trim()) {
    const secretName = provider === "deepseek" ? "DEEPSEEK_API_KEY" : provider === "zhongdiwa" ? "ZHONGDIWA_API_KEY" : "AI_API_KEY";
    await sendCommandReply(app, event, `尚未配置 ${secretName}，暂时不能切换到${providerLabel(provider)}。`);
    return true;
  }
  await app.storage.set(KEYS.aiProvider, provider);
  await sendCommandReply(app, event, `已切换到${providerLabel(provider)}。\n发送 /model list 查看模型，发送 /model 模型ID 切换模型。`);
  return true;
}

async function handleModelCommand(app: BridgeApp, event: import("./types.js").InboundEvent): Promise<boolean> {
  const raw = event.text.trim();
  if (!/^\/model(?:\s|$)/i.test(raw)) return false;
  const selection = raw.slice("/model".length).trim();
  const normalized = selection.toLowerCase();
  let provider = normalizeProvider((await app.storage.get(KEYS.aiProvider)) ?? "opendoor");
  let reply: string;

  if (!selection || normalized === "help" || normalized === "list") {
    const model = await readProviderModel(app, provider);
    try {
      const models = await fetchAvailableModels(app, provider);
      const shown = models.slice(0, 60);
      const remaining = models.length - shown.length;
      reply = [
        `当前服务商：${providerLabel(provider)}`,
        `当前模型：${model || defaultModel(app, provider)}`,
        "",
        `可用模型（${models.length}）：`,
        ...shown.map((id) => `• ${id}`),
        ...(remaining > 0 ? [`……另有 ${remaining} 个模型未显示`] : []),
        "",
        "发送 /model 模型ID 切换模型。",
        "/provider —— 切换服务商。",
      ].join("\n");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "未知错误";
      reply = `当前服务商：${providerLabel(provider)}\n当前模型：${model || defaultModel(app, provider)}\n读取模型列表失败：${detail}`;
    }
  } else if (normalized === "deepseek" || normalized === "custom") {
    provider = normalized === "deepseek" ? "deepseek" : "opendoor";
    const key = provider === "deepseek" ? app.config.deepseekApiKey : app.config.aiApiKey;
    if (!key.trim()) {
      reply = provider === "deepseek"
        ? "没有检测到 DEEPSEEK_API_KEY。请先在 Cloudflare 中配置这个 Secret。"
        : "没有检测到 AI_API_KEY。请先在 Cloudflare 中配置这个 Secret。";
    } else {
      await app.storage.set(KEYS.aiProvider, provider);
      reply = `已切换到${providerLabel(provider)}。当前模型：${await readProviderModel(app, provider) || defaultModel(app, provider)}。`;
    }
  } else {
    try {
      const models = await fetchAvailableModels(app, provider);
      const model = models.find((id) => id === selection) ?? models.find((id) => id.toLowerCase() === normalized);
      if (!model) {
        reply = `当前服务商的模型列表中没有找到：${selection}。发送 /model list 查看可用模型。`;
      } else {
        await writeProviderModel(app, provider, model);
        reply = `已切换到${providerLabel(provider)}模型：${model}。`;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "未知错误";
      reply = `读取${providerLabel(provider)}模型列表失败，无法验证模型名称。\n${detail}`;
    }
  }
  await sendCommandReply(app, event, reply);
  return true;
}

function normalizeProvider(value: string): AIProvider {
  if (value === "deepseek" || value === "zhongdiwa") return value;
  return "opendoor";
}

function providerLabel(provider: AIProvider): string {
  return provider === "deepseek" ? "DeepSeek 官方 API" : provider === "zhongdiwa" ? "中低洼 API" : "OpenDoor API";
}

function defaultModel(app: BridgeApp, provider: AIProvider): string {
  return provider === "deepseek" ? "deepseek-chat" : provider === "zhongdiwa" ? app.config.zhongdiwaModel : app.config.aiModel;
}

async function readProviderModel(app: BridgeApp, provider: AIProvider): Promise<string> {
  const key = provider === "deepseek" ? KEYS.aiModelDeepseek : provider === "zhongdiwa" ? KEYS.aiModelZhongdiwa : KEYS.aiModel;
  return (await app.storage.get(key)) ?? "";
}

async function writeProviderModel(app: BridgeApp, provider: AIProvider, model: string): Promise<void> {
  const key = provider === "deepseek" ? KEYS.aiModelDeepseek : provider === "zhongdiwa" ? KEYS.aiModelZhongdiwa : KEYS.aiModel;
  await app.storage.set(key, model);
}

async function sendCommandReply(app: BridgeApp, event: import("./types.js").InboundEvent, text: string): Promise<void> {
  await sendBridgeText(app, {
    to: event.sender.id,
    text,
    ...(event.context_token ? { contextToken: event.context_token } : {}),
  });
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
      const config = await app.client.getConfig({ baseUrl, token: session.botToken, userId, contextToken });
      if (config.ret !== undefined && config.ret !== 0) return;
      if (!config.typing_ticket) return;
      ticket = config.typing_ticket;
      tickets[userId] = { ticket, fetchedAt: appNow(app) };
      await writeTypingTickets(app.storage, tickets);
    }
    await app.client.sendTyping({ baseUrl, token: session.botToken, userId, typingTicket: ticket });
  } catch (err) {
    logWarn("typing_failed", { sender: userId, error: publicError(err) });
    const tickets = await readTypingTickets(app.storage);
    if (tickets[userId]) { delete tickets[userId]; await writeTypingTickets(app.storage, tickets); }
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
  } catch (err) { logWarn("notify_start_failed", { error: publicError(err) }); }
}

async function pauseRemaining(app: BridgeApp, now: number): Promise<number> {
  const raw = await app.storage.get(KEYS.pauseUntil);
  if (!raw) return 0;
  const until = Number(raw);
  if (!Number.isFinite(until) || until <= now) { await app.storage.delete(KEYS.pauseUntil); return 0; }
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
  if (failures >= 3) { await app.storage.set(KEYS.pollFailures, "0"); return 30_000; }
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
