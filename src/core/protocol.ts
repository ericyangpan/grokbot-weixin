const PRODUCT = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;

/**
 * Encode a semver as the upstream iLink-App-ClientVersion uint32: 0x00MMNNPP.
 * Example from the upstream client: "1.0.11" -> 65547.
 */
export function buildClientVersion(version: string): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = numberAt(parts, 0) & 0xff;
  const minor = numberAt(parts, 1) & 0xff;
  const patch = numberAt(parts, 2) & 0xff;
  return (major << 16) | (minor << 8) | patch;
}

/**
 * Keep a bot_agent value that matches the upstream Name/Version token.
 * Anything else falls back so we never send an unbounded header-adjacent string.
 */
export function sanitizeBotAgent(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim() ?? "";
  if (PRODUCT.test(trimmed) && trimmed.length <= 256) return trimmed;
  return fallback;
}

/** X-WECHAT-UIN: random uint32, decimal string, then standard base64. */
export function randomWechatUin(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = new DataView(bytes.buffer).getUint32(0, false);
  return btoa(String(value));
}

/** Random client id embedded in sendmessage. Not a secret. */
export function createClientId(now: number): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `grokbot-weixin:${now}-${hex}`;
}

function numberAt(parts: number[], index: number): number {
  const value = parts[index];
  return value === undefined || !Number.isFinite(value) ? 0 : value;
}
