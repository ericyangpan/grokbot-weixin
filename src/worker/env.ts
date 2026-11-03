import { configFromEnv, seedFromEnv, type AccountSeed, type BridgeConfig, type EnvMap } from "../core/config.js";

/** Worker bindings. Secrets are set with `wrangler secret put` and are optional at type level. */
export interface Env {
  ACCOUNT: DurableObjectNamespace;
  BRIDGE_TOKEN?: string;
  BRIDGE_PUBLIC_URL?: string;
  DEEPSEEK_API_KEY?: string;
  AI_API_BASE?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  ZHONGDIWA_API_BASE?: string;
  ZHONGDIWA_API_KEY?: string;
  ZHONGDIWA_MODEL?: string;
  ZHONGDIWA_ACTOR_AUTHORIZATION?: string;
  GROK_WEBHOOK_URL?: string;
  GROK_WEBHOOK_KEY?: string;
  GROK_WEBHOOK_HEADER?: string;
  GROK_WEBHOOK_SCHEME?: string;
  ILINK_API_BASE?: string;
  ILINK_CDN_BASE?: string;
  ILINK_BOT_TYPE?: string;
  ILINK_APP_ID?: string;
  ILINK_CHANNEL_VERSION?: string;
  ILINK_BOT_AGENT?: string;
  ILINK_ROUTE_TAG?: string;
  WEIXIN_BOT_TOKEN?: string;
  WEIXIN_ACCOUNT_ID?: string;
  WEIXIN_BASE_URL?: string;
  WEIXIN_OWNER_USER_ID?: string;
  WEIXIN_ALLOW_FROM?: string;
  WEIXIN_PIN_FIRST_SENDER?: string;
  SEND_TYPING?: string;
  LONG_POLL_TIMEOUT_MS?: string;
  WEBHOOK_MAX_ATTEMPTS?: string;
  RATE_LIMIT_SEND_PER_MINUTE?: string;
  MEDIA_TTL_MS?: string;
  MEDIA_MAX_BYTES?: string;
  MEDIA_MAX_TOTAL_BYTES?: string;
  MEDIA_TRANSCODE_VOICE?: string;
  HISTORY_MAX_TURNS?: string;
  HISTORY_MAX_CHARS?: string;
  HISTORY_TTL_MS?: string;
  HISTORY_RESET?: string;
  HISTORY_VIEW_TTL_MS?: string;
}

/** Copy string bindings into the core env map. The Durable Object namespace is not included. */
export function workerEnvRecord(env: Env): EnvMap {
  return {
    BRIDGE_TOKEN: env.BRIDGE_TOKEN,
    BRIDGE_PUBLIC_URL: env.BRIDGE_PUBLIC_URL,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    AI_API_BASE: env.AI_API_BASE,
    AI_API_KEY: env.AI_API_KEY,
    AI_MODEL: env.AI_MODEL,
    ZHONGDIWA_API_BASE: env.ZHONGDIWA_API_BASE,
    ZHONGDIWA_API_KEY: env.ZHONGDIWA_API_KEY,
    ZHONGDIWA_MODEL: env.ZHONGDIWA_MODEL,
    ZHONGDIWA_ACTOR_AUTHORIZATION: env.ZHONGDIWA_ACTOR_AUTHORIZATION,
    GROK_WEBHOOK_URL: env.GROK_WEBHOOK_URL,
    GROK_WEBHOOK_KEY: env.GROK_WEBHOOK_KEY,
    GROK_WEBHOOK_HEADER: env.GROK_WEBHOOK_HEADER,
    GROK_WEBHOOK_SCHEME: env.GROK_WEBHOOK_SCHEME,
    ILINK_API_BASE: env.ILINK_API_BASE,
    ILINK_CDN_BASE: env.ILINK_CDN_BASE,
    ILINK_BOT_TYPE: env.ILINK_BOT_TYPE,
    ILINK_APP_ID: env.ILINK_APP_ID,
    ILINK_CHANNEL_VERSION: env.ILINK_CHANNEL_VERSION,
    ILINK_BOT_AGENT: env.ILINK_BOT_AGENT,
    ILINK_ROUTE_TAG: env.ILINK_ROUTE_TAG,
    WEIXIN_BOT_TOKEN: env.WEIXIN_BOT_TOKEN,
    WEIXIN_ACCOUNT_ID: env.WEIXIN_ACCOUNT_ID,
    WEIXIN_BASE_URL: env.WEIXIN_BASE_URL,
    WEIXIN_OWNER_USER_ID: env.WEIXIN_OWNER_USER_ID,
    WEIXIN_ALLOW_FROM: env.WEIXIN_ALLOW_FROM,
    WEIXIN_PIN_FIRST_SENDER: env.WEIXIN_PIN_FIRST_SENDER,
    SEND_TYPING: env.SEND_TYPING,
    LONG_POLL_TIMEOUT_MS: env.LONG_POLL_TIMEOUT_MS,
    WEBHOOK_MAX_ATTEMPTS: env.WEBHOOK_MAX_ATTEMPTS,
    RATE_LIMIT_SEND_PER_MINUTE: env.RATE_LIMIT_SEND_PER_MINUTE,
    MEDIA_TTL_MS: env.MEDIA_TTL_MS,
    MEDIA_MAX_BYTES: env.MEDIA_MAX_BYTES,
    MEDIA_MAX_TOTAL_BYTES: env.MEDIA_MAX_TOTAL_BYTES,
    MEDIA_TRANSCODE_VOICE: env.MEDIA_TRANSCODE_VOICE,
    HISTORY_MAX_TURNS: env.HISTORY_MAX_TURNS,
    HISTORY_MAX_CHARS: env.HISTORY_MAX_CHARS,
    HISTORY_TTL_MS: env.HISTORY_TTL_MS,
    HISTORY_RESET: env.HISTORY_RESET,
    HISTORY_VIEW_TTL_MS: env.HISTORY_VIEW_TTL_MS,
  };
}

/** Build the core config from Worker bindings. */
export function workerConfig(env: Env): BridgeConfig {
  return configFromEnv(workerEnvRecord(env));
}

/** Optional session seed from Worker secrets. */
export function workerSeed(env: Env): AccountSeed {
  return seedFromEnv(workerEnvRecord(env));
}
