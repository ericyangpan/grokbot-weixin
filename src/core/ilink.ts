import { API_TIMEOUT_MS, CONFIG_TIMEOUT_MS } from "./constants.js";
import { parseWeixinApiJson } from "./json.js";
import { logWarn } from "./log.js";
import { randomWechatUin } from "./protocol.js";
import type {
  GetConfigResp,
  GetUpdatesResp,
  NotifyResp,
  QrCodeBody,
  QrStatusBody,
  SendMessageResp,
} from "./types.js";

export interface IlinkClientOptions {
  appId: string;
  clientVersion: string;
  channelVersion: string;
  botAgent: string;
  routeTag?: string;
  fetchImpl?: typeof fetch;
  randomUin?: () => string;
}

/** HTTP failure that intentionally omits the response body. */
export class IlinkHttpError extends Error {
  readonly status: number;
  readonly op: string;

  constructor(op: string, status: number) {
    super(`${op} http ${status}`);
    this.name = "IlinkHttpError";
    this.op = op;
    this.status = status;
  }
}

/** Business failure from a parsed iLink body. errmsg is omitted; it is not a stable contract. */
export class IlinkApiError extends Error {
  readonly op: string;
  readonly ret: number;

  constructor(op: string, ret: number) {
    super(`${op} failed ret=${ret}`);
    this.name = "IlinkApiError";
    this.op = op;
    this.ret = ret;
  }
}

/** JSON body that could not be parsed. The raw text is not retained. */
export class IlinkParseError extends Error {
  readonly op: string;

  constructor(op: string) {
    super(`${op} returned invalid json`);
    this.name = "IlinkParseError";
    this.op = op;
  }
}

type HeaderMode = "get" | "post" | "post-auth";

/**
 * Standalone iLink Bot API client.
 * Header and path behavior follows Tencent openclaw-weixin (MIT):
 * https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
 */
export class IlinkClient {
  constructor(private readonly options: IlinkClientOptions) {}

