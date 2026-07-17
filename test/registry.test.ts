import { describe, it, expect, vi } from "vitest";
import type { Contract, Rule } from "../src/config/types";
import type { SourceFile } from "../src/engine/types";

// Wrap writeFileSync so we can assert whether the registry materializes the
// source tree to disk (audit P2-B). We mock it module-wide for this file only.
const writeFileSyncMock = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  };
});

import { EngineRegistry } from "../src/engine/registry";

const patternRule: Rule = {
  id: "r",
  type: "pattern",
  severity: "error",
  description: "d",
  match: { patterns: ["INSERT"] },
};

describe("EngineRegistry disk materialization (audit P2-B)", () => {
  it("writes nothing to disk for pattern-only contracts (zero-dep path)", async () => {
    writeFileSyncMock.mockClear();
    const contract: Contract = { version: 1, rules: [patternRule] };
    const files: SourceFile[] = [{ path: "a.ts", content: '"INSERT"' }];
    const reg = new EngineRegistry();
    const out = await reg.run(files, contract);
    expect(out.length).toBeGreaterThan(0); // pattern engine still ran
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("does NOT materialize a tree for a semgrep rule when the tool is absent", async () => {
    // The only disk-needing engine is SemgrepEngine. With no `semgrep` binary
    // on PATH, `supports` returns false, so the registry must skip the rule
    // cleanly and never mount the source tree to disk (audit P2-B / P1-3).
    writeFileSyncMock.mockClear();
    const contract: Contract = {
      version: 1,
      rules: [
        {
          id: "d",
          type: "semgrep" as "pattern",
          severity: "error",
          description: "d",
          semgrep: { patterns: ["INSERT"] },
        },
      ],
    };
    const files: SourceFile[] = [{ path: "a.ts", content: "x" }];
    const reg = new EngineRegistry();
    const out = await reg.run(files, contract);
    expect(out).toEqual([]); // no semgrep binary → no detections, clean skip
    expect(writeFileSyncMock).not.toHaveBeenCalled(); // nothing mounted to disk
  });
});
