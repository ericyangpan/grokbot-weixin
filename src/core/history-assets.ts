import { historyPlayerSource } from "./history-player.js";

/** Same-origin files under `/history` so the view cookie's path still applies. */
export const HISTORY_ASSET_PATHS = ["/history/player.js", "/history/silk.js", "/history/silk.wasm"] as const;

export type HistoryAssetName = "player.js" | "silk.js" | "silk.wasm";

let glue: Uint8Array | null = null;
let wasm: Uint8Array | null = null;

/**
 * Remember the silk-wasm glue and the wasm bytes. The Worker stores them as
 * static modules and never calls `decode`. Node reads the package from disk.
 */
export function installSilkLibrary(js: string | Uint8Array, bytes: ArrayBuffer | Uint8Array): void {
  glue = typeof js === "string" ? new TextEncoder().encode(js) : copyBytes(js);
  wasm = bytes instanceof Uint8Array ? copyBytes(bytes) : new Uint8Array(bytes);
}

export function historyAssetName(path: string): HistoryAssetName | null {
  if (path === "/history/player.js") return "player.js";
  if (path === "/history/silk.js") return "silk.js";
  if (path === "/history/silk.wasm") return "silk.wasm";
  return null;
}

/** A fresh copy, or null when the silk-wasm files were not installed. */
export function historyAssetBody(name: HistoryAssetName): Uint8Array | null {
  if (name === "player.js") return new TextEncoder().encode(historyPlayerSource());
  if (name === "silk.js") return glue ? copyBytes(glue) : null;
  return wasm ? copyBytes(wasm) : null;
}

export function historyAssetType(name: HistoryAssetName): string {
  if (name === "silk.wasm") return "application/wasm";
  return "text/javascript; charset=utf-8";
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
