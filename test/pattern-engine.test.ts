import { describe, it, expect } from "vitest";
import { PatternEngine, globToRegExp } from "../src/engine/pattern-engine";
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

  it("globToRegExp anchors and handles **/", () => {
    expect(globToRegExp("**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.js")).toBe(false);
    expect(globToRegExp("**/repositories/**").test("src/repositories/x.ts")).toBe(true);
  });

  it("scopes pattern rules to code files when paths are omitted", () => {
    const engine = new PatternEngine();
    const unscoped: Rule = {
      id: "r",
      type: "pattern",
      severity: "error",
      description: "d",
      match: { patterns: ["INSERT"] },
    };
    const files: SourceFile[] = [
      { path: "a.ts", absolutePath: "", content: '"INSERT"' },
      { path: "lock.json", absolutePath: "", content: '"INSERT"' },
    ];
    const v = engine.scan(files, unscoped);
    expect(v.map((x) => x.file)).toEqual(["a.ts"]);
  });

  it("matches lines split on CRLF without leaking carriage returns", () => {
    const engine = new PatternEngine();
    const rule: Rule = {
      id: "r",
      type: "pattern",
      severity: "error",
      description: "d",
      match: { patterns: ["INSERT"], paths: ["**/*.ts"] },
    };
    const content = 'const a = 1;\r\nconst b = "INSERT INTO x";\r\nconst c = 2;\r\n';
    const v = engine.scan([{ path: "c.ts", absolutePath: "", content }], rule);
    expect(v).toHaveLength(1);
    expect(v[0]?.snippet).toBe('const b = "INSERT INTO x";');
    expect(v[0]?.snippet).not.toContain("\r");
  });
});
