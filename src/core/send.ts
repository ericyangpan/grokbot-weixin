import type { BridgeApp } from "./app.js";
import { CONTEXT_TOKEN_REJECTED_RET } from "./constants.js";
import { IlinkApiError } from "./ilink.js";
import { logError, logInfo, logWarn, publicError } from "./log.js";
import { createClientId } from "./protocol.js";
import { appNow } from "./app.js";
import { rememberOutbound } from "./history.js";
import { readAllowlist, readContextTokens, readSession } from "./state.js";
import type { SendMessageResp } from "./types.js";

export type SendTextResult =
  | { ok: true; clientId: string; messageId?: string; contextTokenMissing: boolean }
  | { ok: false; error: "not_logged_in" | "not_allowlisted" | "context_token_rejected" | "upstream_failed" };

/**
 * Send a text DM through iLink. Uses the stored context_token when the caller
 * does not pass one. Refuses peers that are not on the allowlist.
 * After iLink accepts the message, a history read or write failure is logged
 * and the result stays successful.
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
  let response: SendMessageResp;
  try {
    response = await app.client.sendText({
      baseUrl: session.baseUrl || app.config.ilinkApiBase,
      token: session.botToken,
      to: input.to,
      text: input.text,
      ...(contextToken ? { contextToken } : {}),
      clientId,
    });
  } catch (err) {
    if (err instanceof IlinkApiError && err.ret === CONTEXT_TOKEN_REJECTED_RET) {
      logError("send_rejected", { to: input.to, ret: err.ret });
      return { ok: false, error: "context_token_rejected" };
    }
    const ret = err instanceof IlinkApiError ? err.ret : null;
    logError("send_failed", { to: input.to, ret });
    return { ok: false, error: "upstream_failed" };
  }
  logInfo("message_sent", { to: input.to, client_id: clientId });
  try {
    await rememberOutbound(app, input.to, {
      text: input.text,
      messageId: response.message_id || clientId,
      atMs: appNow(app),
    });
  } catch (err) {
    logWarn("history_write_failed", { to: input.to, error: publicError(err) });
  }
  return {
    ok: true,
    clientId,
    ...(response.message_id ? { messageId: response.message_id } : {}),
    contextTokenMissing: !contextToken,
  };
}
