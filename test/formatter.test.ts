import { describe, it, expect } from "vitest";
import { formatReport, toPrComment, type Format } from "../src/report/formatter";
import type { Violation } from "../src/engine/types";

const v: Violation = {
  ruleId: "r1",
  severity: "error",
  file: "a.ts",
  line: 2,
  snippet: "x = 1",
  message: "no raw sql",
};

describe("formatter", () => {
  it("reports clean for no violations (text)", () => {
    expect(formatReport([], "text")).toContain("no rule violations");
  });

  it("formats violations as text", () => {
    const out = formatReport([v], "text");
    expect(out).toContain("r1");
    expect(out).toContain("a.ts:2");
    expect(out).toContain("no raw sql");
  });

  it("emits JSON for the json format", () => {
    const out = formatReport([v], "json" as Format);
    const parsed = JSON.parse(out) as { violations: Violation[] };
    expect(parsed.violations[0]?.ruleId).toBe("r1");
  });

  it("builds a PR comment listing each violation", () => {
    const out = toPrComment([v]);
    expect(out).toContain("ArchSentry");
    expect(out).toContain("r1");
    expect(out).toContain("`a.ts:2`");
  });
});
