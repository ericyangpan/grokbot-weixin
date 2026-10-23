import { appFetch, appNow, type BridgeApp } from "./app.js";
import { decryptAes128Ecb } from "./aes.js";
import { cipherLimit, downloadCdn, resolveCdnUrl } from "./cdn.js";
import { AES_BLOCK_BYTES } from "./constants.js";
import { logInfo, logWarn } from "./log.js";
import type { MediaDownload, InboundBuild } from "./normalize.js";
import { sanitizeFileName } from "./normalize.js";
import type { MediaObject } from "./media-store.js";
import type { InboundEvent, MediaErrorCode, MediaKind } from "./types.js";

const SILK_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000];

const FILE_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Download and decrypt every planned attachment, then fill `url` on the event.
 * One failure does not drop the rest of the message. CDN parameters are not logged.
 */
export async function resolveInboundMedia(app: BridgeApp, built: InboundBuild): Promise<InboundEvent> {
  for (const download of built.downloads) {
    await resolveOne(app, download);
  }
  return built.event;
}

/**
 * Load one unexpired object for GET /media/:id. Expired rows are deleted.
 * Returns null for a bad id, a miss, or an expiry.
 */
export async function loadStoredMedia(app: BridgeApp, id: string): Promise<MediaObject | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const now = appNow(app);
  await app.media.deleteExpired(now);
  const object = await app.media.get(id);
  if (!object || object.expiresAtMs <= now) {
    if (object) await app.media.delete(id);
    return null;
  }
  return object;
}

/** Delete expired media. Storage errors are logged and swallowed. */
export async function sweepMedia(app: BridgeApp): Promise<void> {
  try {
    await app.media.deleteExpired(appNow(app));
  } catch (err) {
    logWarn("media_sweep_failed", { error: err instanceof Error ? err.name : "error" });
  }
}

/** Fetch, decrypt, and store one attachment. */
async function resolveOne(app: BridgeApp, download: MediaDownload): Promise<void> {
  const target = download.target;
  if (overDeclaredLimit(download, app.config.mediaMaxBytes)) {
    target.error = "too_large";
    logInfo("media_skipped", { kind: download.kind, error: "too_large" });
    return;
  }
  const url = resolveCdnUrl(app.config.ilinkCdnBase, {
    fullUrl: download.fullUrl,
    encryptQueryParam: download.encryptQueryParam,
  });
  if (!url) {
    target.error = "download_failed";
    logWarn("media_failed", { kind: download.kind, error: "download_failed" });
    return;
  }
  try {
    const downloaded = await downloadCdn(url, cipherLimit(app.config.mediaMaxBytes), appFetch(app));
    const plain = download.plain ? downloaded : await decryptAes128Ecb(downloaded, download.aesKey ?? new Uint8Array());
    if (plain.byteLength > app.config.mediaMaxBytes) throw new Error("too_large");
    const prepared = await materialize(app, download, plain);
    if (prepared.bytes.byteLength > app.config.mediaMaxBytes) throw new Error("too_large");
    await storePrepared(app, download, prepared);
  } catch (err) {
    target.error = mediaErrorCode(err);
    logWarn("media_failed", { kind: download.kind, error: target.error });
  }
}

/** True when the sender's declared size cannot fit under the cap. */
function overDeclaredLimit(download: MediaDownload, maxBytes: number): boolean {
  if (download.declaredBytes === null) return false;
  const ceiling = download.declaredIsCipher ? maxBytes + AES_BLOCK_BYTES : maxBytes;
  return download.declaredBytes > ceiling;
}

/** Write plaintext and point the webhook slot at it. */
async function storePrepared(
  app: BridgeApp,
  download: MediaDownload,
  prepared: { bytes: Uint8Array; mime: string; fileName: string },
): Promise<void> {
  const target = download.target;
  const base = app.config.bridgePublicUrl.replace(/\/+$/, "");
  target.mime_type = prepared.mime;
  target.size = prepared.bytes.byteLength;
  target.file_name = prepared.fileName;
  if (!base) {
    target.error = "public_url_missing";
    logInfo("media_skipped", { kind: download.kind, error: "public_url_missing" });
    return;
  }
  const now = appNow(app);
  const record = await app.media.put({
    bytes: prepared.bytes,
    mimeType: prepared.mime,
    fileName: prepared.fileName,
    expiresAtMs: now + app.config.mediaTtlMs,
    createdAtMs: now,
    maxTotalBytes: app.config.mediaMaxTotalBytes,
  });
  target.url = `${base}/media/${record.id}`;
  target.expires_at_ms = record.expiresAtMs;
  target.size = record.size;
  target.error = null;
  logInfo("media_stored", { kind: download.kind, bytes: record.size, mime: record.mimeType });
}

