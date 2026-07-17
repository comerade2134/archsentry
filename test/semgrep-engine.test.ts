import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeJoin, SemgrepEngine } from "../src/engine/semgrep";
import type { Rule } from "../src/config/types";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("1.0.0")),
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const execFileMock = execFile as unknown as Mock;
type Cb = (e: unknown, stdout: string, stderr: string) => void;

const sgRule: Rule = {
  id: "r1",
  type: "semgrep",
  severity: "error",
  description: "d",
  semgrep: { "pattern-regex": "SELECT", languages: ["typescript"] },
};

beforeEach(() => {
  execFileMock.mockImplementation((_c: string, _a: unknown, cb: Cb) =>
    cb(null, '{"results":[]}', ""),
  );
});

describe("safeJoin (path containment)", () => {
  const dir = mkdtempSync(join(tmpdir(), "archsentry-sj-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps contained relative paths", () => {
    expect(safeJoin(dir, "src/a.ts")).toBe(join(dir, "src/a.ts"));
  });
  it("rejects absolute paths", () => {
    expect(safeJoin(dir, "/etc/cron")).toBeNull();
  });
  it("rejects parent traversal", () => {
    expect(safeJoin(dir, "../../etc/cron")).toBeNull();
  });
  it("rejects escape via inner traversal", () => {
    expect(safeJoin(dir, "a/../../b")).toBeNull();
  });
});

describe("SemgrepEngine (mocked)", () => {
  const engine = new SemgrepEngine();

  it("parses findings from semgrep JSON", async () => {
    execFileMock.mockImplementation((_c: string, _a: unknown, cb: Cb) =>
      cb(
        null,
        JSON.stringify({
          results: [
            {
              path: "src/a.ts",
              start: { line: 3 },
              extra: { message: "no sql", lines: "SELECT 1" },
            },
          ],
        }),
        "",
      ),
    );
    const out = await engine.scan(
      [{ path: "src/a.ts", absolutePath: "src/a.ts", content: "SELECT 1" }],
      sgRule,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("src/a.ts");
    expect(out[0]?.line).toBe(3);
  });

  it("does not crash on nested file paths (creates parent dirs)", async () => {
    execFileMock.mockImplementation((_c: string, _a: unknown, cb: Cb) =>
      cb(null, '{"results":[]}', ""),
    );
    const out = await engine.scan(
      [{ path: "src/controllers/a.ts", absolutePath: "src/controllers/a.ts", content: "x" }],
      sgRule,
    );
    expect(out).toEqual([]);
  });

  it("rejects when semgrep crashes with no output (never reports clean)", async () => {
    execFileMock.mockImplementation((_c: string, _a: unknown, cb: Cb) =>
      cb(new Error("boom"), "", "fatal: bad rule"),
    );
    await expect(
      engine.scan([{ path: "a.ts", absolutePath: "a.ts", content: "x" }], sgRule),
    ).rejects.toThrow(/Semgrep failed/);
  });

  it("rejects when semgrep is not installed (ENOENT)", async () => {
    execFileMock.mockImplementation((_c: string, _a: unknown, cb: Cb) => {
      const e = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      cb(e, "", "");
    });
    await expect(
      engine.scan([{ path: "a.ts", absolutePath: "a.ts", content: "x" }], sgRule),
    ).rejects.toThrow(/Semgrep is not installed/);
  });
});
