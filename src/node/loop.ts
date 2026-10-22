import type { BridgeApp } from "../core/app.js";
import { logInfo } from "../core/log.js";
import { runPollStep } from "../core/poll.js";
import { readSession } from "../core/state.js";

/** Poll until `signal` aborts. Notifies iLink when the process is stopping. */
export async function runPollLoop(app: BridgeApp, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const outcome = await runPollStep(app);
    await sleep(outcome.nextDelayMs, signal);
  }
  const session = await readSession(app.storage);
  if (!session) return;
  try {
    await app.client.notifyStop({
      baseUrl: session.baseUrl || app.config.ilinkApiBase,
      token: session.botToken,
    });
    logInfo("notify_stop");
  } catch {
    logInfo("notify_stop_failed");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
