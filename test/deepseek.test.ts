import { describe, expect, it } from "vitest";

import { replyWithAI } from "../src/core/deepseek.js";
import { fetchAvailableModels } from "../src/core/models.js";
import { writeAllowlist, writeSession } from "../src/core/state.js";
import type { InboundEvent } from "../src/core/types.js";
import { makeApp, mockFetch } from "./support.js";

function inbound(): InboundEvent {
  return {
    schema: "grokbot-weixin.inbound.v1",
    account_id: "bot@im.wechat",
    sender: { id: "owner@im.wechat", name: null },
    message_id: "msg-1",
    timestamp_ms: 1_700_000_000_000,
    type: "text",
    state: "finished",
    text: "你好",
    media: [],
    quote: null,
    history: [
      { role: "user", text: "之前的问题", type: "text", media: [], quote: null, at_ms: 1_699_999_000_000, message_id: "old-1" },
      { role: "assistant", text: "之前的回答", type: "text", media: [], quote: null, at_ms: 1_699_999_100_000, message_id: "old-2" },
    ],
    context_token: "ctx-1",
    chat_type: "direct",
    reply: {
      method: "POST",
      url: null,
      headers: { "Content-Type": "application/json", Authorization: "Bearer <BRIDGE_TOKEN>" },
      body: { to: "owner@im.wechat", text: "<reply text>", context_token: "ctx-1", account: "bot@im.wechat" },
      notes: "",
    },
  };
}

