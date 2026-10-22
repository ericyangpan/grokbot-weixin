/** Subset of the upstream WeixinMessage fields this bridge reads. */
export interface TextItem {
  text?: string;
}

export interface CdnMedia {
  encrypt_query_param?: string;
  full_url?: string;
}

export interface ImageItem {
  media?: CdnMedia;
  aeskey?: string;
}

export interface VoiceItem {
  media?: CdnMedia;
  text?: string;
  playtime?: number;
}

export interface FileItem {
  media?: CdnMedia;
  file_name?: string;
  len?: string;
}

export interface VideoItem {
  media?: CdnMedia;
  play_length?: number;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
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

export interface MediaInfo {
  kind: MediaKind;
  file_name: string | null;
  /** Voice transcript when the API includes voice_item.text. v1 does not download audio. */
  transcript: string | null;
  has_cdn_reference: boolean;
}

export type InboundType = "text" | MediaKind | "mixed" | "unknown";

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
