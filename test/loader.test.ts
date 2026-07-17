import { describe, it, expect } from "vitest";
import { loadContract } from "../src/config/loader";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("loadContract", () => {
  it("loads a valid contract", () => {
    const tmp = join(process.cwd(), "test", ".tmp-contract.yml");
    writeFileSync(tmp, "version: 1\nrules:\n  - id: r1\n    type: pattern\n    description: d\n");
    const c = loadContract(tmp);
    expect(c.version).toBe(1);
    expect(c.rules[0]?.id).toBe("r1");
    rmSync(tmp);
  });

  it("throws when rules array is empty", () => {
    const tmp = join(process.cwd(), "test", ".tmp-bad.yml");
    writeFileSync(tmp, "version: 1\nrules: []\n");
    expect(() => loadContract(tmp)).toThrow();
    rmSync(tmp);
  });

  it("throws when a rule lacks a description", () => {
    const tmp = join(process.cwd(), "test", ".tmp-bad2.yml");
    writeFileSync(tmp, "version: 1\nrules:\n  - id: r1\n    type: pattern\n");
    expect(() => loadContract(tmp)).toThrow();
    rmSync(tmp);
  });
});
