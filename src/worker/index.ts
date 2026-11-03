import { AccountBodyTooLarge, bufferedAccountBody, isHistoryRoute, requestForAccount } from "../core/account-request.js";
import { redactRequestPath } from "../core/history-view.js";
import { logInfo, logWarn, publicError } from "../core/log.js";
import { AccountDurableObjectV2 } from "./account-do.js";
import type { Env } from "./env.js";

export { AccountDurableObjectV2 };

type AccountStub = DurableObjectStub & {
  handleHttp(request: Request): Promise<Response>;
  hasAIKey(): Promise<boolean>;
  hasBridgeToken(): Promise<boolean>;
};

/** Route every request to the single account Durable Object. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = redactRequestPath(url.pathname);
    logInfo("request", { method: request.method, path });

    // Safe diagnostic: expose only whether the binding is present, never its value.
    if (request.method === "GET" && url.pathname === "/__envcheck") {
      const stub = env.ACCOUNT.getByName("owner") as AccountStub;
      const doHasKey = await stub.hasAIKey();
      const doHasBridgeToken = await stub.hasBridgeToken();
      return new Response(JSON.stringify({
        ok: true,
        outer_worker_has_ai_key: Boolean((env.AI_API_KEY ?? env.DEEPSEEK_API_KEY)?.trim()),
        durable_object_has_ai_key: doHasKey,
        ai_model: env.AI_MODEL?.trim() || "deepseek-chat",
        ai_api_base: env.AI_API_BASE?.trim() || "https://api.deepseek.com",
        outer_worker_has_bridge_token: Boolean(env.BRIDGE_TOKEN?.trim()),
        durable_object_has_bridge_token: doHasBridgeToken,
      }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

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
