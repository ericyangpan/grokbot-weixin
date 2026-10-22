import { describe, expect, it } from "vitest";

import { KEYS } from "../src/core/keys.js";
import { runPollStep } from "../src/core/poll.js";
import { postWebhook } from "../src/core/webhook.js";
import { readAllowlist, readContextTokens, readDedupe, writeSession } from "../src/core/state.js";
import { makeApp, mockFetch, type CapturedRequest } from "./support.js";
import type { BridgeApp } from "../src/core/app.js";

const TEXT = "swordfish-body";

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: "100",
    from_user_id: "owner@im.wechat",
    create_time_ms: 1_700_000_000_000,
    message_type: 1,
    message_state: 2,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: TEXT } }],
    ...overrides,
  };
}

async function seed(app: BridgeApp): Promise<void> {
  await writeSession(app.storage, {
    botToken: "bot-secret",
    accountId: "bot@im.wechat",
    savedAt: 1,
  });
}

describe("poll step", () => {
  it("persists the cursor, dedupes, and does not log the body", async () => {
    let polls = 0;
    const mock = mockFetch((request) => answer(request, () => {
      polls += 1;
      if (polls === 1) {
        return { ret: 0, msgs: [message(), message({ message_id: "100" })], get_updates_buf: "c1" };
      }
      return { ret: 0, msgs: [message()], get_updates_buf: "c2" };
    }));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    try {
      await runPollStep(app);
      await runPollStep(app);
    } finally {
      console.log = original;
    }
    expect(await app.storage.get(KEYS.cursor)).toBe("c2");
    expect(await readDedupe(app.storage)).toEqual(["100"]);
    expect((await readContextTokens(app.storage))["owner@im.wechat"]).toBe("ctx-1");
    const hooks = mock.calls.filter((call) => call.url.hostname === "routine.example");
    expect(hooks).toHaveLength(1);
    const event = JSON.parse(hooks[0]?.body ?? "{}") as {
      text: string;
      sender: { name: string | null };
      context_token: string;
      reply: { url: string; body: { to: string } };
    };
    expect(event.text).toBe(TEXT);
    expect(event.sender.name).toBeNull();
    expect(event.context_token).toBe("ctx-1");
    expect(event.reply.url).toBe("https://bridge.example/send");
    expect(event.reply.body.to).toBe("owner@im.wechat");
    expect(hooks[0]?.headers.get("authorization")).toBe("Bearer whsec");
    expect(logs.join("\n")).not.toContain(TEXT);
    expect(logs.join("\n")).not.toContain("ctx-1");
    const update = mock.calls.find((call) => call.url.pathname === "/ilink/bot/getupdates");
    expect(update?.headers.get("authorization")).toBe("Bearer bot-secret");
    const cursors = mock.calls
      .filter((call) => call.url.pathname === "/ilink/bot/getupdates")
      .map((call) => (JSON.parse(call.body) as { get_updates_buf: string }).get_updates_buf);
    expect(cursors).toEqual(["", "c1"]);
  });

  it("ignores unknown senders, pins the first sender, and keeps polling after a bad webhook", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "routine.example") {
        const body = JSON.parse(request.body) as { message_id: string };
        if (body.message_id === "1") return { status: 500, body: "" };
        return { status: 200, body: "" };
      }
      return answer(request, () => ({
        ret: 0,
        get_updates_buf: "c-next",
        msgs: [
          message({ message_id: "1", from_user_id: "owner@im.wechat" }),
          message({ message_id: "2", from_user_id: "stranger@im.wechat", context_token: "ctx-stranger" }),
          message({ message_id: "3", group_id: "room", from_user_id: "owner@im.wechat" }),
        ],
      }));
    });
    const app = makeApp(mock.fetchImpl, {
      allowFrom: [],
      pinFirstSender: true,
      sendTyping: false,
      webhookMaxAttempts: 1,
    });
    await seed(app);
    const outcome = await runPollStep(app);
    expect(outcome.schedule).toBe(true);
    expect(await app.storage.get(KEYS.cursor)).toBe("c-next");
    expect(await readAllowlist(app.storage)).toEqual(["owner@im.wechat"]);
    expect((await readContextTokens(app.storage))["stranger@im.wechat"]).toBeUndefined();
    const hooks = mock.calls.filter((call) => call.url.hostname === "routine.example");
    expect(hooks.map((call) => (JSON.parse(call.body) as { message_id: string }).message_id)).toEqual(["1"]);
  });

  it("uses a voice transcript and records media without downloading it", async () => {
    const mock = mockFetch((request) =>
      answer(request, () => ({
        ret: 0,
        get_updates_buf: "c-voice",
        msgs: [
          message({
            message_id: "9",
            item_list: [
              {
                type: 3,
                voice_item: { text: "transcribed", media: { encrypt_query_param: "ep" } },
              },
            ],
          }),
        ],
      })),
    );
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: true });
    await seed(app);
    await runPollStep(app);
    const hook = mock.calls.find((call) => call.url.hostname === "routine.example");
    const event = JSON.parse(hook?.body ?? "{}") as {
      type: string;
      text: string;
      media: Array<{ kind: string; transcript: string; has_cdn_reference: boolean }>;
    };
    expect(event.type).toBe("voice");
    expect(event.text).toBe("transcribed");
    expect(event.media[0]).toMatchObject({ kind: "voice", transcript: "transcribed", has_cdn_reference: true });
    expect(mock.calls.some((call) => call.url.pathname === "/ilink/bot/getconfig")).toBe(true);
    expect(mock.calls.some((call) => call.url.pathname === "/ilink/bot/sendtyping")).toBe(true);
  });

  it("pauses on errcode -14 and does not move the cursor", async () => {
    const mock = mockFetch((request) => answer(request, () => ({ ret: -14, errcode: -14, msgs: [message()] })));
    const app = makeApp(mock.fetchImpl, { allowFrom: ["owner@im.wechat"] });
    await seed(app);
    const outcome = await runPollStep(app);
    expect(outcome.nextDelayMs).toBe(60 * 60 * 1000);
    expect(await app.storage.get(KEYS.cursor)).toBeNull();
    expect(mock.calls.some((call) => call.url.hostname === "routine.example")).toBe(false);
  });
});

