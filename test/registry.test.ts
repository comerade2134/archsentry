import { describe, it, expect, vi } from "vitest";
import type { Contract, Rule } from "../src/config/types";
import type { SourceFile, Violation } from "../src/engine/types";

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

  it("materializes the tree when a disk engine is involved", async () => {
    writeFileSyncMock.mockClear();
    const diskEngine = {
      needsDisk: true,
      supports: (t: string) => t === "disk",
      scan: async (_f: SourceFile[], _r: Rule): Promise<Violation[]> => [],
    };
    const contract: Contract = {
      version: 1,
      rules: [{ id: "d", type: "disk" as "pattern", severity: "error", description: "d" }],
    };
    const files: SourceFile[] = [{ path: "a.ts", content: "x" }];
    const reg = new EngineRegistry();
    reg.register(diskEngine as never);
    await reg.run(files, contract);
    expect(writeFileSyncMock).toHaveBeenCalled();
  });
});
