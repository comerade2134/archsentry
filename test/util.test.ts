import { describe, it, expect, vi, afterEach } from "vitest";
import { envInt } from "../src/util/env";
import { mapWithConcurrency } from "../src/util/async";

describe("envInt (audit P3-E: malformed env must not disable caps)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the parsed integer when valid", () => {
    vi.stubEnv("FOO", "42");
    expect(envInt("FOO", 7)).toBe(42);
  });

  it("returns the default for a non-integer value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("FOO", "12.5");
    expect(envInt("FOO", 7)).toBe(7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the default when unset", () => {
    expect(envInt("UNSET_VAR_XYZ", 99)).toBe(99);
  });
});

describe("mapWithConcurrency (audit P1-C / P2-E: bounded fan-out)", () => {
  it("runs at most `limit` tasks concurrently", async () => {
    let active = 0;
    let max = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(max).toBeLessThanOrEqual(2);
  });

  it("preserves input order in the output", async () => {
    const result = await mapWithConcurrency([10, 20, 30], 5, async (n) => n + 1);
    expect(result).toEqual([11, 21, 31]);
  });
});
