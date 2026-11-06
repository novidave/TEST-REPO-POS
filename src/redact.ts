/** Structured-log secret redaction. Applied to every audit log entry before it is stored. */
const SECRET_KEY =
  /pass(word)?|secret|token|authori[sz]ation|api[-_]?key|apikey|credential|cookie|session|private[-_]?key|pairing[-_]?code|^code$/i;
const SECRET_VALUE: [RegExp, string][] = [
  [/\bcdt_[A-Za-z0-9_-]{8,}/g, "cdt_[redacted]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  [/\b(shpat|shpca|shppa|shpss)_[A-Za-z0-9]{8,}/g, "$1_[redacted]"],
  [/\b(ck|cs)_[a-f0-9]{20,}\b/gi, "$1_[redacted]"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/([?&](?:token|key|secret|password|signature|sig|access_token|consumer_key|consumer_secret)=)[^&\s]+/gi, "$1[redacted]"],
  [/(password|pwd|secret|token|api[-_]?key)\s*[=:]\s*[^\s;,&]+/gi, "$1=[redacted]"],
];
export function redactText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_VALUE)
    result = result.replace(pattern, replacement);
  return result.length > 2000 ? result.slice(0, 2000) + "…" : result;
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1),
      ]),
    );
  return value;
}
export type LogLevel = "info" | "warning" | "error";
export type LogCategory =
  | "connection"
  | "read"
  | "export"
  | "sync"
  | "retry"
  | "validation"
  | "cloud"
  | "settings"
  | "inventory";
/** Stable classification of existing and new audit events for filtering in Logs. */
export function classify(event: string): { level: LogLevel; category: LogCategory } {
  const level: LogLevel =
    /failed|error|rejected/.test(event)
      ? "error"
      : /held|deferred|skipped|conflict|paused|warning|not_available|retry/.test(event)
        ? "warning"
        : "info";
  const category: LogCategory = /^cloud_/.test(event)
    ? "cloud"
    : /retry|deferred/.test(event)
      ? "retry"
      : /^export_|local_export/.test(event)
        ? event === "export_held"
          ? "validation"
          : "export"
        : /^connection_/.test(event)
          ? event === "connection_test"
            ? "read"
            : "connection"
          : /^read_/.test(event)
            ? "read"
            : /^settings_|scheduler_/.test(event)
              ? "settings"
              : /^inventory_/.test(event)
                ? "inventory"
                : /validation/.test(event)
                  ? "validation"
                  : "sync";
  return { level, category };
}
