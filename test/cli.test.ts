import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildCli } from "../src/cli";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "archsentry-cli-"));
  writeFileSync(
    join(dir, "archsentry.yml"),
    'version: 1\nrules:\n  - id: r1\n    type: pattern\n    severity: error\n    description: d\n    match:\n      patterns: ["INSERT INTO"]\n',
  );
  writeFileSync(join(dir, "a.ts"), 'const q = "INSERT INTO users";');
  return dir;
}

describe("CLI exit behavior", () => {
  let dir: string;
  beforeEach(() => {
    dir = setup();
    process.exitCode = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("exits non-zero on a violation by default", async () => {
    const program = buildCli();
    await program.parseAsync(["scan", "-c", join(dir, "archsentry.yml"), "-p", dir], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
  });

  it("exits zero with --no-fail", async () => {
    const program = buildCli();
    await program.parseAsync(["scan", "-c", join(dir, "archsentry.yml"), "-p", dir, "--no-fail"], {
      from: "user",
    });
    expect(process.exitCode).toBe(0);
  });

  it("filters to error severity with -s error", async () => {
    const program = buildCli();
    await program.parseAsync(
      ["scan", "-c", join(dir, "archsentry.yml"), "-p", dir, "-s", "error"],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
  });
});
