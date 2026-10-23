import { decodeHexKey, parseAesKey } from "./aes.js";
import { MAX_INBOUND_ITEMS, MAX_MEDIA_ITEMS, MESSAGE_ITEM } from "./constants.js";
import type {
  CdnMedia,
  FileItem,
  ImageItem,
  InboundEvent,
  InboundType,
  MediaInfo,
  MediaKind,
  MessageItem,
  QuoteInfo,
  RefMessage,
  VideoItem,
  VoiceItem,
  WeixinMessage,
} from "./types.js";

/** One CDN object the poll should download before the webhook is sent. */
export interface MediaDownload {
  target: MediaInfo;
  kind: MediaKind;
  fullUrl: string | null;
  encryptQueryParam: string | null;
  /** Null only for an image the API sent without a key. Those bytes are stored as-is. */
  aesKey: Uint8Array | null;
  plain: boolean;
  encodeType: number | null;
  sampleRate: number | null;
  /** Sender-declared size. Compared with the cap before any GET. */
  declaredBytes: number | null;
  /** True when `declaredBytes` counts ciphertext (image mid_size, video video_size). */
  declaredIsCipher: boolean;
}

/** Webhook event plus the downloads still to perform. */
export interface InboundBuild {
  event: InboundEvent;
  downloads: MediaDownload[];
}

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

/** True when the event has text, an attachment, or a quote worth forwarding. */
export function isForwardable(event: InboundEvent): boolean {
  if (event.text.length > 0 || event.media.length > 0) return true;
  const quote = event.quote;
  if (!quote) return false;
  return Boolean(quote.text || quote.title) || quote.media.length > 0;
}

/**
 * Build the webhook event. Bytes are not downloaded here; `downloads` lists
 * the CDN objects to fetch. Sender name is always null.
 */
export function normalizeInbound(msg: WeixinMessage, accountId: string, publicBaseUrl: string): InboundBuild {
  const texts: string[] = [];
  const media: MediaInfo[] = [];
  const downloads: MediaDownload[] = [];
  const quoteTexts: string[] = [];
  const quoteMedia: MediaInfo[] = [];
  const quoteTitles: string[] = [];
  let quoteMessageId: string | null = null;
  const items = (msg.item_list ?? []).slice(0, MAX_INBOUND_ITEMS);
  for (const item of items) {
    if (item.ref_msg) {
      const absorbed = absorbQuote(item.ref_msg, quoteTexts, quoteMedia, downloads);
      if (absorbed.title) quoteTitles.push(absorbed.title);
      if (!quoteMessageId && absorbed.messageId) quoteMessageId = absorbed.messageId;
    }
    collectBody(item, texts, media, downloads);
  }
  const transcript = firstTranscript(media);
  const quoteTranscript = firstTranscript(quoteMedia);
  const quoteText = quoteTexts.join("\n") || quoteTranscript;
  const quote = buildQuote(quoteTitles, quoteText, quoteMessageId, quoteMedia);
  const text = texts.join("\n") || transcript || quoteText || "";
  const senderId = msg.from_user_id ?? "";
  const base = publicBaseUrl.replace(/\/+$/, "");
  const ownType = classify(texts, media);
  const type = ownType === "unknown" && quote ? classify(quote.text ? [quote.text] : [], quote.media) : ownType;
  return {
    downloads,
    event: {
      schema: "grokbot-weixin.inbound.v1",
      account_id: accountId,
      sender: { id: senderId, name: null },
      message_id: messageDedupeId(msg) ?? "unknown",
      timestamp_ms: typeof msg.create_time_ms === "number" ? msg.create_time_ms : null,
      type: type === "unknown" && quote?.title ? "text" : type,
      state: messageState(msg.message_state),
      text,
      media,
      quote,
      history: [],
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
          "POST reply.body to reply.url. Put the bridge bearer token in the Authorization header (BRIDGE_TOKEN). The placeholder is not the token. GET media[].url and quote.media[].url with that same bearer token before expires_at_ms; the URL alone is not enough. history is older turns for this sender, oldest first, and does not include this message. A message whose entire text is /new or /reset clears history and is not forwarded. Omit context_token to use the newest token stored for this sender. Send nothing when no reply is needed. Confirm the webhook key header in the Grok Bot routine panel; this bridge's outbound call is independent of that header.",
      },
    },
  };
}

