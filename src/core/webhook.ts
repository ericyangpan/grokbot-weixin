import { logWarn, publicError } from "./log.js";
import type { InboundEvent } from "./types.js";

export interface WebhookTarget {
  url: string;
  key: string;
  headerName: string;
  scheme: string;
  maxAttempts: number;
}

export interface WebhookResult {
  ok: boolean;
  attempts: number;
  status?: number;
}

/**
 * POST one event to the Grok Bot routine. Retries network errors, HTTP 429, and 5xx.
 * A 4xx other than 429 is not retried. The response body is discarded.
 */
export async function postWebhook(
  target: WebhookTarget,
  event: InboundEvent,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<WebhookResult> {
  if (!target.url) {
    logWarn("webhook_not_configured", { message_id: event.message_id });
    return { ok: false, attempts: 0 };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.key) {
    headers[target.headerName] = target.scheme ? `${target.scheme} ${target.key}` : target.key;
  }
  const body = JSON.stringify(event);
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= target.maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(target.url, { method: "POST", headers, body });
      await response.body?.cancel();
      lastStatus = response.status;
      if (response.ok) return { ok: true, attempts: attempt, status: response.status };
      const retry = response.status === 429 || response.status >= 500;
      if (!retry || attempt === target.maxAttempts) {
        logWarn("webhook_rejected", { message_id: event.message_id, status: response.status, attempt });
        return { ok: false, attempts: attempt, status: response.status };
      }
    } catch (err) {
      if (attempt === target.maxAttempts) {
        logWarn("webhook_failed", { message_id: event.message_id, attempt, error: publicError(err) });
        return { ok: false, attempts: attempt, ...(lastStatus !== undefined ? { status: lastStatus } : {}) };
      }
    }
    await sleep(backoffMs(attempt));
  }
  return { ok: false, attempts: target.maxAttempts, ...(lastStatus !== undefined ? { status: lastStatus } : {}) };
}

function backoffMs(attempt: number): number {
  if (attempt <= 1) return 200;
  if (attempt === 2) return 800;
  return 2_000;
}
