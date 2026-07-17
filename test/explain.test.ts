import { describe, it, expect } from "vitest";
import { attachExplanations } from "../src/service/scan";
import { TemplateExplainer } from "../src/explain/llm";
import type { Violation } from "../src/engine/types";

function v(ruleId: string): Violation {
  return {
    ruleId,
    severity: "error",
    file: "a.ts",
    line: 1,
    snippet: "x",
    message: "m",
  };
}

const fakeExplainer = {
  explain: async () => "LLM says fix it",
};

const throwingExplainer = {
  explain: async () => {
    throw new Error("boom");
  },
};

describe("attachExplanations", () => {
  it("skips explanation when explain is false", async () => {
    const out = await attachExplanations([v("r1")], () => "ctx", false, fakeExplainer);
    expect(out[0]?.explanation).toBeUndefined();
  });

  it("attaches the explainer output when provided", async () => {
    const out = await attachExplanations([v("r1")], () => "ctx", true, fakeExplainer);
    expect(out[0]?.explanation).toBe("LLM says fix it");
  });

  it("falls back to the template when the explainer throws", async () => {
    const out = await attachExplanations([v("r1")], () => "ctx", true, throwingExplainer);
    expect(out[0]?.explanation).toBe(await new TemplateExplainer().explain(v("r1")));
  });

  it("falls back for every violation when the explainer always throws", async () => {
    const out = await attachExplanations([v("r1"), v("r2")], () => "ctx", true, throwingExplainer);
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.explanation && x.explanation.includes("repository layer"))).toBe(
      true,
    );
  });
});
