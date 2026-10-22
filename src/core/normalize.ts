import { MESSAGE_ITEM } from "./constants.js";
import type { InboundEvent, InboundType, MediaInfo, MessageItem, WeixinMessage } from "./types.js";

/**
 * Stable id for dedupe. Prefers the uint64 message_id, then an item msg_id,
 * then a synthetic id when seq and time are both present.
 */
export function messageDedupeId(msg: WeixinMessage): string | null {
  const top = msg.message_id?.trim();
  if (top) return top;
  for (const item of msg.item_list ?? []) {
    const id = item.msg_id?.trim();
    if (id) return id;
  }
  if (msg.from_user_id && msg.create_time_ms !== undefined && msg.seq !== undefined) {
    return `synth:${msg.from_user_id}:${msg.create_time_ms}:${msg.seq}`;
  }
  return null;
}

/** True when the event has text or a media placeholder worth sending to the routine. */
export function isForwardable(event: InboundEvent): boolean {
  return event.text.length > 0 || event.media.length > 0;
}

/**
 * Build the webhook event. Sender name is always null: the upstream message
 * type does not include a display name. Media bytes are not downloaded.
 */
export function normalizeInbound(msg: WeixinMessage, accountId: string, publicBaseUrl: string): InboundEvent {
  const texts: string[] = [];
  const media: MediaInfo[] = [];
  for (const item of msg.item_list ?? []) {
    collectItem(item, texts, media);
  }
  const transcript = media.find((item) => item.transcript)?.transcript ?? "";
  const text = texts.join("\n") || transcript;
  const senderId = msg.from_user_id ?? "";
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    schema: "grokbot-weixin.inbound.v1",
    account_id: accountId,
    sender: { id: senderId, name: null },
    message_id: messageDedupeId(msg) ?? "unknown",
    timestamp_ms: typeof msg.create_time_ms === "number" ? msg.create_time_ms : null,
    type: eventType(texts, media),
    state: messageState(msg.message_state),
    text,
    media,
    context_token: msg.context_token ?? null,
    chat_type: "direct",
    reply: {
      method: "POST",
      url: base ? `${base}/send` : null,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <BRIDGE_TOKEN>",
      },
      body: {
        to: senderId,
        text: "<reply text>",
        context_token: msg.context_token ?? null,
        account: accountId,
      },
      notes:
        "POST reply.body to reply.url. Put the bridge bearer token in the Authorization header (BRIDGE_TOKEN). The placeholder is not the token. Omit context_token to use the newest token stored for this sender. Send nothing when no reply is needed. Confirm the webhook key header in the Grok Bot routine panel; this bridge's outbound call is independent of that header.",
    },
  };
}

function collectItem(item: MessageItem, texts: string[], media: MediaInfo[]): void {
  if (item.type === MESSAGE_ITEM.TEXT && item.text_item?.text) {
    texts.push(item.text_item.text);
    return;
  }
  if (item.type === MESSAGE_ITEM.IMAGE && item.image_item) {
    media.push({
      kind: "image",
      file_name: null,
      transcript: null,
      has_cdn_reference: hasCdn(item.image_item.media),
    });
    return;
  }
  if (item.type === MESSAGE_ITEM.VOICE && item.voice_item) {
    media.push({
      kind: "voice",
      file_name: null,
      transcript: item.voice_item.text ?? null,
      has_cdn_reference: hasCdn(item.voice_item.media),
    });
    return;
  }
  if (item.type === MESSAGE_ITEM.FILE && item.file_item) {
    media.push({
      kind: "file",
      file_name: item.file_item.file_name ?? null,
      transcript: null,
      has_cdn_reference: hasCdn(item.file_item.media),
    });
    return;
  }
  if (item.type === MESSAGE_ITEM.VIDEO && item.video_item) {
    media.push({
      kind: "video",
      file_name: null,
      transcript: null,
      has_cdn_reference: hasCdn(item.video_item.media),
    });
  }
}

function hasCdn(media: { encrypt_query_param?: string; full_url?: string } | undefined): boolean {
  return Boolean(media?.encrypt_query_param || media?.full_url);
}

function eventType(texts: string[], media: MediaInfo[]): InboundType {
  if (media.length === 0) return texts.length > 0 ? "text" : "unknown";
  const only = media[0];
  if (texts.length === 0 && media.length === 1 && only) return only.kind;
  return "mixed";
}

function messageState(state: number | undefined): InboundEvent["state"] {
  if (state === 0) return "new";
  if (state === 1) return "generating";
  if (state === 2) return "finished";
  return "unknown";
}
