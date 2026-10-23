import { decode } from "silk-wasm";

import { logWarn, publicError } from "../core/log.js";

/**
 * Decode WeChat SILK to mono PCM s16le using silk-wasm.
 * Returns null when the bytes are not decodable SILK. The Worker does not call this.
 */
export async function decodeSilkPcm(bytes: Uint8Array, sampleRate: number): Promise<Uint8Array | null> {
  try {
    const result = await decode(bytes, sampleRate);
    if (!result.data || result.data.byteLength === 0) return null;
    return result.data;
  } catch (err) {
    logWarn("silk_decode_failed", { error: publicError(err) });
    return null;
  }
}
