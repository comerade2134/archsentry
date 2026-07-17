import { describe, it, expect } from "vitest";
import { PatternEngine } from "../src/engine/pattern-engine";
import type { Rule } from "../src/config/types";
import type { SourceFile } from "../src/engine/types";

const files: SourceFile[] = [
  {
    path: "controllers/a.ts",
    absolutePath: "",
    content: 'await db.query("INSERT INTO users VALUES (1)");',
  },
  {
    path: "repositories/b.ts",
    absolutePath: "",
    content: 'db.query("INSERT INTO users VALUES (1)");',
  },
];

const rule: Rule = {
  id: "no-direct-sql",
  type: "pattern",
  severity: "error",
  description: "no direct sql",
  match: {
    patterns: ["INSERT INTO", "db.query("],
    paths: ["**/*.ts"],
    exclude: ["**/repositories/**"],
  },
};

describe("PatternEngine", () => {
  it("flags violations outside excluded paths", () => {
    const engine = new PatternEngine();
    const v = engine.scan(files, rule);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe("controllers/a.ts");
    expect(v[0]?.severity).toBe("error");
  });

  it("ignores files in excluded paths", () => {
    const engine = new PatternEngine();
    const onlyRepo = engine.scan([files[1] as SourceFile], rule);
    expect(onlyRepo).toHaveLength(0);
  });

  it("reports the correct line number", () => {
    const engine = new PatternEngine();
    const multi: SourceFile[] = [
      {
        path: "c.ts",
        absolutePath: "",
        content: 'const x = 1;\nconst y = 2;\ndb.query("SELECT 1");\n',
      },
    ];
    const v = engine.scan(multi, rule);
    expect(v[0]?.line).toBe(3);
  });

  it("reports every violating line, not just the first", () => {
    const engine = new PatternEngine();
    const multi: SourceFile[] = [
      {
        path: "c.ts",
        absolutePath: "",
        content:
          'db.query("INSERT INTO a");\ndb.query("INSERT INTO b");\ndoThing();\ndb.query("INSERT INTO c");',
      },
    ];
    const v = engine.scan(multi, rule);
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.line)).toEqual([1, 2, 4]);
  });
});