/** Choose the bytes, mime, and file name the routine should see. */
async function materialize(
  app: BridgeApp,
  download: MediaDownload,
  plain: Uint8Array,
): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
  if (download.kind === "image") {
    const mime = sniffImageMime(plain);
    return { bytes: plain, mime, fileName: `image.${extensionFor(mime, "bin")}` };
  }
  if (download.kind === "video") {
    const mime = sniffVideoMime(plain);
    return { bytes: plain, mime, fileName: `video.${extensionFor(mime, "mp4")}` };
  }
  if (download.kind === "file") {
    const fileName = sanitizeFileName(download.target.file_name, "file.bin");
    return { bytes: plain, mime: mimeFromFileName(fileName), fileName };
  }
  return materializeVoice(app, download, plain);
}

/**
 * Voice becomes wav when it is PCM, or when a SILK decoder is installed and
 * succeeds. The Worker does not install one. MP3 is passed through. Anything
 * else is stored raw, usually as audio/silk.
 */
async function materializeVoice(
  app: BridgeApp,
  download: MediaDownload,
  plain: Uint8Array,
): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
  if (download.encodeType === 7 || (download.encodeType === null && looksLikeMp3(plain) && !looksLikeSilk(plain))) {
    return { bytes: plain, mime: "audio/mpeg", fileName: "voice.mp3" };
  }
  if (download.encodeType === 1) {
    const rate = download.sampleRate && download.sampleRate > 0 ? download.sampleRate : 24_000;
    return { bytes: pcmToWav(plain, rate), mime: "audio/wav", fileName: "voice.wav" };
  }
  if (download.encodeType === 5) return { bytes: plain, mime: "audio/amr", fileName: "voice.amr" };
  if (download.encodeType === 8) return { bytes: plain, mime: "audio/ogg", fileName: "voice.ogg" };
  const silkLikely = download.encodeType === null || download.encodeType === 6 || looksLikeSilk(plain);
  if (silkLikely && app.config.mediaTranscodeVoice && app.decodeSilk) {
    const rate = silkRate(download.sampleRate);
    const pcm = await app.decodeSilk(plain, rate);
    if (pcm && pcm.byteLength > 0) {
      const wav = pcmToWav(pcm, rate);
      if (wav.byteLength <= app.config.mediaMaxBytes) {
        return { bytes: wav, mime: "audio/wav", fileName: "voice.wav" };
      }
    }
  }
  if (download.encodeType === 6 || download.encodeType === null || looksLikeSilk(plain)) {
    return { bytes: plain, mime: "audio/silk", fileName: "voice.silk" };
  }
  return { bytes: plain, mime: "application/octet-stream", fileName: "voice.bin" };
}

/** Wrap mono 16-bit little-endian PCM in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const data = pcm.byteLength % 2 === 0 ? pcm : pcm.subarray(0, pcm.byteLength - 1);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + data.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, data.byteLength, true);
  const out = new Uint8Array(44 + data.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(data, 44);
  return out;
}

/** JPEG, PNG, GIF, or WEBP. Anything else is octet-stream. */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** MP4 when `ftyp` is present, WebM when the EBML header is present, otherwise MP4. */
export function sniffVideoMime(bytes: Uint8Array): string {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return "video/mp4";
}

/** Best-effort mime from a file extension. Unknown names are octet-stream. */
export function mimeFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return FILE_MIME[ext] ?? "application/octet-stream";
}

/** Content-Disposition that stays on one line. Images, audio, and video are inline. */
export function contentDisposition(mime: string, fileName: string): string {
  const inline = mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/");
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Map a thrown code onto the webhook error field. */
function mediaErrorCode(err: unknown): MediaErrorCode {
  const message = err instanceof Error ? err.message : "";
  if (
    message === "too_large" ||
    message === "download_failed" ||
    message === "decrypt_failed" ||
    message === "storage_failed"
  ) {
    return message;
  }
  if (message === "bad_padding" || message === "bad_ciphertext" || message === "bad_key") return "decrypt_failed";
  return "download_failed";
}

/** Sample rate silk-wasm accepts. WeChat voice is 24000 Hz when the field is absent. */
function silkRate(value: number | null): number {
  if (value !== null && SILK_RATES.includes(value)) return value;
  return 24_000;
}

/** ID3 tag or a frame sync. */
function looksLikeMp3(bytes: Uint8Array): boolean {
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  if (bytes.length >= 3 && b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true;
  return bytes.length >= 2 && b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0;
}

/** WeChat SILK often starts with `#!SILK_V3` or a one-byte prefix plus that magic. */
function looksLikeSilk(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, Math.min(bytes.length, 16)).includes("#!SILK");
}

/** File extension for a sniffed mime. */
function extensionFor(mime: string, fallback: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/silk") return "silk";
  return fallback;
}

/** ASCII slice used only for magic-byte checks. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}

/** Write a 4-character ASCII tag into a WAV header. */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