  /** POST /ilink/bot/get_bot_qrcode. No Authorization header and no base_info. */
  async getBotQrCode(params: {
    apiBase: string;
    botType: string;
    localTokens: string[];
  }): Promise<QrCodeBody> {
    const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType)}`;
    const text = await this.post("getBotQrCode", {
      baseUrl: params.apiBase,
      endpoint,
      mode: "post",
      body: JSON.stringify({ local_token_list: params.localTokens.slice(0, 10) }),
      timeoutMs: API_TIMEOUT_MS,
    });
    const parsed = parseJson("getBotQrCode", text);
    const qrcode = asString(parsed.qrcode);
    const qrcodeUrl = asString(parsed.qrcode_img_content);
    if (!qrcode || !qrcodeUrl) throw new IlinkParseError("getBotQrCode");
    return { qrcode, qrcode_img_content: qrcodeUrl };
  }

  /**
   * GET /ilink/bot/get_qrcode_status. Network failures and timeouts become `wait`,
   * matching the upstream login client.
   */
  async getQrStatus(params: {
    apiBase: string;
    qrcode: string;
    verifyCode?: string;
    timeoutMs: number;
  }): Promise<QrStatusBody> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    }
    try {
      const text = await this.get("getQrStatus", {
        baseUrl: params.apiBase,
        endpoint,
        timeoutMs: params.timeoutMs,
      });
      return normalizeStatus(parseJson("getQrStatus", text));
    } catch (err) {
      if (!isAbort(err)) {
        logWarn("qr_status_failed", { error: err instanceof Error ? err.name : "error" });
      }
      return { status: "wait" };
    }
  }

  /**
   * POST /ilink/bot/getupdates. A client-side timeout returns an empty success
   * and the same cursor so the caller can poll again.
   */
  async getUpdates(params: {
    baseUrl: string;
    token: string;
    cursor: string;
    timeoutMs: number;
  }): Promise<GetUpdatesResp> {
    const body = JSON.stringify({
      get_updates_buf: params.cursor,
      base_info: this.baseInfo(),
    });
    try {
      const text = await this.post("getUpdates", {
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/getupdates",
        mode: "post-auth",
        token: params.token,
        body,
        timeoutMs: params.timeoutMs,
      });
      return parseWeixinApiJson<GetUpdatesResp>(text);
    } catch (err) {
      if (isAbort(err)) {
        return { ret: 0, msgs: [], get_updates_buf: params.cursor };
      }
      throw err;
    }
  }

  /** POST /ilink/bot/sendmessage. A non-zero ret throws; a missing ret does not. */
  async sendText(params: {
    baseUrl: string;
    token: string;
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
  }): Promise<SendMessageResp> {
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: params.text } }],
    };
    if (params.contextToken) msg.context_token = params.contextToken;
    const text = await this.post("sendMessage", {
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      mode: "post-auth",
      token: params.token,
      body: JSON.stringify({ msg, base_info: this.baseInfo() }),
      timeoutMs: API_TIMEOUT_MS,
    });
    const resp = parseWeixinApiJson<SendMessageResp>(text);
    if (typeof resp.ret === "number" && resp.ret !== 0) {
      throw new IlinkApiError("sendMessage", resp.ret);
    }
    return resp;
  }

  /** POST /ilink/bot/getconfig. The caller checks ret. */
  async getConfig(params: {
    baseUrl: string;
    token: string;
    userId: string;
    contextToken?: string;
  }): Promise<GetConfigResp> {
    const payload: Record<string, unknown> = {
      ilink_user_id: params.userId,
      base_info: this.baseInfo(),
    };
    if (params.contextToken) payload.context_token = params.contextToken;
    const text = await this.post("getConfig", {
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getconfig",
      mode: "post-auth",
      token: params.token,
      body: JSON.stringify(payload),
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    return parseJson("getConfig", text) as GetConfigResp;
  }

  /** POST /ilink/bot/sendtyping. status 1 starts typing. The body is not interpreted. */
  async sendTyping(params: {
    baseUrl: string;
    token: string;
    userId: string;
    typingTicket: string;
    status?: number;
  }): Promise<void> {
    await this.post("sendTyping", {
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      mode: "post-auth",
      token: params.token,
      body: JSON.stringify({
        ilink_user_id: params.userId,
        typing_ticket: params.typingTicket,
        status: params.status ?? 1,
        base_info: this.baseInfo(),
      }),
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
  }

  /** POST /ilink/bot/msg/notifystart. */
  async notifyStart(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
    return this.notify("notifyStart", "ilink/bot/msg/notifystart", params);
  }

  /** POST /ilink/bot/msg/notifystop. */
  async notifyStop(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
    return this.notify("notifyStop", "ilink/bot/msg/notifystop", params);
  }

  private async notify(op: string, endpoint: string, params: { baseUrl: string; token: string }): Promise<NotifyResp> {
    const text = await this.post(op, {
      baseUrl: params.baseUrl,
      endpoint,
      mode: "post-auth",
      token: params.token,
      body: JSON.stringify({ base_info: this.baseInfo() }),
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    return parseJson(op, text) as NotifyResp;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: this.options.channelVersion,
      bot_agent: this.options.botAgent,
    };
  }

  private async get(op: string, params: { baseUrl: string; endpoint: string; timeoutMs: number }): Promise<string> {
    return this.request(op, { ...params, method: "GET", mode: "get" });
  }

  private async post(
    op: string,
    params: {
      baseUrl: string;
      endpoint: string;
      mode: HeaderMode;
      body: string;
      timeoutMs: number;
      token?: string;
    },
  ): Promise<string> {
    return this.request(op, { ...params, method: "POST" });
  }

  private async request(
    op: string,
    params: {
      method: "GET" | "POST";
      baseUrl: string;
      endpoint: string;
      mode: HeaderMode;
      timeoutMs: number;
      body?: string;
      token?: string;
    },
  ): Promise<string> {
    const url = new URL(params.endpoint, ensureSlash(params.baseUrl));
    const headers = this.headers(params.mode, params.token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const response = await this.fetch()(url.toString(), {
        method: params.method,
        headers,
        body: params.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IlinkHttpError(op, response.status);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(mode: HeaderMode, token?: string): Record<string, string> {
    const common: Record<string, string> = {
      "iLink-App-Id": this.options.appId,
      "iLink-App-ClientVersion": this.options.clientVersion,
    };
    if (this.options.routeTag) common.SKRouteTag = this.options.routeTag;
    if (mode === "get") return common;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": (this.options.randomUin ?? randomWechatUin)(),
      ...common,
    };
    if (mode === "post-auth" && token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }
}

function ensureSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function parseJson(op: string, text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IlinkParseError) throw err;
    throw new IlinkParseError(op);
  }
}

function normalizeStatus(value: Record<string, unknown>): QrStatusBody {
  const status = asString(value.status) ?? "wait";
  return {
    status,
    ...(asString(value.bot_token) ? { bot_token: asString(value.bot_token) } : {}),
    ...(asString(value.ilink_bot_id) ? { ilink_bot_id: asString(value.ilink_bot_id) } : {}),
    ...(asString(value.baseurl) ? { baseurl: asString(value.baseurl) } : {}),
    ...(asString(value.ilink_user_id) ? { ilink_user_id: asString(value.ilink_user_id) } : {}),
    ...(asString(value.redirect_host) ? { redirect_host: asString(value.redirect_host) } : {}),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
