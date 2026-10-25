import { isHistoryRoute, requestForAccount } from "../core/account-request.js";
import { redactRequestPath } from "../core/history-view.js";
import { logInfo, logWarn, publicError } from "../core/log.js";
import { AccountDurableObject } from "./account-do.js";
import type { Env } from "./env.js";

export { AccountDurableObject };

type AccountStub = DurableObjectStub & {
  handleHttp(request: Request): Promise<Response>;
};

/** Route every request to the single account Durable Object. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = redactRequestPath(url.pathname);
    logInfo("request", { method: request.method, path });
    const forwarded = requestForAccount(request);
    const stub = env.ACCOUNT.getByName("owner") as AccountStub;
    if (!isHistoryRoute(url.pathname)) return stub.fetch(forwarded);
    try {
      return await stub.handleHttp(forwarded);
    } catch (err) {
      // An object still on the previous build has no handleHttp. Fetch still
      // reaches that build's router once the path is explicit.
      logWarn("history_rpc_failed", { error: publicError(err) });
      return stub.fetch(forwarded);
    }
  },
};