/** Copy a quoted item into the quote buckets. Does not follow a nested ref_msg. */
function absorbQuote(
  ref: RefMessage,
  texts: string[],
  media: MediaInfo[],
  downloads: MediaDownload[],
): { title: string | null; messageId: string | null } {
  if (ref.message_item) collectBody(ref.message_item, texts, media, downloads);
  const title = nonEmpty(ref.title);
  const messageId = nonEmpty(ref.svr_id);
  return { title, messageId };
}

/** Turn one item's own body into text or a media slot. */
function collectBody(item: MessageItem, texts: string[], media: MediaInfo[], downloads: MediaDownload[]): void {
  if (item.type === MESSAGE_ITEM.TEXT && item.text_item?.text) {
    texts.push(item.text_item.text);
    return;
  }
  if (item.type === MESSAGE_ITEM.IMAGE && item.image_item) {
    pushImage(item.image_item, media, downloads);
    return;
  }
  if (item.type === MESSAGE_ITEM.VOICE && item.voice_item) {
    pushVoice(item.voice_item, media, downloads);
    return;
  }
  if (item.type === MESSAGE_ITEM.FILE && item.file_item) {
    pushFile(item.file_item, media, downloads);
    return;
  }
  if (item.type === MESSAGE_ITEM.VIDEO && item.video_item) {
    pushVideo(item.video_item, media, downloads);
  }
}

/** Record an image. A missing key still downloads; the bytes are used as plaintext. */
function pushImage(item: ImageItem, media: MediaInfo[], downloads: MediaDownload[]): void {
  const located = locator(item.media);
  const resolved = imageKey(item);
  const info = blankMedia("image", null, null);
  stage(info, media, downloads, {
    kind: "image",
    located,
    key: resolved.key,
    keyPresent: resolved.present,
    plainAllowed: true,
    encodeType: null,
    sampleRate: null,
    declaredBytes: finiteBytes(item.mid_size),
    declaredIsCipher: true,
    durationMs: null,
  });
}

/** Record a voice note. Without aes_key the transcript is kept and the audio is not fetched. */
function pushVoice(item: VoiceItem, media: MediaInfo[], downloads: MediaDownload[]): void {
  const located = locator(item.media);
  const resolved = keyed(item.media?.aes_key);
  const info = blankMedia("voice", null, nonEmpty(item.text));
  stage(info, media, downloads, {
    kind: "voice",
    located,
    key: resolved.key,
    keyPresent: resolved.present,
    plainAllowed: false,
    encodeType: finiteInt(item.encode_type),
    sampleRate: finiteInt(item.sample_rate),
    declaredBytes: null,
    declaredIsCipher: false,
    durationMs: finiteBytes(item.playtime),
  });
}

/** Record a file. `len` is the plaintext size as a decimal string. */
function pushFile(item: FileItem, media: MediaInfo[], downloads: MediaDownload[]): void {
  const located = locator(item.media);
  const resolved = keyed(item.media?.aes_key);
  const named = nonEmpty(item.file_name);
  const info = blankMedia("file", named ? sanitizeFileName(named, "file.bin") : null, null);
  stage(info, media, downloads, {
    kind: "file",
    located,
    key: resolved.key,
    keyPresent: resolved.present,
    plainAllowed: false,
    encodeType: null,
    sampleRate: null,
    declaredBytes: parseLen(item.len),
    declaredIsCipher: false,
    durationMs: null,
  });
}

/** Record a video. `video_size` is the ciphertext size. */
function pushVideo(item: VideoItem, media: MediaInfo[], downloads: MediaDownload[]): void {
  const located = locator(item.media);
  const resolved = keyed(item.media?.aes_key);
  const info = blankMedia("video", null, null);
  stage(info, media, downloads, {
    kind: "video",
    located,
    key: resolved.key,
    keyPresent: resolved.present,
    plainAllowed: false,
    encodeType: null,
    sampleRate: null,
    declaredBytes: finiteBytes(item.video_size),
    declaredIsCipher: true,
    durationMs: null,
  });
}

interface StageInput {
  kind: MediaKind;
  located: { fullUrl: string | null; encryptQueryParam: string | null; hasRef: boolean };
  key: Uint8Array | null;
  keyPresent: boolean;
  plainAllowed: boolean;
  encodeType: number | null;
  sampleRate: number | null;
  declaredBytes: number | null;
  declaredIsCipher: boolean;
  durationMs: number | null;
}

