import type { BridgeApp } from "./app.js";
import { appNow } from "./app.js";
import { KEYS } from "./keys.js";
import type { QrLoginSession } from "./login.js";
import { readAllowlist, readSession, writeAllowlist, writeSession } from "./state.js";

/**
 * Store a confirmed QR login. Pins the scanner when the allowlist is empty
 * and pinning is enabled. Does not log the bot token.
 */
export async function persistConfirmedLogin(app: BridgeApp, session: QrLoginSession): Promise<void> {
  if (!session.botToken || !session.accountId) {
    throw new Error("confirmed login is missing credentials");
  }
  await writeSession(app.storage, {
    botToken: session.botToken,
    accountId: session.accountId,
    ...(session.accountBaseUrl ? { baseUrl: session.accountBaseUrl } : {}),
    ...(session.userId ? { userId: session.userId } : {}),
    savedAt: appNow(app),
  });
  if (app.config.allowFrom.length === 0 && app.config.pinFirstSender && session.userId) {
    const allow = await readAllowlist(app.storage);
    if (allow.length === 0) await writeAllowlist(app.storage, [session.userId]);
  }
  await app.storage.delete(KEYS.login);
  await app.storage.delete(KEYS.notifyStarted);
  await app.storage.delete(KEYS.pauseUntil);
  await app.onLoggedIn?.();
}

/**
 * Seed an empty store from environment credentials and apply an env allowlist.
 * An existing session is kept. A non-empty WEIXIN_ALLOW_FROM replaces the stored list.
 */
export async function ensureSeeded(
  app: BridgeApp,
  seed: { botToken?: string; accountId?: string; baseUrl?: string; userId?: string },
): Promise<void> {
  const existing = await readSession(app.storage);
  if (!existing && seed.botToken && seed.accountId) {
    await writeSession(app.storage, {
      botToken: seed.botToken,
      accountId: seed.accountId,
      ...(seed.baseUrl ? { baseUrl: seed.baseUrl } : {}),
      ...(seed.userId ? { userId: seed.userId } : {}),
      savedAt: appNow(app),
    });
    await app.onLoggedIn?.();
  }
  if (app.config.allowFrom.length > 0) {
    const current = await readAllowlist(app.storage);
    if (!sameList(current, app.config.allowFrom)) {
      await writeAllowlist(app.storage, app.config.allowFrom);
    }
    return;
  }
  const allow = await readAllowlist(app.storage);
  if (allow.length === 0 && app.config.pinFirstSender && seed.userId) {
    await writeAllowlist(app.storage, [seed.userId]);
  }
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
