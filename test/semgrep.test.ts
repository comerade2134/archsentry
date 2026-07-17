import { describe, it, expect } from "vitest";
import { SemgrepEngine, toSemgrepRule } from "../src/engine/semgrep";
import type { Rule } from "../src/config/types";

describe("SemgrepEngine", () => {
  const engine = new SemgrepEngine();

  it("claims semgrep type rules", () => {
    expect(engine.supports("semgrep")).toBe(true);
  });

  it("translates a pattern rule into a Semgrep rule", () => {
    const rule: Rule = {
      id: "no-direct-db-access",
      type: "pattern",
      severity: "error",
      description: "Controllers must go through a service.",
      match: {
        patterns: [".db.", ".query("],
        paths: ["src/controllers/**"],
        exclude: ["src/db/**"],
      },
    };
    const sg = toSemgrepRule(rule) as Record<string, unknown>;
    expect(sg.id).toBe("no-direct-db-access");
    expect(sg.severity).toBe("ERROR");
    expect(sg["pattern-regex"]).toBe("\\.db\\.|\\.query\\(");
    expect((sg.paths as Record<string, string[]>).include).toEqual(["src/controllers/**"]);
    expect((sg.paths as Record<string, string[]>).exclude).toEqual(["src/db/**"]);
  });

  it("rejects a semgrep rule when the CLI is missing", async () => {
    if (engine.supports("pattern")) {
      // Semgrep is actually installed — skip the "missing CLI" assertion.
      return;
    }
    const rule: Rule = {
      id: "no-raw-sql",
      type: "semgrep",
      severity: "error",
      description: "No raw SQL.",
      semgrep: { "pattern-regex": "SELECT", languages: ["typescript"] },
    };
    await expect(engine.scan([{ path: "a.ts", absolutePath: "a.ts", content: "SELECT" }], rule)).rejects.toThrow(
      /Semgrep is not installed/,
    );
  });
});
