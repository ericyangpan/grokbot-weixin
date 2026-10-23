import { DurableObject } from "cloudflare:workers";

import { createIlinkClient, type BridgeApp } from "../core/app.js";
import { handleBridgeRequest } from "../core/http.js";
import { logError, publicError } from "../core/log.js";
import { ensureSeeded } from "../core/persist.js";
import { runPollStep } from "../core/poll.js";
import { DoMediaStore, ensureMediaSchema } from "./do-media.js";
import { DoStorage } from "./do-storage.js";
import { workerConfig, workerSeed, type Env } from "./env.js";

/**
 * One Durable Object owns the single WeChat account.
 * Each alarm runs one getUpdates call, then schedules the next alarm.
 */
export class AccountDurableObject extends DurableObject<Env> {
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
    const app = this.createApp();
    await ensureSeeded(app, workerSeed(this.env));
    return handleBridgeRequest(request, app);
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
