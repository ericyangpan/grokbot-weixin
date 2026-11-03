import {
  DEFAULT_API_BASE,
  DEFAULT_BOT_TYPE,
  DEFAULT_CDN_BASE,
  DEFAULT_ILINK_APP_ID,
  DEFAULT_LONG_POLL_MS,
  DEFAULT_HISTORY_MAX_CHARS,
  DEFAULT_HISTORY_MAX_TURNS,
  DEFAULT_HISTORY_TTL_MS,
  DEFAULT_HISTORY_VIEW_TTL_MS,
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_MEDIA_TOTAL_BYTES,
  DEFAULT_MEDIA_TTL_MS,
  MAX_HISTORY_MAX_CHARS,
  MAX_HISTORY_MAX_TURNS,
  MAX_HISTORY_TTL_MS,
  MAX_HISTORY_VIEW_TTL_MS,
  MAX_LONG_POLL_MS,
  MAX_MEDIA_MAX_BYTES,
  MAX_MEDIA_TOTAL_BYTES,
  MAX_MEDIA_TTL_MS,
  MIN_HISTORY_TTL_MS,
  MIN_HISTORY_VIEW_TTL_MS,
  MIN_LONG_POLL_MS,
  MIN_MEDIA_MAX_BYTES,
  MIN_MEDIA_TTL_MS,
  VERSION,
} from "./constants.js";
import { buildClientVersion, sanitizeBotAgent } from "./protocol.js";

/** Runtime configuration. Secrets stay on this object and must not be logged. */
export interface BridgeConfig {
  ilinkApiBase: string;
  ilinkCdnBase: string;
  ilinkBotType: string;
  ilinkAppId: string;
  channelVersion: string;
  /** Decimal iLink-App-ClientVersion derived from channelVersion. */
  clientVersion: string;
  botAgent: string;
  routeTag?: string;
  allowFrom: string[];
  pinFirstSender: boolean;
  /** OpenAI Chat Completions-compatible endpoint base, without /chat/completions. */
  aiApiBase: string;
  aiApiKey: string;
  aiModel: string;
  /** Selected provider protocol. */
  aiApiProtocol: "chat_completions" | "responses";
  /** Zhongdiwa Responses API credentials. */
  zhongdiwaApiBase: string;
  zhongdiwaApiKey: string;
  zhongdiwaModel: string;
  zhongdiwaActorAuthorization: string;
  /** Legacy field retained for existing diagnostics and deployments. */
  deepseekApiKey: string;
  webhookUrl: string;
  webhookKey: string;
  webhookHeader: string;
  /** Empty string means the key is sent without a scheme prefix. */
  webhookScheme: string;
  bridgePublicUrl: string;
  bridgeToken: string;
  sendTyping: boolean;
  longPollTimeoutMs: number;
  webhookMaxAttempts: number;
  rateLimitPerMinute: number;
  host: string;
  port: number;
  /** How long GET /media/:id keeps working. */
  mediaTtlMs: number;
  /** Largest decrypted object, in bytes. */
  mediaMaxBytes: number;
  /** Sum of stored objects before the oldest are deleted. */
  mediaMaxTotalBytes: number;
  /** When a SILK decoder is installed, try to store voice as WAV. */
  mediaTranscodeVoice: boolean;
  /** Turns kept per peer. Zero disables history and drops what was stored. */
  historyMaxTurns: number;
  /** Character budget for stored text and media summaries. Zero disables history. */
  historyMaxChars: number;
  /** Forget turns older than this. */
  historyTtlMs: number;
  /** When true, a lone /new or /reset clears history and is not forwarded. */
  historyReset: boolean;
  /** Lifetime of a history view link and the cookie it redeems into. */
  historyViewTtlMs: number;
}

