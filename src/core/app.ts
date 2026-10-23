import type { BridgeConfig } from "./config.js";
import { IlinkClient } from "./ilink.js";
import type { MediaStore } from "./media-store.js";
import type { BridgeStorage } from "./storage.js";

/** Dependencies shared by the poll loop, the HTTP API, and both adapters. */
export interface BridgeApp {
  config: BridgeConfig;
  storage: BridgeStorage;
  /** Decrypted attachments. Short-lived; see MEDIA_TTL_MS. */
  media: MediaStore;
  client: IlinkClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after a login is stored. The Worker uses this to arm the alarm. */
  onLoggedIn?: () => Promise<void>;
  /**
   * Decode WeChat SILK to mono PCM s16le. The Node runner sets this.
   * The Worker leaves it unset and stores raw SILK.
   */
  decodeSilk?: (bytes: Uint8Array, sampleRate: number) => Promise<Uint8Array | null>;
}

/** Current time, or the clock injected by tests. */
export function appNow(app: BridgeApp): number {
  return app.now ? app.now() : Date.now();
}

/** Sleep helper. Tests pass a function that resolves immediately. */
export function appSleep(app: BridgeApp): (ms: number) => Promise<void> {
  return app.sleep ?? defaultSleep;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** fetch implementation for webhook calls. */
export function appFetch(app: BridgeApp): typeof fetch {
  return app.fetchImpl ?? fetch;
}

/** Build the iLink client from bridge config. */
export function createIlinkClient(config: BridgeConfig, fetchImpl?: typeof fetch): IlinkClient {
  return new IlinkClient({
    appId: config.ilinkAppId,
    clientVersion: config.clientVersion,
    channelVersion: config.channelVersion,
    botAgent: config.botAgent,
    ...(config.routeTag ? { routeTag: config.routeTag } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
