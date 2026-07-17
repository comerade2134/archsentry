import { buildCli } from "../src/cli";
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("CLI scan", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OLLAMA_MODEL", "");
  });

  it("flags a violation and supports --explain without crashing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await buildCli().parseAsync(
      ["scan", "-c", "samples/dummy-target/archsentry.yml", "-p", "samples/dummy-target", "-e"],
      { from: "user" },
    );
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("no-direct-sql");
    log.mockRestore();
  });
});
