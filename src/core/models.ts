import type { BridgeApp } from "./app.js";
import { appFetch } from "./app.js";

export type AIProvider = "deepseek" | "opendoor" | "zhongdiwa";

/** Return model IDs from the selected provider's OpenAI-compatible /models endpoint. */
export async function fetchAvailableModels(app: BridgeApp, provider: AIProvider = "opendoor"): Promise<string[]> {
  const config = providerConfig(app, provider);
  if (!config.apiBase || !config.apiKey.trim()) {
    throw new Error(`请先在 Cloudflare 中配置 ${config.keyName}。`);
  }

  const endpoint = `${config.apiBase.replace(/\/+$/, "")}/models`;
  const headers = new Headers({ Authorization: `Bearer ${config.apiKey}` });
  if (provider === "zhongdiwa" && app.config.zhongdiwaActorAuthorization) {
    headers.set("x-openai-actor-authorization", app.config.zhongdiwaActorAuthorization);
  }
  const response = await appFetch(app)(endpoint, { method: "GET", headers });
  if (!response.ok) throw new Error(`模型列表接口返回 HTTP ${response.status}`);

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ id?: unknown }>;
  };
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const unique = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.trim()) unique.add(entry.id.trim());
  }
  if (unique.size === 0) throw new Error("模型列表为空，或接口返回格式不兼容。");
  return [...unique].sort((a, b) => a.localeCompare(b));
}

function providerConfig(app: BridgeApp, provider: AIProvider): { apiBase: string; apiKey: string; keyName: string } {
  if (provider === "deepseek") {
    return { apiBase: "https://api.deepseek.com", apiKey: app.config.deepseekApiKey, keyName: "DEEPSEEK_API_KEY" };
  }
  if (provider === "zhongdiwa") {
    return {
      apiBase: app.config.zhongdiwaApiBase,
      apiKey: app.config.zhongdiwaApiKey,
      keyName: "ZHONGDIWA_API_KEY",
    };
  }
  return { apiBase: app.config.aiApiBase, apiKey: app.config.aiApiKey, keyName: "AI_API_KEY" };
}
