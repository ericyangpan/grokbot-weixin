import { logInfo } from "../core/log.js";
import { AccountDurableObject } from "./account-do.js";
import type { Env } from "./env.js";

export { AccountDurableObject };

/** Route every request to the single account Durable Object. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/media\/[0-9a-f]{32}$/, "/media/:id");
    logInfo("request", { method: request.method, path });
    const stub = env.ACCOUNT.getByName("owner");
    return stub.fetch(request);
  },
};
