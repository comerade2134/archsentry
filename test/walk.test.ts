import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkSourceFiles } from "../src/analyze/walk";

describe("walkSourceFiles", () => {
  it("finds files and skips node_modules/.git/dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "archsentry-walk-"));
    writeFileSync(join(dir, "a.ts"), "x");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.ts"), "y");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "c.ts"), "z");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "d.ts"), "w");

    const files = walkSourceFiles(dir);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("a.ts");
    expect(paths).toContain(join("sub", "b.ts").split("\\").join("/"));
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});
