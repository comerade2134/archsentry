import { describe, it, expect } from "vitest";
import { analyzeSources } from "../src/analyze/analyzer";
import { parseContract } from "../src/config/loader";

const contract = parseContract(`version: 1
rules:
  - id: no-direct-sql
    type: pattern
    severity: error
    description: "no direct sql"
    match:
      patterns: ["INSERT INTO"]
      paths: ["**/*.ts"]
`);

describe("analyzeSources (in-memory)", () => {
  it("flags a violation from a code-string map", async () => {
    const v = await analyzeSources(
      { "src/controllers/a.ts": 'db.query("INSERT INTO users VALUES (1)");' },
      contract,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe("src/controllers/a.ts");
  });

  it("returns no violations when the code is clean", async () => {
    const v = await analyzeSources({ "src/repositories/b.ts": "const x = 1;" }, contract);
    expect(v).toHaveLength(0);
  });

  it("respects the exclude glob", async () => {
    const c = parseContract(`version: 1
rules:
   - id: no-direct-sql
     type: pattern
     severity: error
     description: d
     match:
       patterns: ["INSERT INTO"]
       paths: ["**/*.ts"]
       exclude: ["**/repositories/**"]
`);
    const v = await analyzeSources(
      { "src/repositories/b.ts": 'db.query("INSERT INTO users VALUES (1)");' },
      c,
    );
    expect(v).toHaveLength(0);
  });
});
