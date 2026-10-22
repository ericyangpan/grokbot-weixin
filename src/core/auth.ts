const TOKEN_MAX = 512;

/**
 * Compare two strings without leaking the expected value through an early length check.
 * Both inputs are hashed first so the XOR loop length is constant.
 */
export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  if (left.length > TOKEN_MAX || right.length > TOKEN_MAX) return false;
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }
  return diff === 0;
}

/** Read one cookie value. Returns null when the cookie is absent. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Authorize a bridge request. Accepts `Authorization: Bearer <token>` or the
 * HttpOnly `gb_session` cookie set by the login form. An empty expected token
 * rejects every caller.
 */
export async function isAuthorized(request: Request, expected: string): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get("Authorization");
  let presented: string | null = null;
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    presented = match?.[1] ?? null;
    if (!presented) return false;
  } else {
    presented = readCookie(request.headers.get("Cookie"), "gb_session");
  }
  if (!presented) return false;
  return timingSafeEqual(presented, expected);
}

/** True for a single-line visible id. WeChat ids are a subset; the exact alphabet is not specified. */
export function isPeerId(id: string): boolean {
  return /^[\x21-\x7E]{1,160}$/.test(id);
}
