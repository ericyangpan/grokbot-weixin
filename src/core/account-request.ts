/**
 * Copy path, query, and method onto a fresh absolute Request for the account object.
 * The object routes on `request.url`. Rebuilding it keeps that path equal to the
 * one the Worker entrypoint already logged. The host is a placeholder.
 */
export function requestForAccount(request: Request): Request {
  const incoming = new URL(request.url);
  const url = new URL(`${incoming.pathname}${incoming.search}`, "https://bridge.internal");
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  if (method === "GET" || method === "HEAD" || request.body === null) {
    return new Request(url, { method, headers });
  }
  const init: RequestInit & { duplex: "half" } = { method, headers, body: request.body, duplex: "half" };
  return new Request(url, init);
}

/** History pages are dispatched by an RPC method so a rewritten fetch URL cannot hide them. */
export function isHistoryRoute(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/history" || path === "/history/session" || /^\/history\/r\/[0-9a-f]{64}$/.test(path);
}
