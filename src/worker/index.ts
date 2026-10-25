import { AccountBodyTooLarge, bufferedAccountBody, isHistoryRoute, requestForAccount } from "../core/account-request.js";
import { redactRequestPath } from "../core/history-view.js";
import { logInfo, logWarn, publicError } from "../core/log.js";
import { AccountDurableObjectV2 } from "./account-do.js";
import type { Env } from "./env.js";

export { AccountDurableObjectV2 };

type AccountStub = DurableObjectStub & {
  handleHttp(request: Request): Promise<Response>;
};

/** Route every request to the single account Durable Object. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = redactRequestPath(url.pathname);
    logInfo("request", { method: request.method, path });
    let body: Uint8Array | null;
    try {
      body = await bufferedAccountBody(request);
    } catch (err) {
      if (err instanceof AccountBodyTooLarge) return jsonBodyTooLarge();
      throw err;
    }
    const next = () => requestForAccount(request, body);
    const stub = env.ACCOUNT.getByName("owner") as AccountStub;
    if (!isHistoryRoute(url.pathname)) return stub.fetch(next());
    try {
      return await stub.handleHttp(next());
    } catch (err) {
      // An object still on the previous build has no handleHttp. Fetch still
      // reaches that build's router. `next()` is a new Request with its own body.
      logWarn("history_rpc_failed", { error: publicError(err) });
      return stub.fetch(next());
    }
  },
};

function jsonBodyTooLarge(): Response {
  return new Response(JSON.stringify({ ok: false, error: "body_too_large" }), {
    status: 413,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
