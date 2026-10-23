import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleBridgeRequest } from "../src/core/http.js";
import { boundHistory, historyStorageKey, rememberOutbound } from "../src/core/history.js";
import { runPollStep } from "../src/core/poll.js";
import { sendBridgeText } from "../src/core/send.js";
import { writeAllowlist, writeContextTokens, writeSession } from "../src/core/state.js";
import type { HistoryTurn } from "../src/core/types.js";
import { FileStorage } from "../src/node/file-storage.js";
import { makeApp, mockFetch, type CapturedRequest, MemoryStorage } from "./support.js";
import type { BridgeApp } from "../src/core/app.js";

const NOW = 1_700_000_000_000;
const QUESTION = "what time is the dinner? if you don't know I'll put 18:30";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("history bounds", () => {
  it("drops expired and overflow turns, oldest first, and shortens a single long turn", () => {
    const limits = { maxTurns: 2, maxChars: 10, ttlMs: 1_000 };
    const turns = [turn("user", "one", NOW - 2_000), turn("assistant", "two", NOW - 500), turn("user", "three", NOW)];
    expect(boundHistory(turns, NOW, limits).map((item) => item.text)).toEqual(["two", "three"]);
    const tight = boundHistory([turn("user", "abcdefghijk", NOW)], NOW, { maxTurns: 2, maxChars: 4, ttlMs: 1_000 });
    expect(tight.map((item) => item.text)).toEqual(["abcd"]);
    expect(boundHistory(turns, NOW, { maxTurns: 0, maxChars: 10, ttlMs: 1_000 })).toEqual([]);
  });
});

