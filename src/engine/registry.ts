import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Contract } from "../config/types";
import type { RuleEngine, Violation, SourceFile } from "./types";
import { PatternEngine } from "./pattern-engine";
import { SemgrepEngine, safeJoin, probeSemgrep } from "./semgrep";

export class EngineRegistry {
  // Resolve the engine set for a given contract. Semgrep is only registered
  // when (a) the contract actually contains a `semgrep` rule AND (b) the CLI is
  // available — determined by an async probe, so we never block the event loop
  // with a synchronous subprocess spawn (audit P1-3). PatternEngine is always
  // present and zero-dep.
  private async resolveEngines(contract: Contract): Promise<RuleEngine[]> {
    const engines: RuleEngine[] = [];
    if (contract.rules.some((r) => r.type === "semgrep") && (await probeSemgrep())) {
      engines.push(new SemgrepEngine());
    }
    engines.push(new PatternEngine());
    return engines;
  }

  async run(files: SourceFile[], contract: Contract, signal?: AbortSignal): Promise<Violation[]> {
    const engines = await this.resolveEngines(contract);
    const engineFor = (t: string) => engines.find((e) => e.supports(t));

    // Only materialize the source tree to disk when some rule will be handled by
    // a disk-based engine (Semgrep). Zero-dep pattern-only scans never touch the
    // filesystem (audit P2-B). Engines that need disk (Semgrep) fall back to
    // writing their own temp dir when `baseDir` is undefined.
    const needsDisk = engines.some((e) => e.needsDisk === true);
    const dir = needsDisk ? mkdtempSync(join(tmpdir(), "archsentry-")) : undefined;
    try {
      if (dir) {
        for (const f of files) {
          const target = safeJoin(dir, f.path);
          if (!target) continue;
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.content);
        }
      }
      const all: Violation[] = [];
      for (const rule of contract.rules) {
        const engine = engineFor(rule.type);
        if (!engine) {
          console.warn(
            `[warn] no engine for rule type "${rule.type}" (rule "${rule.id}") — skipping`,
          );
          continue;
        }
        all.push(...(await engine.scan(files, rule, dir, signal)));
      }
      return all;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}
