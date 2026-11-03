import { createIlinkClient, type BridgeApp } from "../src/core/app.js";
import { configFromEnv, type BridgeConfig } from "../src/core/config.js";
import { MemoryMediaStore } from "../src/core/media-store.js";
import type { BridgeStorage } from "../src/core/storage.js";

export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export class MemoryStorage implements BridgeStorage {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** Record every fetch and answer from `handler`. */
export function mockFetch(
  handler: (request: CapturedRequest) => { status: number; body: string; headers?: Record<string, string> } | Promise<{ status: number; body: string; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const captured = { method: init?.method ?? "GET", url, headers, body };
    calls.push(captured);
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    const result = await handler(captured);
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json", ...result.headers },
    });
  };
  return { fetchImpl, calls };
}

/** Config with test secrets already filled in. Overrides win. */
export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ...configFromEnv({
      BRIDGE_TOKEN: "test-token",
      BRIDGE_PUBLIC_URL: "https://bridge.example",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      ILINK_CHANNEL_VERSION: "0.1.0",
      ILINK_BOT_AGENT: "WeixinDeepSeek/0.1.0",
      SEND_TYPING: "false",
    }),
    ...overrides,
  };
}

/** App wired to an in-memory store and a mock fetch. */
export function makeApp(
  fetchImpl: typeof fetch,
  overrides: Partial<BridgeConfig> = {},
  storage: BridgeStorage = new MemoryStorage(),
): BridgeApp {
  const config = testConfig(overrides);
  return {
    config,
    storage,
    media: new MemoryMediaStore(),
    client: createIlinkClient(config, fetchImpl),
    fetchImpl,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
  };
}
