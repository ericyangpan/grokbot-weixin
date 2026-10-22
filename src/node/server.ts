import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BridgeApp } from "../core/app.js";
import { BODY_MAX_BYTES } from "../core/constants.js";
import { handleBridgeRequest } from "../core/http.js";
import { logError, publicError } from "../core/log.js";

/** Serve the bridge HTTP API on the configured host and port. */
export function startHttpServer(app: BridgeApp, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    void handleNodeRequest(app, host, port, req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handleNodeRequest(
  app: BridgeApp,
  host: string,
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const request = await toRequest(req, host, port);
    const response = await handleBridgeRequest(request, app);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    res.end(bytes);
  } catch (err) {
    const code = err instanceof Error && err.message === "body_too_large" ? 413 : 500;
    if (code === 500) logError("http_adapter_failed", { error: publicError(err) });
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: code === 413 ? "body_too_large" : "internal" }));
  }
}

async function toRequest(req: IncomingMessage, host: string, port: number): Promise<Request> {
  const hostHeader = req.headers.host ?? `${host}:${port}`;
  const url = `http://${hostHeader}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const body = await readBody(req);
  return new Request(url, { method, headers, body });
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > BODY_MAX_BYTES) {
      req.destroy();
      throw new Error("body_too_large");
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
