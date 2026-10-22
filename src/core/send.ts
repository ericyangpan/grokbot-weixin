import type { BridgeApp } from "./app.js";
import { CONTEXT_TOKEN_REJECTED_RET } from "./constants.js";
import { IlinkApiError } from "./ilink.js";
import { logError, logInfo } from "./log.js";
import { createClientId } from "./protocol.js";
import { appNow } from "./app.js";
import { readAllowlist, readContextTokens, readSession } from "./state.js";

export type SendTextResult =
  | { ok: true; clientId: string; messageId?: string; contextTokenMissing: boolean }
  | { ok: false; error: "not_logged_in" | "not_allowlisted" | "context_token_rejected" | "upstream_failed" };

/**
 * Send a text DM through iLink. Uses the stored context_token when the caller
 * does not pass one. Refuses peers that are not on the allowlist.
 */
export async function sendBridgeText(
  app: BridgeApp,
  input: { to: string; text: string; contextToken?: string; accountId?: string },
): Promise<SendTextResult> {
  const session = await readSession(app.storage);
  if (!session) return { ok: false, error: "not_logged_in" };
  if (input.accountId && input.accountId !== session.accountId) {
    return { ok: false, error: "not_allowlisted" };
  }
  const allow = await readAllowlist(app.storage);
  if (!allow.includes(input.to)) return { ok: false, error: "not_allowlisted" };
  const stored = (await readContextTokens(app.storage))[input.to];
  const contextToken = input.contextToken || stored;
  const clientId = createClientId(appNow(app));
  try {
    const response = await app.client.sendText({
      baseUrl: session.baseUrl || app.config.ilinkApiBase,
      token: session.botToken,
      to: input.to,
      text: input.text,
      ...(contextToken ? { contextToken } : {}),
      clientId,
    });
    logInfo("message_sent", { to: input.to, client_id: clientId });
    return {
      ok: true,
      clientId,
      ...(response.message_id ? { messageId: response.message_id } : {}),
      contextTokenMissing: !contextToken,
    };
  } catch (err) {
    if (err instanceof IlinkApiError && err.ret === CONTEXT_TOKEN_REJECTED_RET) {
      logError("send_rejected", { to: input.to, ret: err.ret });
      return { ok: false, error: "context_token_rejected" };
    }
    const ret = err instanceof IlinkApiError ? err.ret : null;
    logError("send_failed", { to: input.to, ret });
    return { ok: false, error: "upstream_failed" };
  }
}
