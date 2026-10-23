import { AES_BLOCK_BYTES, CDN_DOWNLOAD_TIMEOUT_MS } from "./constants.js";

export interface CdnLocator {
  fullUrl: string | null;
  encryptQueryParam: string | null;
}

/**
 * Pick the CDN GET URL. `full_url` wins when it is public https.
 * Otherwise build `{cdnBase}/download?encrypted_query_param=`, which is what
 * openclaw-weixin does when fallback is enabled. The configured base may be
 * http only for a loopback host so tests can stand in for the CDN.
 */
export function resolveCdnUrl(cdnBase: string, locator: CdnLocator): string | null {
  if (locator.fullUrl && isPublicHttps(locator.fullUrl)) return locator.fullUrl;
  if (!locator.encryptQueryParam) return null;
  const base = cdnBase.trim().replace(/\/+$/, "");
  if (!isAllowedCdnBase(base)) return null;
  return `${base}/download?encrypted_query_param=${encodeURIComponent(locator.encryptQueryParam)}`;
}

/**
 * Download a CDN object, following at most three https redirects.
 * Throws `too_large` or `download_failed`. The error text never includes the URL.
 */
export async function downloadCdn(
  url: string,
  maxCipherBytes: number,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop < 3; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(CDN_DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new Error("download_failed");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("download_failed");
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new Error("download_failed");
      }
      if (!isPublicHttps(next)) throw new Error("download_failed");
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("download_failed");
    }
    return readLimited(response, maxCipherBytes);
  }
  throw new Error("download_failed");
}

/** True when `url` is https and the host is not a local or private address. */
export function isPublicHttps(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password) return false;
  return !isBlockedHost(url.hostname);
}

/** Read the body, rejecting a declared or actual size above `maxBytes`. */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new Error("too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("too_large");
    }
    chunks.push(step.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** https anywhere public, or http aimed at loopback (tests and a local proxy). */
function isAllowedCdnBase(base: string): boolean {
  const url = parseUrl(base);
  if (!url || url.username || url.password) return false;
  if (url.protocol === "https:") return !isBlockedHost(url.hostname);
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** Hosts an inbound full_url must not target. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal") return true;
  if (isLoopbackHost(host)) return true;
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const v4 = ipv4(mapped);
  if (v4) return isPrivateV4(v4);
  if (host.includes(":")) return isPrivateV6(host);
  return false;
}

/** True for 127.0.0.1, ::1, and the name localhost. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = ipv4(host);
  return v4 !== null && v4[0] === 127;
}

/** Parse a dotted IPv4 address. Returns null for names. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    nums.push(value);
  }
  return nums;
}

/** Private, link-local, loopback, and multicast IPv4. */
function isPrivateV4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Unique-local and link-local IPv6, plus the unspecified address. */
function isPrivateV6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  const head = normalized.split(":").find((part) => part.length > 0) ?? "";
  if (head.startsWith("fc") || head.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(head)) return true;
  return false;
}

/** Parse an absolute URL. Returns null when it is not one. */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Ciphertext ceiling: plaintext cap plus one PKCS#7 block. */
export function cipherLimit(maxPlainBytes: number): number {
  return maxPlainBytes + AES_BLOCK_BYTES;
}
