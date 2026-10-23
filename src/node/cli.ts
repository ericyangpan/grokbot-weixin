#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createIlinkClient, type BridgeApp } from "../core/app.js";
import { configFromEnv, seedFromEnv } from "../core/config.js";
import { advanceQrLogin, beginQrLogin } from "../core/login.js";
import { ensureSeeded, persistConfirmedLogin } from "../core/persist.js";
import { qrTerminal } from "../core/qr.js";
import { sendBridgeText } from "../core/send.js";
import { localBotTokens, readAllowlist, readSession, writeAllowlist } from "../core/state.js";
import { loadDotEnv } from "./dotenv.js";
import { FileMediaStore } from "./file-media.js";
import { FileStorage } from "./file-storage.js";
import { runPollLoop } from "./loop.js";
import { startHttpServer } from "./server.js";
import { decodeSilkPcm } from "./silk.js";

const LOGIN_TIMEOUT_MS = 8 * 60_000;

/** CLI entry. Loads .env, then dispatches login, start, send, allow, or export-session. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = configFromEnv(process.env);
  const storage = new FileStorage(stateDir());
  const app: BridgeApp = {
    config,
    storage,
    media: new FileMediaStore(path.join(stateDir(), "media")),
    client: createIlinkClient(config),
    decodeSilk: decodeSilkPcm,
  };
  await ensureSeeded(app, seedFromEnv(process.env));
  const [command, ...rest] = process.argv.slice(2);
  if (command === "login") await login(app, rest);
  else if (command === "start") await start(app);
  else if (command === "send") await send(app, rest);
  else if (command === "allow") await allow(app, rest);
  else if (command === "export-session") await exportSession(app, rest);
  else {
    usage();
    process.exitCode = command ? 1 : 0;
  }
}

function usage(): void {
  output.write(
    [
      "grokbot-weixin login [--timeout-ms N]",
      "grokbot-weixin start",
      "grokbot-weixin send --to <id> --text <text>",
      "grokbot-weixin allow <id>",
      "grokbot-weixin export-session --out <file>",
      "",
    ].join("\n"),
  );
}

async function login(app: BridgeApp, args: string[]): Promise<void> {
  const timeoutMs = numberOption(args, "--timeout-ms") ?? LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let session = await beginQrLogin(app.client, {
    apiBase: app.config.ilinkApiBase,
    botType: app.config.ilinkBotType,
    localTokens: await localBotTokens(app.storage),
    now: Date.now(),
  });
  output.write(`${qrTerminal(session.qrcodeUrl)}\n`);
  output.write("If the QR code does not scan, open this URL and render it as a QR code:\n");
  output.write(`${session.qrcodeUrl}\n`);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) break;
    const advanced = await advanceQrLogin(app.client, session, {
      apiBase: app.config.ilinkApiBase,
      botType: app.config.ilinkBotType,
      localTokens: await localBotTokens(app.storage),
      timeoutMs: Math.min(35_000, remaining),
      now: Date.now(),
    });
    session = advanced.session;
    if (advanced.effect.type === "confirmed") {
      await persistConfirmedLogin(app, session);
      output.write(`Logged in. account=${session.accountId ?? ""} user=${session.userId ?? ""}\n`);
      output.write(`Credentials saved under ${stateDir()} (mode 600). The bot token was not printed.\n`);
      return;
    }
    if (advanced.effect.type === "already_connected") {
      const existing = await readSession(app.storage);
      output.write(
        existing
          ? "Already connected. Existing credentials were kept.\n"
          : "The server said this bot is already bound, but no local credentials were found.\n",
      );
      process.exitCode = existing ? 0 : 1;
      return;
    }
    if (advanced.effect.type === "failed") {
      output.write(`${session.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (advanced.effect.type === "needs_verify_code") {
      const code = await readLine(session.message + ": ");
      session = { ...session, pendingVerifyCode: code, phase: "need_verifycode" };
      continue;
    }
    if (session.qrcodeUrl && advanced.effect.type === "continue" && session.phase === "wait" && session.message.includes("refreshed")) {
      output.write(`${qrTerminal(session.qrcodeUrl)}\n${session.qrcodeUrl}\n`);
    }
  }
  output.write("Login timed out.\n");
  process.exitCode = 1;
}

async function start(app: BridgeApp): Promise<void> {
  const server = await startHttpServer(app, app.config.host, app.config.port);
  output.write(`listening on http://${app.config.host}:${app.config.port}\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await runPollLoop(app, controller.signal);
  server.close();
}

async function send(app: BridgeApp, args: string[]): Promise<void> {
  const to = option(args, "--to");
  const text = option(args, "--text");
  if (!to || !text) {
    usage();
    process.exitCode = 1;
    return;
  }
  const result = await sendBridgeText(app, { to, text });
  if (!result.ok) {
    output.write(`send failed: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  output.write(`sent client_id=${result.clientId}\n`);
}

async function allow(app: BridgeApp, args: string[]): Promise<void> {
  const id = args[0];
  if (!id || id.startsWith("-")) {
    usage();
    process.exitCode = 1;
    return;
  }
  const list = await readAllowlist(app.storage);
  if (!list.includes(id)) list.push(id);
  await writeAllowlist(app.storage, list);
  output.write(`allowlist count=${list.length}\n`);
}

async function exportSession(app: BridgeApp, args: string[]): Promise<void> {
  const out = option(args, "--out");
  if (!out) {
    output.write("Refusing to print the bot token. Pass --out <file>.\n");
    process.exitCode = 1;
    return;
  }
  const session = await readSession(app.storage);
  if (!session) {
    output.write("Not logged in.\n");
    process.exitCode = 1;
    return;
  }
  const payload = {
    bot_token: session.botToken,
    account_id: session.accountId,
    ...(session.baseUrl ? { base_url: session.baseUrl } : {}),
    ...(session.userId ? { user_id: session.userId } : {}),
  };
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  output.write(`Wrote ${out} (mode 600). Upload it with the admin endpoint, then delete the file.\n`);
}

function stateDir(): string {
  return process.env.GROKBOT_STATE_DIR?.trim() || path.join(homedir(), ".grokbot-weixin");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numberOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const line = await rl.question(prompt);
    return line.trim();
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.name : "error";
  output.write(`grokbot-weixin failed: ${message}\n`);
  process.exitCode = 1;
});
