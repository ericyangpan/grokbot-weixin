import { DurableObject } from "cloudflare:workers";

import { createIlinkClient, type BridgeApp } from "../core/app.js";
import { redactRequestPath } from "../core/history-view.js";
import { handleBridgeRequest } from "../core/http.js";
import { logError, logInfo, publicError } from "../core/log.js";
import { ensureSeeded } from "../core/persist.js";
import { runPollStep } from "../core/poll.js";
import { readSession } from "../core/state.js";
import { DoMediaStore, ensureMediaSchema } from "./do-media.js";
import { DoStorage } from "./do-storage.js";
import { workerConfig, workerSeed, type Env } from "./env.js";
import "./silk-assets.js";

/**
 * One Durable Object owns the single WeChat account.
 * Each alarm runs one getUpdates call, then schedules the next alarm.
 *
 * The class was renamed from AccountDurableObject. Migration v2 moves the
 * existing SQLite database onto this class and drops the hot isolate that
 * a long poll can keep on an older build. The instance name stays "owner".
 */
export class AccountDurableObjectV2 extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      ensureMediaSchema(ctx.storage.sql);
    });
  }

  /** Proxy the bridge HTTP API onto this account. */
  override async fetch(request: Request): Promise<Response> {
    return this.dispatch(request);
  }

  /**
   * History routes call this over RPC. The path is the one the Worker built,
   * not whatever `stub.fetch` would have rewritten it to.
   */
  async handleHttp(request: Request): Promise<Response> {
    return this.dispatch(request);
  }

  private async dispatch(request: Request): Promise<Response> {
    const path = requestPath(request);
    logInfo("do_request", { method: request.method, path: redactRequestPath(path) });
    const app = this.createApp();
    await ensureSeeded(app, workerSeed(this.env));
    await this.ensureAlarm(app);
    return handleBridgeRequest(request, app);
  }

  /** Resume polling when a class reset cleared the alarm but the session is still stored. */
  private async ensureAlarm(app: BridgeApp): Promise<void> {
    const session = await readSession(app.storage);
    if (!session) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  /**
   * One long poll, then reschedule. Errors are caught so a failed poll still
   * arms the next alarm instead of relying on the platform retry alone.
   */
  override async alarm(): Promise<void> {
    const app = this.createApp();
    await ensureSeeded(app, workerSeed(this.env));
    let delay = 5_000;
    let schedule = true;
    try {
      const outcome = await runPollStep(app);
      delay = outcome.nextDelayMs;
      schedule = outcome.schedule;
    } catch (err) {
      logError("poll_crashed", { error: publicError(err) });
    }
    if (schedule) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private createApp(): BridgeApp {
    const config = workerConfig(this.env);
    return {
      config,
      storage: new DoStorage(this.ctx.storage.sql),
      media: new DoMediaStore(this.ctx.storage),
      client: createIlinkClient(config),
      onLoggedIn: async () => {
        await this.ctx.storage.setAlarm(Date.now() + 200);
      },
    };
  }
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
