/**
 * AES-128-ECB with PKCS#7, matching openclaw-weixin's CDN download path.
 * Web Crypto has no ECB mode. One AES-CBC decrypt with a zero IV, then
 * XOR each block with the previous ciphertext block, undoes CBC chaining
 * and leaves ECB. A synthetic trailing block gives Web Crypto valid PKCS#7
 * so it returns the CBC plaintext instead of throwing.
 */

/** Decode a 32-character hex AES key into 16 bytes. */
export function decodeHexKey(hex: string): Uint8Array | null {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{32}$/.test(trimmed)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    const byte = trimmed.slice(i * 2, i * 2 + 2);
    const value = Number.parseInt(byte, 16);
    if (!Number.isInteger(value)) return null;
    out[i] = value;
  }
  return out;
}

/**
 * Decode `media.aes_key`. Accepts base64 of 16 raw bytes, or base64 of the
 * 32-character hex form used for file, voice, and video.
 */
export function parseAesKey(aesKeyBase64: string): Uint8Array | null {
  const decoded = decodeBase64(aesKeyBase64.trim());
  if (!decoded) return null;
  if (decoded.byteLength === 16) return decoded;
  if (decoded.byteLength === 32 && /^[0-9a-fA-F]{32}$/.test(latin1(decoded))) {
    return decodeHexKey(latin1(decoded));
  }
  return null;
}

/** Decrypt CDN ciphertext. Throws `bad_key`, `bad_ciphertext`, or `bad_padding`. */
export async function decryptAes128Ecb(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.byteLength !== 16) throw new Error("bad_key");
  if (ciphertext.byteLength === 0 || ciphertext.byteLength % 16 !== 0) throw new Error("bad_ciphertext");
  const data = new Uint8Array(ciphertext);
  const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const zero = new Uint8Array(16);
  const xored = new Uint8Array(16);
  const last = data.subarray(data.byteLength - 16);
  for (let i = 0; i < 16; i += 1) xored[i] = 0x10 ^ (last[i] ?? 0);
  const encryptedPad = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: zero }, cryptoKey, xored));
  if (encryptedPad.byteLength < 16) throw new Error("decrypt_failed");
  const extended = new Uint8Array(data.byteLength + 16);
  extended.set(data, 0);
  extended.set(encryptedPad.subarray(0, 16), data.byteLength);
  const cbc = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zero }, cryptoKey, extended));
  if (cbc.byteLength !== data.byteLength) throw new Error("decrypt_failed");
  const padded = new Uint8Array(cbc.byteLength);
  padded.set(cbc.subarray(0, 16), 0);
  for (let offset = 16; offset < cbc.byteLength; offset += 16) {
    const prev = data.subarray(offset - 16, offset);
    for (let i = 0; i < 16; i += 1) padded[offset + i] = (cbc[offset + i] ?? 0) ^ (prev[i] ?? 0);
  }
  return unpadPkcs7(padded);
}

/** Strip PKCS#7. Throws `bad_padding` when the trailer is not a valid pad. */
function unpadPkcs7(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0 || bytes.byteLength % 16 !== 0) throw new Error("bad_padding");
  const pad = bytes[bytes.byteLength - 1];
  if (pad === undefined || pad < 1 || pad > 16) throw new Error("bad_padding");
  for (let i = 0; i < pad; i += 1) {
    if (bytes[bytes.byteLength - 1 - i] !== pad) throw new Error("bad_padding");
  }
  return bytes.slice(0, bytes.byteLength - pad);
}

/** Decode standard or unpadded base64. Returns null on garbage. */
function decodeBase64(input: string): Uint8Array | null {
  if (!input) return null;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Latin-1 view of bytes that are known to be ASCII. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