describe("conversation history", () => {
  it("gives the routine the assistant question before a short reply", async () => {
    const mock = mockFetch((request) => answer(request, () => ({
      ret: 0,
      get_updates_buf: "c1",
      msgs: [textMessage("2", "[OK]")],
    })));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    const sent = await sendBridgeText(app, { to: "owner@im.wechat", text: QUESTION });
    expect(sent.ok).toBe(true);
    await runPollStep(app);
    const event = webhookEvent(mock.calls);
    expect(event.text).toBe("[OK]");
    expect(event.history).toEqual([
      {
        role: "assistant",
        text: QUESTION,
        type: "text",
        media: [],
        quote: null,
        at_ms: NOW,
        message_id: "m-1",
      },
    ]);
    expect(JSON.stringify(event.history)).not.toContain("url");
    const stored = JSON.parse((await app.storage.get(await historyStorageKey("owner@im.wechat"))) ?? "[]") as HistoryTurn[];
    expect(stored.map((item) => item.role)).toEqual(["assistant", "user"]);
    expect(stored[1]?.text).toBe("[OK]");
  });

  it("records a proactive send and keeps media summaries without urls", async () => {
    const seen: Record<string, unknown>[] = [];
    const mock = mockFetch((request) => answer(request, () => {
      const body = JSON.parse(request.body || "{}") as { get_updates_buf?: string };
      if (body.get_updates_buf === "c-voice") {
        return { ret: 0, get_updates_buf: "c-next", msgs: [textMessage("4", "thanks", NOW + 1_000)] };
      }
      return {
        ret: 0,
        get_updates_buf: "c-voice",
        msgs: [
          {
            message_id: "3",
            from_user_id: "owner@im.wechat",
            create_time_ms: NOW,
            message_type: 1,
            message_state: 2,
            context_token: "ctx-1",
            item_list: [
              {
                type: 1,
                text_item: { text: "yes" },
                ref_msg: {
                  title: "dinner?",
                  svr_id: "50",
                  message_item: { type: 1, text_item: { text: "what time?" } },
                },
              },
              { type: 3, voice_item: { text: "seven thirty", playtime: 1200 } },
            ],
          },
        ],
      };
    }));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    const response = await handleBridgeRequest(sendRequest({ text: "heading over" }), app);
    expect(response.status).toBe(200);
    await runPollStep(app);
    await runPollStep(app);
    for (const call of mock.calls) {
      if (call.url.hostname === "routine.example") seen.push(JSON.parse(call.body) as Record<string, unknown>);
    }
    const first = seen[0] as { history: HistoryTurn[]; text: string; type: string };
    const second = seen[1] as { history: HistoryTurn[]; text: string };
    expect(first.history.map((item) => item.text)).toEqual(["heading over"]);
    expect(first.text).toBe("yes");
    expect(first.type).toBe("mixed");
    expect(second.text).toBe("thanks");
    expect(second.history.map((item) => item.role)).toEqual(["assistant", "user"]);
    const user = second.history[1];
    expect(user?.quote).toEqual({
      title: "dinner?",
      text: "what time?",
      message_id: "50",
      media: [],
    });
    expect(user?.media).toEqual([{ kind: "voice", file_name: null, transcript: "seven thirty" }]);
    expect(JSON.stringify(second.history)).not.toContain("https://");
  });

  it("forgets old turns and trims to the configured count and characters", async () => {
    const texts = ["alpha-message", "beta-message", "gamma-message"];
    let index = 0;
    const mock = mockFetch((request) => answer(request, () => {
      const current = texts[index] ?? "gamma-message";
      const id = String(index + 1);
      index += 1;
      return {
        ret: 0,
        get_updates_buf: `c${id}`,
        msgs: [textMessage(id, current, NOW + index * 1_000)],
      };
    }));
    const app = makeApp(mock.fetchImpl, {
      allowFrom: ["owner@im.wechat"],
      sendTyping: false,
      historyMaxTurns: 2,
      historyMaxChars: 20,
    });
    await seed(app);
    await runPollStep(app);
    await runPollStep(app);
    await runPollStep(app);
    const events = webhooks(mock.calls);
    expect(events[0]?.history).toEqual([]);
    expect(events[2]?.history.map((item) => item.text)).toEqual(["beta-message"]);
    app.now = () => NOW + 25 * 60 * 60_000;
    index = 3;
    await runPollStep(app);
    const last = webhooks(mock.calls).at(-1);
    expect(last?.text).toBe("gamma-message");
    expect(last?.history).toEqual([]);
  });

  it("clears history on /new and /reset without forwarding them", async () => {
    let step = 0;
    const bodies = [
      [textMessage("1", "remember this")],
      [textMessage("2", " /Reset ")],
      [textMessage("3", "/new")],
      [textMessage("4", "after")],
    ];
    const mock = mockFetch((request) => answer(request, () => {
      const msgs = bodies[step] ?? [];
      step += 1;
      return { ret: 0, get_updates_buf: `c${step}`, msgs };
    }));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    await runPollStep(app);
    await runPollStep(app);
    await runPollStep(app);
    await runPollStep(app);
    const events = webhooks(mock.calls);
    expect(events.map((event) => event.text)).toEqual(["remember this", "after"]);
    expect(events[1]?.history).toEqual([]);
    const sent = mock.calls.filter((call) => call.url.pathname === "/ilink/bot/sendmessage");
    expect(sent).toHaveLength(2);
    expect(sent.every((call) => call.body.includes("Started a new conversation."))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Started a new conversation.");
    expect(await app.storage.get(await historyStorageKey("owner@im.wechat"))).toContain("after");
  });

  it("forwards /reset when history reset is disabled", async () => {
    const mock = mockFetch((request) => answer(request, () => ({
      ret: 0,
      get_updates_buf: "c1",
      msgs: [textMessage("1", "/reset")],
    })));
    const app = makeApp(mock.fetchImpl, {
      allowFrom: ["owner@im.wechat"],
      sendTyping: false,
      historyReset: false,
    });
    await seed(app);
    await runPollStep(app);
    expect(webhooks(mock.calls).map((event) => event.text)).toEqual(["/reset"]);
    expect(mock.calls.some((call) => call.url.pathname === "/ilink/bot/sendmessage")).toBe(false);
  });

  it("does not record a rejected send, and keeps peers apart", async () => {
    const mock = mockFetch((request) => {
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: -2 }) };
      }
      return answer(request, () => ({ ret: 0, get_updates_buf: "c1", msgs: [] }));
    });
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat", "second@im.wechat"], sendTyping: false });
    await seed(app);
    await writeAllowlist(app.storage, ["owner@im.wechat", "second@im.wechat"]);
    const rejected = await sendBridgeText(app, { to: "owner@im.wechat", text: "nope" });
    expect(rejected).toMatchObject({ ok: false, error: "context_token_rejected" });
    expect(await app.storage.get(await historyStorageKey("owner@im.wechat"))).toBeNull();
    await rememberOutbound(app, "second@im.wechat", { text: "only second", messageId: "s1", atMs: NOW });
    expect(await app.storage.get(await historyStorageKey("owner@im.wechat"))).toBeNull();
    expect(await app.storage.get(await historyStorageKey("second@im.wechat"))).toContain("only second");
  });

  it("serializes writes and stores under a hashed file name", async () => {
    const storage = new SlowStorage();
    const app = makeApp(async () => new Response(""), {}, storage);
    await Promise.all([
      rememberOutbound(app, "owner@im.wechat", { text: "one", messageId: "1", atMs: NOW }),
      rememberOutbound(app, "owner@im.wechat", { text: "two", messageId: "2", atMs: NOW + 1 }),
    ]);
    const saved = JSON.parse((await storage.get(await historyStorageKey("owner@im.wechat"))) ?? "[]") as HistoryTurn[];
    expect(saved.map((item) => item.text).sort()).toEqual(["one", "two"]);

    const dir = await mkdtemp(path.join(tmpdir(), "grokbot-history-"));
    dirs.push(dir);
    const files = new FileStorage(dir);
    const fileApp = makeApp(async () => new Response(""), {}, files);
    const peer = "wei xin@im.wechat";
    await rememberOutbound(fileApp, peer, { text: "on disk", messageId: "9", atMs: NOW });
    const key = await historyStorageKey(peer);
    expect(key).toMatch(/^h_[0-9a-f]{40}$/);
    expect(await files.get(key)).toContain("on disk");
  });

  it("returns the send id when history storage throws and does not replace the transcript", async () => {
    const reply = "do-not-double-send";
    for (const mode of ["get", "set"] as const) {
      const storage = new FlakyStorage();
      const mock = mockFetch((request) => answer(request, () => ({ ret: 0, msgs: [] })));
      const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false }, storage);
      await seed(app);
      const key = await historyStorageKey("owner@im.wechat");
      const saved = JSON.stringify([turn("assistant", "earlier question", NOW - 1_000)]);
      storage.map.set(key, saved);
      storage.fail = mode;
      const logs = await captureLogs(async () => {
        const response = await handleBridgeRequest(sendRequest({ text: reply }), app);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, message_id: "m-1" });
      });
      expect(mock.calls.filter((call) => call.url.pathname === "/ilink/bot/sendmessage")).toHaveLength(1);
      expect(storage.map.get(key)).toBe(saved);
      expect(logs).toContain(mode === "get" ? "history_read_failed" : "history_write_failed");
      expect(logs).not.toContain(reply);
      expect(logs).not.toContain("send_failed");
    }
  });

  it("still delivers an inbound webhook once when history storage throws", async () => {
    const storage = new FlakyStorage();
    const mock = mockFetch((request) => answer(request, () => ({
      ret: 0,
      get_updates_buf: "c1",
      msgs: [textMessage("9", "inbound-once")],
    })));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false }, storage);
    await seed(app);
    const key = await historyStorageKey("owner@im.wechat");
    const saved = JSON.stringify([turn("assistant", "earlier question", NOW - 1_000)]);
    storage.map.set(key, saved);
    storage.fail = "get";
    const readLogs = await captureLogs(async () => {
      await runPollStep(app);
      await runPollStep(app);
    });
    const readEvents = webhooks(mock.calls);
    expect(readEvents).toHaveLength(1);
    expect(readEvents[0]?.text).toBe("inbound-once");
    expect(readEvents[0]?.history).toEqual([]);
    expect(storage.map.get(key)).toBe(saved);
    expect(readLogs).toContain("history_read_failed");
    expect(readLogs).not.toContain("inbound-once");

    storage.fail = "set";
    storage.map.delete(key);
    const writeMock = mockFetch((request) => answer(request, () => ({
      ret: 0,
      get_updates_buf: "c2",
      msgs: [textMessage("10", "inbound-write")],
    })));
    const writeApp = makeApp(writeMock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false }, storage);
    await seed(writeApp);
    const writeLogs = await captureLogs(async () => {
      await runPollStep(writeApp);
      await runPollStep(writeApp);
    });
    const writeEvents = webhooks(writeMock.calls);
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0]?.history).toEqual([]);
    expect(storage.map.has(key)).toBe(false);
    expect(writeLogs).toContain("history_write_failed");
    expect(writeLogs).not.toContain("inbound-write");
  });

  it("acks /reset once when clearing history throws", async () => {
    const storage = new FlakyStorage();
    const mock = mockFetch((request) => answer(request, () => ({
      ret: 0,
      get_updates_buf: "c-reset",
      msgs: [textMessage("11", "/reset")],
    })));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false }, storage);
    await seed(app);
    storage.fail = "delete";
    const logs = await captureLogs(async () => {
      await runPollStep(app);
      await runPollStep(app);
    });
    expect(webhooks(mock.calls)).toHaveLength(0);
    expect(mock.calls.filter((call) => call.url.pathname === "/ilink/bot/sendmessage")).toHaveLength(1);
    expect(logs).toContain("history_write_failed");
    expect(logs).not.toContain("send_failed");
  });
});

