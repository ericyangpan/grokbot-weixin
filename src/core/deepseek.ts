import type { BridgeApp } from "./app.js";
import type { InboundEvent } from "./types.js";
import { appFetch } from "./app.js";
import { logInfo, logWarn, publicError } from "./log.js";
import { sendBridgeText } from "./send.js";

const SYSTEM_PROMPT = "你是一个通过微信与用户交流的中文 AI 助手。请用自然、清晰、简洁的中文回答。遇到不确定的信息要明确说明，不要编造。";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string };
};

type ResponsesApiResponse = {
  id?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string; code?: string };
};

/** Generate a reply with either Chat Completions or the OpenAI Responses API. */
export async function replyWithAI(app: BridgeApp, event: InboundEvent): Promise<boolean> {
  const { aiApiBase, aiApiKey, aiModel, aiApiProtocol } = app.config;
  if (!aiApiKey || !aiApiBase || !aiModel) {
    logWarn("ai_not_configured", { message_id: event.message_id });
    return false;
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const turn of event.history) {
    messages.push({ role: turn.role, content: turn.text.slice(0, 8_000) });
  }

  const attachmentNotes = event.media
    .map((item) => {
      const detail = [item.kind, item.file_name, item.transcript].filter(Boolean).join("，");
      return detail ? `[收到附件：${detail}]` : `[收到${item.kind}附件]`;
    })
    .join("\n");
  const quote = event.quote?.text || event.quote?.title || "";
  const current = [event.text, attachmentNotes, quote ? `[引用内容：${quote}]` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 12_000);
  messages.push({ role: "user", content: current || "用户发送了一条消息，请自然回应。" });

  let stage = "build_request";
  try {
    const isResponses = aiApiProtocol === "responses";
    const endpoint = `${aiApiBase.replace(/\/+$/, "")}/${isResponses ? "responses" : "chat/completions"}`;
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiApiKey}`,
    });
    if (isResponses && app.config.zhongdiwaActorAuthorization) {
      headers.set("x-openai-actor-authorization", app.config.zhongdiwaActorAuthorization);
    }
    // A non-secret correlation ID lets the provider support team locate this request.
    // It contains no user or message information.
    const clientRequestId = isResponses ? crypto.randomUUID() : "";
    if (clientRequestId) headers.set("X-Client-Request-Id", clientRequestId);
    const body = isResponses
      ? {
          model: aiModel,
          instructions: SYSTEM_PROMPT,
          // Send message content as plain text. This is valid Responses API input
          // and avoids providers that incorrectly validate input_text as an output type.
          input: messages.slice(1).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          max_output_tokens: 1_200,
          store: false,
        }
      : {
          model: aiModel,
          messages,
          temperature: 0.7,
          max_tokens: 1_200,
          stream: false,
        };

    if (isResponses) {
      logInfo("ai_responses_request", {
        provider: new URL(aiApiBase).hostname,
        endpoint: new URL(endpoint).pathname,
        model: aiModel,
        client_request_id: clientRequestId,
        method: "POST",
        auth_scheme: "Bearer",
        actor_authorization_present: headers.has("x-openai-actor-authorization"),
        content_type: headers.get("content-type"),
        input_items: messages.length - 1,
        input_roles: messages.slice(1).map((item) => item.role).join(","),
        input_content_type: "text",
        store: false,
        max_output_tokens: 1_200,
      });
    }

    stage = "provider_fetch";
    const response = await appFetch(app)(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    stage = "provider_read_response";
    const responseText = await response.text();
    const responseDiagnostics = providerResponseDiagnostics(response);
    if (isResponses) {
      const logResult = response.ok ? logInfo : logWarn;
      logResult("ai_responses_http_result", {
        provider: new URL(aiApiBase).hostname,
        model: aiModel,
        client_request_id: clientRequestId,
        ...responseDiagnostics,
      });
    }
    let data: ChatCompletionResponse & ResponsesApiResponse;
    try {
      data = responseText ? JSON.parse(responseText) as ChatCompletionResponse & ResponsesApiResponse : {};
    } catch {
      throw new Error(`AI provider returned non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok) {
      logWarn("ai_provider_rejected", {
        status: response.status,
        provider: new URL(aiApiBase).hostname,
        code: data.error?.code ?? null,
        message: data.error?.message?.slice(0, 300) ?? "unknown",
        ...(isResponses ? { client_request_id: clientRequestId } : {}),
      });
      stage = "provider_rejected_notice";
      const notice = await sendBridgeText(app, {
        to: event.sender.id,
        text: "我暂时无法生成回复，请稍后再试。",
        ...(event.context_token ? { contextToken: event.context_token } : {}),
      });
      if (!notice.ok) logWarn("ai_failure_notice_delivery_failed", { message_id: event.message_id, error: notice.error });
      return false;
    }

    const raw = isResponses
      ? extractResponsesText(data)
      : data.choices?.[0]?.message?.content;
    const answer = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "").trim();
    if (!answer) {
      const detail = isResponses && data.status === "incomplete"
        ? `AI provider returned an incomplete response: ${data.incomplete_details?.reason ?? "unspecified"}`
        : "AI provider returned an empty answer";
      throw new Error(detail);
    }

    stage = "wechat_delivery";
    const result = await sendBridgeText(app, {
      to: event.sender.id,
      text: answer.slice(0, 4_000),
      ...(event.context_token ? { contextToken: event.context_token } : {}),
    });
    if (!result.ok) {
      logWarn("ai_reply_delivery_failed", { message_id: event.message_id, error: result.error });
      return false;
    }
    return true;
  } catch (err) {
    logWarn("ai_provider_failed", { message_id: event.message_id, stage, error: publicError(err) });
    const notice = await sendBridgeText(app, {
      to: event.sender.id,
      text: "刚才回复失败了，请稍后再发一次。",
      ...(event.context_token ? { contextToken: event.context_token } : {}),
    });
    if (!notice.ok) logWarn("ai_failure_notice_delivery_failed", { message_id: event.message_id, error: notice.error });
    return false;
  }
}

/** Log only allowlisted response headers; never dump arbitrary upstream headers. */
function providerResponseDiagnostics(response: Response): Record<string, string | number | null> {
  return {
    http_status: response.status,
    upstream_request_id:
      response.headers.get("x-request-id") ??
      response.headers.get("openai-request-id") ??
      response.headers.get("request-id"),
    cf_ray: response.headers.get("cf-ray"),
    retry_after: response.headers.get("retry-after"),
    server: response.headers.get("server"),
    content_type: response.headers.get("content-type"),
  };
}

function extractResponsesText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

/** Backwards-compatible export for integrations that used the old function name. */
export const replyWithDeepSeek = replyWithAI;
