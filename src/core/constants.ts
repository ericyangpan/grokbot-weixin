/** Package version. Keep it aligned with package.json and the iLink channel_version. */
export const VERSION = "0.1.0";

/** Default iLink Bot API origin. QR login starts here unless ILINK_API_BASE overrides it. */
export const DEFAULT_API_BASE = "https://ilinkai.weixin.qq.com";

/** Default CDN origin. v1 does not download media; the value is recorded for operators. */
export const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Upstream default bot_type for get_bot_qrcode. */
export const DEFAULT_BOT_TYPE = "3";

/** iLink application id used by the official client (package.json ilink_appid). */
export const DEFAULT_ILINK_APP_ID = "bot";

/** getUpdates errcode/ret that upstream treats as a stale bot token. */
export const STALE_TOKEN_ERRCODE = -14;

/**
 * sendMessage ret reported by upstream users when a context_token is rejected.
 * The protocol document does not define this code; see the README.
 */
export const CONTEXT_TOKEN_REJECTED_RET = -2;

/** Upstream pauses the account for one hour after errcode -14. */
export const SESSION_PAUSE_MS = 60 * 60 * 1000;

/** Upstream client timeout for one getUpdates long poll. */
export const DEFAULT_LONG_POLL_MS = 35_000;

export const MIN_LONG_POLL_MS = 5_000;

/** Stay well under the 15 minute Durable Object alarm wall-time limit. */
export const MAX_LONG_POLL_MS = 60_000;

export const API_TIMEOUT_MS = 15_000;

export const CONFIG_TIMEOUT_MS = 10_000;

/** One status request from the login page. The iLink call itself long-polls. */
export const QR_STATUS_TIMEOUT_MS = 25_000;

/** In-memory login sessions in the upstream client expire after five minutes of inactivity. */
export const QR_LOGIN_TTL_MS = 5 * 60_000;

/**
 * Upstream starts the counter at 1 and gives up when it exceeds 3,
 * which is the original QR plus two refreshes.
 */
export const MAX_QR_REFRESH_COUNT = 3;

export const DEDUPE_LIMIT = 200;

/** Local cache only. The protocol does not document typing_ticket lifetime. */
export const TYPING_TICKET_TTL_MS = 10 * 60_000;

export const SEND_TEXT_MAX = 8_000;

export const BODY_MAX_BYTES = 65_536;

export const RATE_WINDOW_MS = 60_000;

/** message_type value upstream uses for a bot-originated message. */
export const MESSAGE_TYPE_BOT = 2;

export const MESSAGE_TYPE_USER = 1;

export const MESSAGE_ITEM = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;
