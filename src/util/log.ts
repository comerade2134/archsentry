// Minimal logger contract, compatible with Probot's `context.log` / `app.log`
// (pino-like). Centralising it lets the engine layer accept an injected logger so
// production runs route through Probot, while the CLI / standalone paths fall back
// to a console-backed default (DX polish, Phase 1.1 — production logging must use
// the Probot application logger, never raw `console.*`).
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (msg, ...args) => console.log(`[archsentry] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[archsentry] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[archsentry] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[archsentry] ${msg}`, ...args),
};
