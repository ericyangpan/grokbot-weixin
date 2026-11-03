import { afterEach, describe, expect, it, vi } from "vitest";

import { replyWithAI } from "../src/core/deepseek.js";
import { writeAllowlist, writeSession } from "../src/core/state.js";
import type { InboundEvent } from "../src/core/types.js";
import { makeApp, mockFetch } from "./support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function inbound(): InboundEvent {
  return {
    schema: "grokbot-weixin.inbound.v1",
    account_id: "bot@im.wechat",
    sender: { id: "owner@im.wechat", name: null },
    message_id: "diagnostic-message",
    timestamp_ms: 1_700_000_000_000,
    type: "text",
    state: "finished",
    text: "这段聊天内容不应进入日志",
    media: [],
    quote: null,
    history: [],
    context_token: "ctx-diagnostic",
    chat_type: "direct",
    reply: {
      method: "POST",
      url: null,
      headers: { "Content-Type": "application/json", Authorization: "Bearer <BRIDGE_TOKEN>" },
      body: { to: "owner@im.wechat", text: "<reply text>", context_token: "ctx-diagnostic", account: "bot@im.wechat" },
      notes: "",
    },
  };
}

describe("Zhongdiwa Responses API diagnostics", () => {
  it("records safe request metadata and allowlisted upstream response headers on 503", async () => {
    const mock = mockFetch((request) => {
      if (request.url.pathname === "/v1/responses") {
        return {
          status: 503,
          body: JSON.stringify({ error: { message: "Service temporarily unavailable" } }),
          headers: {
            "x-request-id": "upstream-test-request-123",
            "retry-after": "30",
            server: "zhongdiwa-test",
          },
        };
      }
      if (request.url.pathname === "/ilink/bot/sendmessage") {
        return { status: 200, body: JSON.stringify({ ret: 0, message_id: "notice-1" }) };
      }
      return { status: 404, body: "" };
    });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = makeApp(mock.fetchImpl, {
      aiApiBase: "https://www.zhongdiwa.com/v1",
      aiApiKey: "never-log-this-api-key",
      aiModel: "gpt-5.5",
      aiApiProtocol: "responses",
      zhongdiwaActorAuthorization: "local-image-extension",
    });
    await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
    await writeAllowlist(app.storage, ["owner@im.wechat"]);

    expect(await replyWithAI(app, inbound())).toBe(false);
    const call = mock.calls.find((item) => item.url.pathname === "/v1/responses");
    expect(call?.headers.get("authorization")).toBe("Bearer never-log-this-api-key");
    expect(call?.headers.get("x-openai-actor-authorization")).toBe("local-image-extension");
    expect(call?.headers.get("x-client-request-id")).toMatch(/^[0-9a-f-]{36}$/i);

    const logs = [...info.mock.calls, ...warn.mock.calls].map((args) => String(args[0])).join("\n");
    expect(logs).toContain("ai_responses_request");
    expect(logs).toContain('"auth_scheme":"Bearer"');
    expect(logs).toContain('"actor_authorization_present":true');
    expect(logs).toContain('"input_content_type":"text"');
    expect(logs).toContain("upstream-test-request-123");
    expect(logs).toContain('"retry_after":"30"');
    expect(logs).toContain('"http_status":503');
    expect(logs).not.toContain("never-log-this-api-key");
    expect(logs).not.toContain("这段聊天内容不应进入日志");
    expect(logs).not.toContain("ctx-diagnostic");
  });
});
