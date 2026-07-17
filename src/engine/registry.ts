import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Contract } from "../config/types";
import type { RuleEngine, Violation, SourceFile } from "./types";
import { PatternEngine } from "./pattern-engine";
import { SemgrepEngine, safeJoin } from "./semgrep";

export class EngineRegistry {
  private engines: RuleEngine[] = [];

  constructor() {
    // SemgrepEngine first: it takes over `pattern` rules when the CLI is present,
    // otherwise PatternEngine (zero-dep) handles them.
    this.register(new SemgrepEngine());
    this.register(new PatternEngine());
  }

  register(engine: RuleEngine): void {
    this.engines.push(engine);
  }

  private engineFor(type: string): RuleEngine | undefined {
    return this.engines.find((e) => e.supports(type));
  }

  async run(files: SourceFile[], contract: Contract): Promise<Violation[]> {
    // Only materialize the source tree to disk when some rule will be handled by
    // a disk-based engine (Semgrep). Zero-dep pattern-only scans never touch the
    // filesystem (audit P2-B). Engines that need disk (Semgrep) fall back to
    // writing their own temp dir when `baseDir` is undefined.
    const needsDisk = contract.rules.some((r) => this.engineFor(r.type)?.needsDisk === true);
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
        const engine = this.engineFor(rule.type);
        if (!engine) {
          console.warn(
            `[warn] no engine for rule type "${rule.type}" (rule "${rule.id}") — skipping`,
          );
          continue;
        }
        all.push(...(await engine.scan(files, rule, dir)));
      }
      return all;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}