/** Optional credentials used to seed storage when it is empty. */
export interface AccountSeed {
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

export type EnvMap = Record<string, string | undefined>;

/** Build config from environment variables. Invalid numeric values fall back to defaults. */
export function configFromEnv(env: EnvMap): BridgeConfig {
  const channelVersion = env.ILINK_CHANNEL_VERSION?.trim() || VERSION;
  const fallbackAgent = `GrokBotWeixin/${channelVersion}`;
  const route = env.ILINK_ROUTE_TAG?.trim();
  const schemeRaw = env.GROK_WEBHOOK_SCHEME;
  const mediaMaxBytes = intEnv(
    env.MEDIA_MAX_BYTES,
    DEFAULT_MEDIA_MAX_BYTES,
    MIN_MEDIA_MAX_BYTES,
    MAX_MEDIA_MAX_BYTES,
  );
  const mediaMaxTotalBytes = Math.max(
    mediaMaxBytes,
    intEnv(env.MEDIA_MAX_TOTAL_BYTES, DEFAULT_MEDIA_TOTAL_BYTES, MIN_MEDIA_MAX_BYTES, MAX_MEDIA_TOTAL_BYTES),
  );
  const legacyKey = env.DEEPSEEK_API_KEY ?? "";
  return {
    ilinkApiBase: stripSlash(env.ILINK_API_BASE?.trim() || DEFAULT_API_BASE),
    ilinkCdnBase: stripSlash(env.ILINK_CDN_BASE?.trim() || DEFAULT_CDN_BASE),
    ilinkBotType: env.ILINK_BOT_TYPE?.trim() || DEFAULT_BOT_TYPE,
    ilinkAppId: env.ILINK_APP_ID?.trim() || DEFAULT_ILINK_APP_ID,
    channelVersion,
    clientVersion: String(buildClientVersion(channelVersion)),
    botAgent: sanitizeBotAgent(env.ILINK_BOT_AGENT, fallbackAgent),
    ...(route && /^[A-Za-z0-9_.:-]{1,64}$/.test(route) ? { routeTag: route } : {}),
    allowFrom: splitList(env.WEIXIN_ALLOW_FROM),
    pinFirstSender: boolEnv(env.WEIXIN_PIN_FIRST_SENDER, true),
    aiApiBase: stripSlash(env.AI_API_BASE?.trim() || "https://api.deepseek.com"),
    aiApiKey: env.AI_API_KEY ?? legacyKey,
    aiModel: env.AI_MODEL?.trim() || "deepseek-chat",
    aiApiProtocol: "chat_completions",
    zhongdiwaApiBase: stripSlash(env.ZHONGDIWA_API_BASE?.trim() || "https://www.zhongdiwa.com/v1"),
    zhongdiwaApiKey: env.ZHONGDIWA_API_KEY ?? "",
    zhongdiwaModel: env.ZHONGDIWA_MODEL?.trim() || "gpt-5.5",
    zhongdiwaActorAuthorization: env.ZHONGDIWA_ACTOR_AUTHORIZATION?.trim() || "local-image-extension",
    deepseekApiKey: legacyKey,
    webhookUrl: env.GROK_WEBHOOK_URL?.trim() ?? "",
    webhookKey: env.GROK_WEBHOOK_KEY ?? "",
    webhookHeader: env.GROK_WEBHOOK_HEADER?.trim() || "Authorization",
    webhookScheme: schemeRaw === undefined ? "Bearer" : schemeRaw === "raw" ? "" : schemeRaw,
    bridgePublicUrl: stripSlash(env.BRIDGE_PUBLIC_URL?.trim() ?? ""),
    bridgeToken: env.BRIDGE_TOKEN ?? "",
    sendTyping: boolEnv(env.SEND_TYPING, true),
    longPollTimeoutMs: intEnv(env.LONG_POLL_TIMEOUT_MS, DEFAULT_LONG_POLL_MS, MIN_LONG_POLL_MS, MAX_LONG_POLL_MS),
    webhookMaxAttempts: intEnv(env.WEBHOOK_MAX_ATTEMPTS, 4, 1, 6),
    rateLimitPerMinute: intEnv(env.RATE_LIMIT_SEND_PER_MINUTE, 30, 1, 600),
    host: env.BRIDGE_HOST?.trim() || "127.0.0.1",
    port: intEnv(env.BRIDGE_PORT, 8787, 1, 65535),
    mediaTtlMs: intEnv(env.MEDIA_TTL_MS, DEFAULT_MEDIA_TTL_MS, MIN_MEDIA_TTL_MS, MAX_MEDIA_TTL_MS),
    mediaMaxBytes,
    mediaMaxTotalBytes,
    mediaTranscodeVoice: boolEnv(env.MEDIA_TRANSCODE_VOICE, true),
    historyMaxTurns: intEnv(env.HISTORY_MAX_TURNS, DEFAULT_HISTORY_MAX_TURNS, 0, MAX_HISTORY_MAX_TURNS),
    historyMaxChars: intEnv(env.HISTORY_MAX_CHARS, DEFAULT_HISTORY_MAX_CHARS, 0, MAX_HISTORY_MAX_CHARS),
    historyTtlMs: intEnv(env.HISTORY_TTL_MS, DEFAULT_HISTORY_TTL_MS, MIN_HISTORY_TTL_MS, MAX_HISTORY_TTL_MS),
    historyReset: boolEnv(env.HISTORY_RESET, true),
    historyViewTtlMs: intEnv(
      env.HISTORY_VIEW_TTL_MS,
      DEFAULT_HISTORY_VIEW_TTL_MS,
      MIN_HISTORY_VIEW_TTL_MS,
      MAX_HISTORY_VIEW_TTL_MS,
    ),
  };
}

/** Read an optional pre-seeded WeChat session. Both token and account id are required. */
export function seedFromEnv(env: EnvMap): AccountSeed {
  const botToken = env.WEIXIN_BOT_TOKEN?.trim();
  const accountId = env.WEIXIN_ACCOUNT_ID?.trim();
  if (!botToken || !accountId) return {};
  const baseUrl = env.WEIXIN_BASE_URL?.trim();
  const userId = env.WEIXIN_OWNER_USER_ID?.trim();
  return {
    botToken,
    accountId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