/** Attach a media slot and, when it can be fetched, a download plan. */
function stage(info: MediaInfo, media: MediaInfo[], downloads: MediaDownload[], input: StageInput): void {
  info.has_cdn_reference = input.located.hasRef;
  info.duration_ms = input.durationMs;
  media.push(info);
  if (!input.located.hasRef) {
    info.error = "no_reference";
    return;
  }
  if (!input.key) {
    if (!(input.plainAllowed && !input.keyPresent)) {
      info.error = input.keyPresent ? "decrypt_failed" : "no_key";
      return;
    }
  }
  if (downloads.length >= MAX_MEDIA_ITEMS) {
    info.error = "too_many";
    return;
  }
  downloads.push({
    target: info,
    kind: input.kind,
    fullUrl: input.located.fullUrl,
    encryptQueryParam: input.located.encryptQueryParam,
    aesKey: input.key,
    plain: input.key === null,
    encodeType: input.encodeType,
    sampleRate: input.sampleRate,
    declaredBytes: input.declaredBytes,
    declaredIsCipher: input.declaredIsCipher,
  });
}

/** Empty media object. The resolver fills mime, size, and url. */
function blankMedia(kind: MediaKind, fileName: string | null, transcript: string | null): MediaInfo {
  return {
    kind,
    file_name: fileName,
    transcript,
    has_cdn_reference: false,
    mime_type: null,
    size: null,
    url: null,
    expires_at_ms: null,
    duration_ms: null,
    error: null,
  };
}

/** Read the CDN locator fields we are willing to log nowhere and fetch later. */
function locator(media: CdnMedia | undefined): { fullUrl: string | null; encryptQueryParam: string | null; hasRef: boolean } {
  const fullUrl = nonEmpty(media?.full_url);
  const encryptQueryParam = nonEmpty(media?.encrypt_query_param);
  return { fullUrl, encryptQueryParam, hasRef: Boolean(fullUrl || encryptQueryParam) };
}

/** Image key: 32 hex characters on the item, then media.aes_key. */
function imageKey(item: ImageItem): { key: Uint8Array | null; present: boolean } {
  const hex = item.aeskey?.trim() ?? "";
  const encoded = item.media?.aes_key?.trim() ?? "";
  const present = hex.length > 0 || encoded.length > 0;
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    const decoded = decodeHexKey(hex);
    if (decoded) return { key: decoded, present };
  }
  if (encoded) {
    const decoded = parseAesKey(encoded);
    if (decoded) return { key: decoded, present };
  }
  return { key: null, present };
}

/** Voice, file, and video use only media.aes_key. */
function keyed(aesKey: string | undefined): { key: Uint8Array | null; present: boolean } {
  const encoded = aesKey?.trim() ?? "";
  if (!encoded) return { key: null, present: false };
  return { key: parseAesKey(encoded), present: true };
}

/** Assemble the quote object. Null when the message did not reference anything. */
function buildQuote(
  titles: string[],
  text: string | null,
  messageId: string | null,
  media: MediaInfo[],
): QuoteInfo | null {
  const title = titles.length > 0 ? titles.join("\n") : null;
  if (!title && !text && !messageId && media.length === 0) return null;
  return { title, text, message_id: messageId, media };
}

/** First voice transcript in a list, if any. */
function firstTranscript(media: MediaInfo[]): string | null {
  for (const item of media) {
    if (item.transcript) return item.transcript;
  }
  return null;
}

/** text / single media kind / mixed / unknown. */
function classify(texts: string[], media: MediaInfo[]): InboundType {
  if (media.length === 0) return texts.length > 0 ? "text" : "unknown";
  const only = media[0];
  if (texts.length === 0 && media.length === 1 && only) return only.kind;
  return "mixed";
}

/** Map message_state 0/1/2. Anything else is unknown. */
function messageState(state: number | undefined): InboundEvent["state"] {
  if (state === 0) return "new";
  if (state === 1) return "generating";
  if (state === 2) return "finished";
  return "unknown";
}

/** Trimmed string, or null when missing or blank. */
function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Non-negative finite number, or null. */
function finiteBytes(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** Finite integer field, or null. */
function finiteInt(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

/** Decimal plaintext length from file_item.len. */
function parseLen(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

/**
 * Keep a single path segment. Control characters and slashes are removed so
 * the name is safe in Content-Disposition and logs.
 */
export function sanitizeFileName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/["\\]/g, "").trim().slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}
