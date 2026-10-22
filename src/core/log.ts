/**
 * Structured logs. Callers must not pass message bodies, bot tokens,
 * context tokens, webhook keys, or QR secrets in `fields`.
 */
export type LogFields = Record<string, string | number | boolean | null>;

/** Write one info log line as JSON. */
export function logInfo(msg: string, fields?: LogFields): void {
  console.log(JSON.stringify({ level: "info", msg, ...fields }));
}

/** Write one warning log line as JSON. */
export function logWarn(msg: string, fields?: LogFields): void {
  console.warn(JSON.stringify({ level: "warn", msg, ...fields }));
}

/** Write one error log line as JSON. */
export function logError(msg: string, fields?: LogFields): void {
  console.error(JSON.stringify({ level: "error", msg, ...fields }));
}

/** Short, token-free description of an error for logs. */
export function publicError(err: unknown): string {
  const message = err instanceof Error ? err.message : "unknown";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240);
}
