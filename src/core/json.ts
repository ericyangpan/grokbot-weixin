const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * Parse an iLink JSON body, quoting uint64 id fields before JSON.parse.
 * The approach matches Tencent openclaw-weixin (MIT), which rewrites those
 * properties so values above 2^53-1 stay exact. Text inside JSON strings is left alone.
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  const output: string[] = [];
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output.push(rawText[index] ?? "");
      index += 1;
      continue;
    }

    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index] ?? "";
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output.push(stringToken);

    let cursor = index;
    while (isWhitespace(rawText[cursor])) cursor += 1;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output.push(rawText.slice(index, cursor + 1));
    cursor += 1;
    while (isWhitespace(rawText[cursor])) {
      output.push(rawText[cursor] ?? "");
      cursor += 1;
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor += 1;
    while (isDigit(rawText[cursor])) cursor += 1;
    const bareMinus = cursor === numberStart + 1 && rawText[numberStart] === "-";
    if (cursor > numberStart && !bareMinus) {
      output.push(`"${rawText.slice(numberStart, cursor)}"`);
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output.join("")) as T;
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}
