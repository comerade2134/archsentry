import type { Contract } from "../config/types";
import type { RuleEngine, Violation, SourceFile } from "./types";
import { PatternEngine } from "./pattern-engine";
import { SemgrepEngine } from "./semgrep";

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
    const all: Violation[] = [];
    for (const rule of contract.rules) {
      const engine = this.engineFor(rule.type);
      if (!engine) {
        console.warn(
          `[warn] no engine for rule type "${rule.type}" (rule "${rule.id}") — skipping`,
        );
        continue;
      }
      all.push(...(await engine.scan(files, rule)));
    }
    return all;
  }
}
