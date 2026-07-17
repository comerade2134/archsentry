import { describe, it, expect } from "vitest";
import { parseContract, ConfigError } from "../src/config/loader";
import { toPrComment } from "../src/report/formatter";
import type { Violation } from "../src/engine/types";

// Consolidated hardening sweep (the final audit pass): untrusted-output
// markdown injection + config-envelope strictness.
describe("consolidated sweep", () => {
  describe("PR comment renders untrusted text as inert data", () => {
    it("fences rule message / snippet / explanation so markdown + HTML are inert", () => {
      const v: Violation = {
        ruleId: "no-xss",
        severity: "error",
        file: "a.ts",
        line: 4,
        message: "Do [not click](http://evil.example) and **ignore** @reviewer",
        snippet: "const x = <script>alert(1)</script>",
        explanation: "see [docs](http://evil.example) for details",
      };
      const comment = toPrComment([v]);

      // The attacker-controlled message must sit inside a fenced code block,
      // not as live Markdown. The raw link/mention text should still be present
      // (so it's informative) but wrapped in ``` so GitHub renders it literally.
      const msgStart = comment.indexOf("```\nDo [not click]");
      expect(msgStart).toBeGreaterThan(-1);
      expect(comment).toContain("```\nsee [docs](http://evil.example) for details\n  ```");

      // HTML must remain entity-escaped.
      expect(comment).toContain("&lt;script&gt;");
      // A stray backtick in the message can't break the fence (escaped to entity).
      const v2: Violation = { ...v, message: "backtick ` here" };
      expect(() => toPrComment([v2])).not.toThrow();
    });
  });

  describe("config envelope strictness", () => {
    it("rejects an unsupported schema version", () => {
      expect(() =>
        parseContract(
          `version: 2\nrules:\n  - id: x\n    type: pattern\n    severity: error\n` +
            `    description: d\n    match:\n      patterns: ["y"]\n`,
        ),
      ).toThrow(ConfigError);
    });

    it("rejects a ruleset above the cap", () => {
      const rules = Array.from({ length: 1001 }, (_, i) => ({
        id: `r${i}`,
        type: "pattern" as const,
        severity: "error" as const,
        description: "d",
        match: { patterns: ["x"] },
      }));
      const yaml =
        `version: 1\nrules:\n` +
        rules
          .map(
            (r) =>
              `  - id: ${r.id}\n    type: pattern\n    severity: error\n    description: d\n    match:\n      patterns: ["x"]\n`,
          )
          .join("");
      expect(() => parseContract(yaml)).toThrow(ConfigError);
    });

    it("accepts a normal v1 contract", () => {
      const c = parseContract(
        `version: 1\nrules:\n  - id: x\n    type: pattern\n    severity: error\n` +
          `    description: d\n    match:\n      patterns: ["y"]\n`,
      );
      expect(c.version).toBe(1);
      expect(c.rules).toHaveLength(1);
    });
  });
});
