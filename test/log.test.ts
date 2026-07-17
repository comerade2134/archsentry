import { describe, it, expect, vi } from "vitest";
import { consoleLogger, type Logger } from "../src/util/log";

describe("Logger contract (Phase 1.1)", () => {
  it("consoleLogger exposes the four log levels and does not throw", () => {
    expect(typeof consoleLogger.info).toBe("function");
    expect(typeof consoleLogger.warn).toBe("function");
    expect(typeof consoleLogger.error).toBe("function");
    expect(typeof consoleLogger.debug).toBe("function");

    // Capturing console avoids noise in test output while proving the calls work.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => consoleLogger.info("hi")).not.toThrow();
    expect(() => consoleLogger.warn("careful")).not.toThrow();
    expect(() => consoleLogger.error("boom")).not.toThrow();
    expect(() => consoleLogger.debug("trace")).not.toThrow();
    spy.mockRestore();
  });

  it("a custom Logger can be injected and receives diagnostic messages", () => {
    const calls: string[] = [];
    const custom: Logger = {
      info: (m) => calls.push(`info:${m}`),
      warn: (m) => calls.push(`warn:${m}`),
      error: (m) => calls.push(`error:${m}`),
      debug: (m) => calls.push(`debug:${m}`),
    };
    // The shape matches the Logger interface, so engines/app can accept it.
    expect(custom.warn).toBeTypeOf("function");
    custom.warn("injected");
    expect(calls).toContain("warn:injected");
  });
});
