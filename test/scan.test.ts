import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diskContext, windowedContext, attachExplanations } from "../src/service/scan";
import type { Violation } from "../src/engine/types";
import type { Explainer } from "../src/explain/llm";

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

describe("windowedContext (audit H3: never send the whole file to the LLM)", () => {
  const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns only a small window around the violation line", () => {
    const out = windowedContext(big, 100);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12); // 6 before + the line + 5 after
    expect(out).toContain("line 100");
    expect(out.startsWith("line 94")).toBe(true); // window opens near the violation
    expect(out).not.toContain("line 1\n"); // the very first line is excluded
    expect(out).not.toContain("line 200");
  });

  it("clamps to the start of the file", () => {
    const out = windowedContext(big, 1);
    expect(out.split("\n")[0]).toBe("line 1");
  });
});

describe("attachExplanations (audit P2-E: cap + bounded LLM calls)", () => {
  const violations: Violation[] = Array.from({ length: 50 }, (_, i) => ({
    ruleId: `r${i}`,
    severity: "error" as const,
    file: `f${i}.ts`,
    line: 1,
    snippet: "x",
    message: "m",
  }));

  it("only calls the (paid) explainer for the first ARCHSENTRY_MAX_EXPLAIN violations", async () => {
    const spy = vi.fn().mockResolvedValue("explanation");
    const explainer: Explainer = { explain: spy };
    const out = await attachExplanations(violations, () => "ctx", true, explainer);
    // Default cap is 30 → only 30 paid calls; the rest get the free template.
    expect(spy).toHaveBeenCalledTimes(30);
    expect(out).toHaveLength(50);
    expect(out[0]?.explanation).toBe("explanation");
    expect(out[49]?.explanation).toContain("repository layer"); // TemplateExplainer fallback
  });

  it("returns violations unchanged when explain is false", async () => {
    const spy = vi.fn();
    const out = await attachExplanations(violations, () => "ctx", false, {
      explain: spy,
    } as unknown as Explainer);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toHaveLength(50);
  });
});