describe("AI provider replies", () => {
  it("sends recent history to DeepSeek and delivers the answer to the allowlisted WeChat peer", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "api.deepseek.com") {
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "你好！我在。" } }] }) };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "out-1" }) };
      }
      return { status: 404, body: "" };
    });
    const app = makeApp(mock.fetchImpl);
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);

    expect(await replyWithAI(app, inbound())).toBe(true);
    const ai = mock.calls.find((call) => call.url.hostname === "api.deepseek.com");
    expect(ai?.headers.get("authorization")).toBe("Bearer deepseek-test-key");
    const payload = JSON.parse(ai?.body ?? "{}") as { model: string; messages: Array<{ role: string; content: string }> };
    expect(payload.model).toBe("deepseek-chat");
    expect(payload.messages.map((item) => item.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(payload.messages.at(-1)?.content).toBe("你好");
    const sent = mock.calls.find((call) => call.url.pathname === "/ilink/bot/sendmessage");
    expect(sent?.body).toContain("你好！我在。");
    expect(sent?.body).toContain("ctx-1");
  });

  it("uses the configured OpenDoor Chat Completions endpoint and model", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "ai.opendoor.sbs") {
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "测试回复" } }] }) };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "out-2" }) };
      }
      return { status: 404, body: "" };
    });
    const app = makeApp(mock.fetchImpl, {
      aiApiBase: "https://ai.opendoor.sbs/v1",
      aiApiKey: "demo-token",
      aiModel: "claude-fable-5",
    });
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);
    expect(await replyWithAI(app, inbound())).toBe(true);
    const call = mock.calls.find((item) => item.url.hostname === "ai.opendoor.sbs");
    expect(call?.url.pathname).toBe("/v1/chat/completions");
    expect(call?.headers.get("authorization")).toBe("Bearer demo-token");
    expect(JSON.parse(call?.body ?? "{}").model).toBe("claude-fable-5");
  });

  it("sends a Responses API request to Zhongdiwa and extracts output_text", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "www.zhongdiwa.com") {
        return { status: 200, body: JSON.stringify({ output_text: "中低洼测试成功" }) };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "out-3" }) };
      }
      return { status: 404, body: "" };
    });
    const app = makeApp(mock.fetchImpl, {
      aiApiBase: "https://www.zhongdiwa.com/v1",
      aiApiKey: "zhongdiwa-test-token",
      aiModel: "gpt-5.5",
      aiApiProtocol: "responses",
      zhongdiwaActorAuthorization: "local-image-extension",
    });
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);
    expect(await replyWithAI(app, inbound())).toBe(true);
    const call = mock.calls.find((item) => item.url.hostname === "www.zhongdiwa.com");
    expect(call?.url.pathname).toBe("/v1/responses");
    expect(call?.headers.get("authorization")).toBe("Bearer zhongdiwa-test-token");
    expect(call?.headers.get("x-openai-actor-authorization")).toBe("local-image-extension");
    const payload = JSON.parse(call?.body ?? "{}") as { model: string; instructions: string; input: Array<{ role: string; content: string }> };
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.instructions).toContain("微信");
    expect(payload.input.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(payload.input.map((item) => item.content)).toEqual(["之前的问题", "之前的回答", "你好"]);
    expect(mock.calls.find((item) => item.url.pathname === "/ilink/bot/sendmessage")?.body).toContain("中低洼测试成功");
  });

  it("handles a non-JSON Responses API error without losing the failure path", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "www.zhongdiwa.com") {
        return { status: 502, body: "upstream unavailable" };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "out-error" }) };
      }
      return { status: 404, body: "" };
    });
    const app = makeApp(mock.fetchImpl, {
      aiApiBase: "https://www.zhongdiwa.com/v1",
      aiApiKey: "zhongdiwa-test-token",
      aiModel: "gpt-5.5",
      aiApiProtocol: "responses",
    });
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);

    expect(await replyWithAI(app, inbound())).toBe(false);
    expect(mock.calls.find((item) => item.url.pathname === "/v1/responses")?.method).toBe("POST");
    expect(mock.calls.find((item) => item.url.pathname === "/ilink/bot/sendmessage")?.body).toContain("刚才回复失败了");
  });

  it("treats an incomplete Responses API result without output text as a failed generation", async () => {
    const mock = mockFetch((request) => {
      if (request.url.hostname === "www.zhongdiwa.com") {
        return { status: 200, body: JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }) };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "out-incomplete" }) };
      }
      return { status: 404, body: "" };
    });
    const app = makeApp(mock.fetchImpl, {
      aiApiBase: "https://www.zhongdiwa.com/v1",
      aiApiKey: "zhongdiwa-test-token",
      aiModel: "gpt-5.5",
      aiApiProtocol: "responses",
    });
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);

    expect(await replyWithAI(app, inbound())).toBe(false);
    expect(mock.calls.find((item) => item.url.pathname === "/ilink/bot/sendmessage")?.body).toContain("刚才回复失败了");
  });

  it("does not call the provider or send a message without an API key", async () => {
    const mock = mockFetch(() => ({ status: 200, body: "{}" }));
    const app = makeApp(mock.fetchImpl, { aiApiKey: "" });
    expect(await replyWithAI(app, inbound())).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("Provider model discovery", () => {
  it("loads, deduplicates, and sorts OpenDoor model IDs", async () => {
    const mock = mockFetch((request) => request.url.pathname === "/v1/models"
      ? { status: 200, body: JSON.stringify({ data: [{ id: "model-z" }, { id: "model-a" }, { id: "model-z" }] }) }
      : { status: 404, body: "" });
    const app = makeApp(mock.fetchImpl, { aiApiBase: "https://ai.opendoor.sbs/v1", aiApiKey: "demo-token" });
    await expect(fetchAvailableModels(app, "opendoor")).resolves.toEqual(["model-a", "model-z"]);
    expect(mock.calls.find((item) => item.url.pathname === "/v1/models")?.headers.get("authorization")).toBe("Bearer demo-token");
  });

  it("loads Zhongdiwa's remote model catalog with its configured bearer token", async () => {
    const mock = mockFetch((request) => request.url.pathname === "/v1/models"
      ? { status: 200, body: JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "reasoner-x" }] }) }
      : { status: 404, body: "" });
    const app = makeApp(mock.fetchImpl, {
      zhongdiwaApiBase: "https://www.zhongdiwa.com/v1",
      zhongdiwaApiKey: "zhongdiwa-test-token",
    });
    await expect(fetchAvailableModels(app, "zhongdiwa")).resolves.toEqual(["gpt-5.5", "reasoner-x"]);
    const call = mock.calls.find((item) => item.url.pathname === "/v1/models");
    expect(call?.url.hostname).toBe("www.zhongdiwa.com");
    expect(call?.headers.get("authorization")).toBe("Bearer zhongdiwa-test-token");
  });
});
