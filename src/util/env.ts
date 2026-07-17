import { consoleLogger, type Logger } from "./log";

// Parse an integer from an env var, falling back to `def` when the var is
// missing or not a clean integer. A malformed value (e.g. "abc" or "12.5")
// previously produced NaN via Number(...), which silently disabled safety caps
// (audit P3-E). Here a non-integer resolves to the default instead.
export function envInt(name: string, def: number, log: Logger = consoleLogger): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    log.warn(`${name}="${raw}" is not an integer; using default ${def}`);
    return def;
  }
  return n;
}