function turn(role: HistoryTurn["role"], text: string, atMs: number): HistoryTurn {
  return { role, text, type: "text", media: [], quote: null, at_ms: atMs, message_id: text };
}

function textMessage(id: string, text: string, at = NOW): Record<string, unknown> {
  return {
    message_id: id,
    from_user_id: "owner@im.wechat",
    create_time_ms: at,
    message_type: 1,
    message_state: 2,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function seed(app: BridgeApp): Promise<void> {
  await writeSession(app.storage, {
    botToken: "bot-secret",
    accountId: "bot@im.wechat",
    baseUrl: "https://acct.example",
    savedAt: 1,
  });
  await writeAllowlist(app.storage, app.config.allowFrom);
  await writeContextTokens(app.storage, { "owner@im.wechat": "ctx-1" });
}

function sendRequest(body: unknown): Request {
  return new Request("https://bridge.example/send", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function answer(
  request: CapturedRequest,
  updates: () => Record<string, unknown>,
): { status: number; body: string } {
  if (request.url.hostname === "routine.example") return { status: 200, body: "" };
  if (request.url.pathname === "/ilink/bot/msg/notifystart") return { status: 200, body: JSON.stringify({ ret: 0 }) };
  if (request.url.pathname === "/ilink/bot/getupdates") return { status: 200, body: JSON.stringify(updates()) };
  if (request.url.pathname === "/ilink/bot/sendmessage") {
    return { status: 200, body: JSON.stringify({ ret: 0, message_id: "m-1" }) };
  }
  return { status: 404, body: "" };
}

function webhooks(calls: CapturedRequest[]): Array<{ text: string; history: HistoryTurn[]; type?: string }> {
  return calls
    .filter((call) => call.url.hostname === "routine.example")
    .map((call) => JSON.parse(call.body) as { text: string; history: HistoryTurn[]; type?: string });
}

function webhookEvent(calls: CapturedRequest[]): { text: string; history: HistoryTurn[] } {
  const event = webhooks(calls).at(-1);
  if (!event) throw new Error("missing webhook");
  return event;
}

class SlowStorage extends MemoryStorage {
  override async set(key: string, value: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await super.set(key, value);
  }
}

class FlakyStorage extends MemoryStorage {
  fail: "none" | "get" | "set" | "delete" = "none";

  override async get(key: string): Promise<string | null> {
    if (this.fail === "get" && key.startsWith("h_")) throw new Error("history get failed");
    return super.get(key);
  }

  override async set(key: string, value: string): Promise<void> {
    if (this.fail === "set" && key.startsWith("h_")) throw new Error("history set failed");
    await super.set(key, value);
  }

  override async delete(key: string): Promise<void> {
    if (this.fail === "delete" && key.startsWith("h_")) throw new Error("history delete failed");
    await super.delete(key);
  }
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines.join("\n");
}
