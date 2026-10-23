/** Subset of the upstream WeixinMessage fields this bridge reads. */
export interface TextItem {
  text?: string;
}

export interface CdnMedia {
  encrypt_query_param?: string;
  /** Base64 of 16 raw key bytes, or base64 of a 32-character hex key. */
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CdnMedia;
  /** Inbound AES-128 key as 32 hex characters. Preferred over media.aes_key. */
  aeskey?: string;
  /** Ciphertext size in bytes, when the sender set it. */
  mid_size?: number;
}

export interface VoiceItem {
  media?: CdnMedia;
  /** 1 pcm, 5 amr, 6 silk, 7 mp3, 8 ogg. Absent usually means SILK. */
  encode_type?: number;
  sample_rate?: number;
  /** Duration in milliseconds. */
  playtime?: number;
  /** Speech-to-text transcript, when WeChat includes one. */
  text?: string;
}

export interface FileItem {
  media?: CdnMedia;
  file_name?: string;
  len?: string;
}

export interface VideoItem {
  media?: CdnMedia;
  /** Ciphertext size in bytes, when the sender set it. */
  video_size?: number;
  play_length?: number;
}

/** A message the sender quoted. `message_item` is one level deep. */
export interface RefMessage {
  message_item?: MessageItem;
  /** Short summary supplied by the server. */
  title?: string;
  svr_id?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

/**
 * Inbound message from getUpdates.
 * `message_id` is a uint64 on the wire and is kept as a string.
 * Upstream's type has no sender display name.
 */
export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface NotifyResp {
  ret?: number;
  errmsg?: string;
}

/** QR status values handled by the upstream login client. */
export type QrStatusName =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusBody {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface QrCodeBody {
  qrcode: string;
  qrcode_img_content: string;
}

export type MediaKind = "image" | "voice" | "file" | "video";

/**
 * Why `url` is null. Null means the bytes are at `url`, or the item had no CDN object.
 * `no_reference` is an item that named a media type but carried no CDN locator.
 */
export type MediaErrorCode =
  | "no_reference"
  | "no_key"
  | "download_failed"
  | "decrypt_failed"
  | "too_large"
  | "too_many"
  | "storage_failed"
  | "public_url_missing";

export interface MediaInfo {
  kind: MediaKind;
  file_name: string | null;
  /** Voice transcript when the API includes voice_item.text. */
  transcript: string | null;
  has_cdn_reference: boolean;
  mime_type: string | null;
  /** Decrypted size in bytes, when the object was stored or measured. */
  size: number | null;
  /** Absolute GET URL. Requires the same bearer token as /send. Null when bytes are unavailable. */
  url: string | null;
  /** Unix milliseconds after which GET /media/:id returns 404. */
  expires_at_ms: number | null;
  /** Voice playtime in milliseconds, when WeChat sent one. */
  duration_ms: number | null;
  error: MediaErrorCode | null;
}

/** Quoted or referenced message carried on an inbound item. */
export interface QuoteInfo {
  title: string | null;
  text: string | null;
  /** Server id of the quoted message (`ref_msg.svr_id`), when present. */
  message_id: string | null;
  media: MediaInfo[];
}

export type InboundType = "text" | MediaKind | "mixed" | "unknown";

/** Descriptive media fields kept in history. URLs are omitted because they expire. */
export interface HistoryMedia {
  kind: MediaKind;
  file_name: string | null;
  transcript: string | null;
}

/** Quote summary stored with a past user turn. */
export interface HistoryQuote {
  title: string | null;
  text: string | null;
  message_id: string | null;
  media: HistoryMedia[];
}

/**
 * One past turn. `user` is an inbound WeChat message. `assistant` is text
 * this bridge successfully sent, including a proactive `/send`.
 */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
  type: InboundType;
  media: HistoryMedia[];
  quote: HistoryQuote | null;
  at_ms: number;
  message_id: string;
}

/**
 * Webhook body. Field names are stable so a Grok Bot routine can read them
 * without guessing. `reply` describes the bridge send API; it does not contain
 * the bearer token.
 */
export interface InboundEvent {
  schema: "grokbot-weixin.inbound.v1";
  account_id: string;
  sender: { id: string; name: string | null };
  message_id: string;
  timestamp_ms: number | null;
  type: InboundType;
  state: "new" | "generating" | "finished" | "unknown";
  text: string;
  media: MediaInfo[];
  /** Set when an item carries `ref_msg`. Media on it uses the same shape as `media`. */
  quote: QuoteInfo | null;
  /**
   * Earlier turns with this sender, oldest first. Does not include this message.
   * Media entries have no download URL.
   */
  history: HistoryTurn[];
  context_token: string | null;
  chat_type: "direct";
  reply: {
    method: "POST";
    url: string | null;
    headers: {
      "Content-Type": "application/json";
      Authorization: "Bearer <BRIDGE_TOKEN>";
    };
    body: {
      to: string;
      text: "<reply text>";
      context_token: string | null;
      account: string;
    };
    notes: string;
  };
}
