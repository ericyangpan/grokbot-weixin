import { describe, expect, it } from "vitest";

import { IlinkClient } from "../src/core/ilink.js";
import { parseWeixinApiJson } from "../src/core/json.js";
import { buildClientVersion, randomWechatUin } from "../src/core/protocol.js";
import { testConfig } from "./support.js";
import { mockFetch } from "./support.js";

describe("protocol helpers", () => {
  it("encodes the client version as 0x00MMNNPP", () => {
    expect(buildClientVersion("1.0.11")).toBe(65547);
    expect(buildClientVersion("0.1.0")).toBe(256);
  });

  it("base64-encodes a decimal uint32 for X-WECHAT-UIN", () => {
    const header = randomWechatUin();
    const value = Number(atob(header));
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });

  it("keeps uint64 message ids as strings and ignores text that looks like an id", () => {
    const parsed = parseWeixinApiJson<{
      message_id: string;
      item_list: Array<{ text_item: { text: string }; msg_id: string }>;
    }>(
      '{"message_id":18446744073709551615,"item_list":[{"text_item":{"text":"message_id: 12"},"msg_id":99}]}',
    );
    expect(parsed.message_id).toBe("18446744073709551615");
    expect(parsed.item_list[0]?.msg_id).toBe("99");
    expect(parsed.item_list[0]?.text_item.text).toBe("message_id: 12");
  });
});

describe("iLink request building", () => {
  const config = testConfig();

  function client(fetchImpl: typeof fetch): IlinkClient {
    return new IlinkClient({
      appId: config.ilinkAppId,
      clientVersion: config.clientVersion,
      channelVersion: config.channelVersion,
      botAgent: config.botAgent,
      routeTag: "lab",
      fetchImpl,
      randomUin: () => btoa("123"),
    });
  }

  it("builds QR and authenticated headers from the upstream client", async () => {
    const mock = mockFetch(() => ({ status: 200, body: JSON.stringify({ qrcode: "qr", qrcode_img_content: "https://qr.example/x" }) }));
    await client(mock.fetchImpl).getBotQrCode({
      apiBase: "https://ilink.test",
      botType: "3",
      localTokens: [],
    });
    const qr = mock.calls[0];
    expect(qr?.method).toBe("POST");
    expect(qr?.url.pathname).toBe("/ilink/bot/get_bot_qrcode");
    expect(qr?.url.searchParams.get("bot_type")).toBe("3");
    expect(JSON.parse(qr?.body ?? "{}")).toEqual({ local_token_list: [] });
    expect(qr?.headers.get("authorizationtype")).toBe("ilink_bot_token");
    expect(qr?.headers.get("x-wechat-uin")).toBe(btoa("123"));
    expect(qr?.headers.get("ilink-app-id")).toBe("bot");
    expect(qr?.headers.get("ilink-app-clientversion")).toBe("256");
    expect(qr?.headers.get("skroutetag")).toBe("lab");
    expect(qr?.headers.get("authorization")).toBeNull();
    expect(qr?.body).not.toContain("base_info");

    mock.calls.length = 0;
    mockFetch;
    const statusMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ status: "wait" }) }));
    await client(statusMock.fetchImpl).getQrStatus({
      apiBase: "https://redirect.test",
      qrcode: "qr code",
      verifyCode: "42",
      timeoutMs: 1000,
    });
    const status = statusMock.calls[0];
    expect(status?.method).toBe("GET");
    expect(status?.url.hostname).toBe("redirect.test");
    expect(status?.url.searchParams.get("qrcode")).toBe("qr code");
    expect(status?.url.searchParams.get("verify_code")).toBe("42");
    expect(status?.headers.get("authorization")).toBeNull();
    expect(status?.headers.get("authorizationtype")).toBeNull();
    expect(status?.headers.get("x-wechat-uin")).toBeNull();
    expect(status?.headers.get("ilink-app-id")).toBe("bot");

    const updates = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-2" }),
    }));
    await client(updates.fetchImpl).getUpdates({
      baseUrl: "https://ilink.test",
      token: "bot-secret",
      cursor: "cursor-1",
      timeoutMs: 1000,
    });
    const poll = updates.calls[0];
    expect(poll?.url.pathname).toBe("/ilink/bot/getupdates");
    expect(poll?.headers.get("authorization")).toBe("Bearer bot-secret");
    expect(poll?.headers.get("authorizationtype")).toBe("ilink_bot_token");
    const pollBody = JSON.parse(poll?.body ?? "{}") as { get_updates_buf: string; base_info: { channel_version: string; bot_agent: string }; sync_buf?: string };
    expect(pollBody.get_updates_buf).toBe("cursor-1");
    expect(pollBody.sync_buf).toBeUndefined();
    expect(pollBody.base_info).toEqual({ channel_version: "0.1.0", bot_agent: "GrokBotWeixin/0.1.0" });

    const send = mockFetch(() => ({ status: 200, body: '{"ret":0,"message_id":18446744073709551615}' }));
    const sent = await client(send.fetchImpl).sendText({
      baseUrl: "https://ilink.test",
      token: "bot-secret",
      to: "owner@im.wechat",
      text: "hello",
      contextToken: "ctx",
      clientId: "cid",
    });
    expect(sent.message_id).toBe("18446744073709551615");
    const sendBody = JSON.parse(send.calls[0]?.body ?? "{}") as {
      msg: { to_user_id: string; message_type: number; message_state: number; context_token: string; item_list: Array<{ type: number; text_item: { text: string } }> };
      base_info: { bot_agent: string };
    };
    expect(send.calls[0]?.url.pathname).toBe("/ilink/bot/sendmessage");
    expect(sendBody.msg.to_user_id).toBe("owner@im.wechat");
    expect(sendBody.msg.message_type).toBe(2);
    expect(sendBody.msg.message_state).toBe(2);
    expect(sendBody.msg.context_token).toBe("ctx");
    expect(sendBody.msg.item_list[0]).toEqual({ type: 1, text_item: { text: "hello" } });
    expect(sendBody.base_info.bot_agent).toBe("GrokBotWeixin/0.1.0");
  });

  it("turns a long-poll abort into an empty success with the same cursor", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const response = await client(fetchImpl).getUpdates({
      baseUrl: "https://ilink.test",
      token: "bot-secret",
      cursor: "same",
      timeoutMs: 30,
    });
    expect(response).toMatchObject({ ret: 0, msgs: [], get_updates_buf: "same" });
  });
});
