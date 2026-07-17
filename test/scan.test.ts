import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diskContext } from "../src/service/scan";
import type { Violation } from "../src/engine/types";

describe("diskContext", () => {
  it("returns lines around the violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "archsentry-ctx-"));
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
    writeFileSync(join(dir, "a.ts"), content);
    const ctx = diskContext(dir);
    const v: Violation = {
      ruleId: "r",
      severity: "error",
      file: "a.ts",
      line: 5,
      snippet: "",
      message: "",
    };
    const out = ctx(v);
    expect(out).toContain("l1");
    expect(out).toContain("l10");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the snippet when the file is missing", () => {
    const ctx = diskContext("/nonexistent-dir-xyz");
    const v: Violation = {
      ruleId: "r",
      severity: "error",
      file: "a.ts",
      line: 1,
      snippet: "SNIP",
      message: "",
    };
    expect(ctx(v)).toBe("SNIP");
  });
});