describe("webhook retry", () => {
  it("retries 500 and stops on 400", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const failing = mockFetch(() => {
      attempts += 1;
      return { status: attempts < 3 ? 500 : 200, body: "" };
    });
    const ok = await postWebhook(
      { url: "https://routine.example/hook", key: "k", headerName: "X-Routine-Key", scheme: "", maxAttempts: 4 },
      event(),
      failing.fetchImpl,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(ok).toMatchObject({ ok: true, attempts: 3 });
    expect(failing.calls[0]?.headers.get("x-routine-key")).toBe("k");
    expect(sleeps).toEqual([200, 800]);

    const rejected = mockFetch(() => ({ status: 400, body: "no" }));
    const bad = await postWebhook(
      { url: "https://routine.example/hook", key: "k", headerName: "Authorization", scheme: "Bearer", maxAttempts: 4 },
      event(),
      rejected.fetchImpl,
      async () => {},
    );
    expect(bad).toMatchObject({ ok: false, attempts: 1, status: 400 });
    expect(rejected.calls).toHaveLength(1);
  });
});

function event(): import("../src/core/types.js").InboundEvent {
  return {
    schema: "grokbot-weixin.inbound.v1",
    account_id: "bot",
    sender: { id: "owner", name: null },
    message_id: "1",
    timestamp_ms: 1,
    type: "text",
    state: "finished",
    text: TEXT,
    media: [],
    context_token: null,
    chat_type: "direct",
    reply: {
      method: "POST",
      url: null,
      headers: { "Content-Type": "application/json", Authorization: "Bearer <BRIDGE_TOKEN>" },
      body: { to: "owner", text: "<reply text>", context_token: null, account: "bot" },
      notes: "",
    },
  };
}

function answer(
  request: CapturedRequest,
  updates: () => Record<string, unknown>,
): { status: number; body: string } {
  if (request.url.hostname === "routine.example") return { status: 200, body: "" };
  if (request.url.pathname === "/ilink/bot/msg/notifystart") return { status: 200, body: JSON.stringify({ ret: 0 }) };
  if (request.url.pathname === "/ilink/bot/getupdates") return { status: 200, body: JSON.stringify(updates()) };
  if (request.url.pathname === "/ilink/bot/getconfig") {
    return { status: 200, body: JSON.stringify({ ret: 0, typing_ticket: "ticket" }) };
  }
  if (request.url.pathname === "/ilink/bot/sendtyping") return { status: 200, body: "" };
  return { status: 404, body: "" };
}
