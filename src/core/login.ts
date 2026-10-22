import { MAX_QR_REFRESH_COUNT, QR_LOGIN_TTL_MS } from "./constants.js";
import type { IlinkClient } from "./ilink.js";
import { logWarn, publicError } from "./log.js";
import type { QrStatusBody, QrStatusName } from "./types.js";

export type LoginPhase = QrStatusName | "failed";

/** One QR login attempt. `qrcode` is the server polling secret and is not shown to clients. */
export interface QrLoginSession {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  apiBaseUrl: string;
  pendingVerifyCode?: string;
  refreshCount: number;
  phase: LoginPhase;
  message: string;
  botToken?: string;
  accountId?: string;
  accountBaseUrl?: string;
  userId?: string;
  alreadyConnected?: boolean;
}

export type QrEffect =
  | { type: "continue" }
  | { type: "needs_verify_code"; retry: boolean }
  | { type: "refresh_qr" }
  | { type: "confirmed" }
  | { type: "already_connected" }
  | { type: "failed"; message: string };

const KNOWN_STATUSES = new Set<QrStatusName>([
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "need_verifycode",
  "verify_code_blocked",
  "binded_redirect",
]);

/** Fetch a QR code and open a login session. The polling host starts at the API base. */
export async function beginQrLogin(
  client: IlinkClient,
  opts: { apiBase: string; botType: string; localTokens: string[]; now: number },
): Promise<QrLoginSession> {
  const qr = await client.getBotQrCode({
    apiBase: opts.apiBase,
    botType: opts.botType,
    localTokens: opts.localTokens,
  });
  return {
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: opts.now,
    apiBaseUrl: opts.apiBase,
    refreshCount: 1,
    phase: "wait",
    message: "Scan this QR code with WeChat",
  };
}

/**
 * Apply one QR status payload. This is a pure state machine so tests can cover
 * redirect, verify-code, expiry, and confirmation without a network.
 */
export function applyQrStatus(session: QrLoginSession, body: QrStatusBody): { session: QrLoginSession; effect: QrEffect } {
  if (!isKnownStatus(body.status)) {
    logWarn("qr_status_unknown", { status: body.status.slice(0, 40) });
    return {
      session: { ...session, phase: "wait", message: "Waiting for scan" },
      effect: { type: "continue" },
    };
  }
  const next: QrLoginSession = { ...session, phase: body.status, message: "" };
  switch (body.status) {
    case "wait":
      next.message = "Waiting for scan";
      return { session: next, effect: { type: "continue" } };
    case "scaned":
      if (next.pendingVerifyCode) next.pendingVerifyCode = undefined;
      next.message = "Scanned. Confirm on your phone";
      return { session: next, effect: { type: "continue" } };
    case "need_verifycode": {
      const retry = Boolean(session.pendingVerifyCode);
      next.pendingVerifyCode = undefined;
      next.message = retry ? "Verification code did not match" : "Enter the code shown in WeChat";
      return { session: next, effect: { type: "needs_verify_code", retry } };
    }
    case "scaned_but_redirect": {
      if (body.redirect_host) {
        next.apiBaseUrl = `https://${body.redirect_host}`;
        next.message = "Continuing on another iLink host";
      } else {
        next.message = "Redirect requested without a host";
      }
      return { session: next, effect: { type: "continue" } };
    }
    case "expired":
    case "verify_code_blocked":
      return expireOrRefresh(next, body.status);
    case "binded_redirect":
      next.alreadyConnected = true;
      next.message = "This bot is already connected";
      return { session: next, effect: { type: "already_connected" } };
    case "confirmed": {
      if (!body.ilink_bot_id || !body.bot_token) {
        next.phase = "failed";
        next.message = "Login confirmed without credentials";
        return { session: next, effect: { type: "failed", message: next.message } };
      }
      next.botToken = body.bot_token;
      next.accountId = body.ilink_bot_id;
      if (body.baseurl) next.accountBaseUrl = body.baseurl;
      if (body.ilink_user_id) next.userId = body.ilink_user_id;
      next.message = "Login confirmed";
      return { session: next, effect: { type: "confirmed" } };
    }
    default:
      return { session: next, effect: { type: "continue" } };
  }
}

/**
 * Poll QR status once. Refreshes the QR when the machine asks for it.
 * Does not write the bot token; the caller persists a confirmed login.
 */
export async function advanceQrLogin(
  client: IlinkClient,
  session: QrLoginSession,
  opts: {
    apiBase: string;
    botType: string;
    localTokens: string[];
    timeoutMs: number;
    now: number;
  },
): Promise<{ session: QrLoginSession; effect: QrEffect }> {
  if (opts.now - session.startedAt > QR_LOGIN_TTL_MS && session.phase !== "confirmed") {
    const message = "QR login expired";
    return { session: { ...session, phase: "failed", message }, effect: { type: "failed", message } };
  }
  if (session.phase === "failed") {
    return { session, effect: { type: "failed", message: session.message } };
  }
  if (session.phase === "need_verifycode" && !session.pendingVerifyCode) {
    return { session, effect: { type: "needs_verify_code", retry: false } };
  }
  const status = await client.getQrStatus({
    apiBase: session.apiBaseUrl,
    qrcode: session.qrcode,
    ...(session.pendingVerifyCode ? { verifyCode: session.pendingVerifyCode } : {}),
    timeoutMs: opts.timeoutMs,
  });
  let applied = applyQrStatus(session, status);
  if (applied.effect.type !== "refresh_qr") return applied;
  try {
    const qr = await client.getBotQrCode({
      apiBase: opts.apiBase,
      botType: opts.botType,
      localTokens: opts.localTokens,
    });
    applied = {
      session: {
        ...applied.session,
        qrcode: qr.qrcode,
        qrcodeUrl: qr.qrcode_img_content,
        startedAt: opts.now,
        apiBaseUrl: opts.apiBase,
        phase: "wait",
        message: "QR code refreshed. Scan the new code",
      },
      effect: { type: "continue" },
    };
  } catch (err) {
    const message = "Could not refresh the QR code";
    logWarn("qr_refresh_failed", { error: publicError(err) });
    applied = {
      session: { ...applied.session, phase: "failed", message },
      effect: { type: "failed", message },
    };
  }
  return applied;
}

function expireOrRefresh(session: QrLoginSession, status: "expired" | "verify_code_blocked"): {
  session: QrLoginSession;
  effect: QrEffect;
} {
  const next: QrLoginSession = { ...session, pendingVerifyCode: undefined };
  next.refreshCount = session.refreshCount + 1;
  if (next.refreshCount > MAX_QR_REFRESH_COUNT) {
    const message = status === "expired" ? "QR code expired too many times" : "Verification blocked";
    next.phase = "failed";
    next.message = message;
    return { session: next, effect: { type: "failed", message } };
  }
  next.message = status === "expired" ? "QR code expired, refreshing" : "Verification blocked, refreshing QR";
  return { session: next, effect: { type: "refresh_qr" } };
}

function isKnownStatus(status: string): status is QrStatusName {
  return KNOWN_STATUSES.has(status as QrStatusName);
}
