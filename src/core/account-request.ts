import { BODY_MAX_BYTES } from "./constants.js";
import { historyAssetName } from "./history-assets.js";

/** Thrown when a forwarded body is larger than the bridge accepts. */
export class AccountBodyTooLarge extends Error {
  constructor() {
    super("body_too_large");
    this.name = "AccountBodyTooLarge";
  }
}

/**
 * Read the body once, before any Durable Object call. The returned bytes can
 * build more than one Request. GET and HEAD do not read a body.
 */
export async function bufferedAccountBody(request: Request): Promise<Uint8Array | null> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || request.body === null) return null;
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > BODY_MAX_BYTES) throw new AccountBodyTooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_MAX_BYTES) throw new AccountBodyTooLarge();
  return bytes;
}

/**
 * Copy path, query, and method onto a fresh absolute Request for the account object.
 * `body` must be the buffer from `bufferedAccountBody`. Each call copies it, so a
 * failed RPC cannot leave the fallback with a used body. The host is a placeholder.
 */
export function requestForAccount(request: Request, body: Uint8Array | null): Request {
  const incoming = new URL(request.url);
  const url = new URL(`${incoming.pathname}${incoming.search}`, "https://bridge.internal");
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  if (body === null) return new Request(url, { method, headers });
  return new Request(url, { method, headers, body: body.slice() });
}

/** History pages are dispatched by an RPC method so a rewritten fetch URL cannot hide them. */
export function isHistoryRoute(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    path === "/history" ||
    path === "/history/session" ||
    historyAssetName(path) !== null ||
    /^\/history\/r\/[0-9a-f]{64}$/.test(path) ||
    /^\/history\/media\/[0-9a-f]{32}$/.test(path)
  );
}
