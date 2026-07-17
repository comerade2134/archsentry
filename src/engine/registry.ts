import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Contract } from "../config/types";
import type { RuleEngine, Violation, SourceFile } from "./types";
import { PatternEngine } from "./pattern-engine";
import { SemgrepEngine, safeJoin, probeSemgrep } from "./semgrep";
import { consoleLogger, type Logger } from "../util/log";

/**
 * Resolves and dispatches the appropriate {@link RuleEngine} for each rule in a
 * contract. The registry is the single place that decides which engines exist
 * for a given contract and owns the lifecycle of the temporary source tree that
 * disk-based engines (Semgrep) require.
 *
 * Resolution is asynchronous: Semgrep is only registered when (a) the contract
 * actually contains a `semgrep` rule AND (b) the CLI is installed — discovered
 * via an async probe, so we never block the event loop with a synchronous
 * subprocess spawn (audit P1-3). The zero-dependency {@link PatternEngine} is
 * always present, keeping pattern-only scans fully in-memory and dependency-free.
 *
 * A `logger` may be injected so production runs route warnings through Probot's
 * `context.log`; it defaults to a console-backed logger for the CLI.
 */
export class EngineRegistry {
  // Resolve the engine set for a given contract. Semgrep is only registered
  // when (a) the contract actually contains a `semgrep` rule AND (b) the CLI is
  // available — determined by an async probe, so we never block the event loop
  // with a synchronous subprocess spawn (audit P1-3). PatternEngine is always
  // present and zero-dep.
  private async resolveEngines(contract: Contract, logger: Logger): Promise<RuleEngine[]> {
    const engines: RuleEngine[] = [];
    if (contract.rules.some((r) => r.type === "semgrep") && (await probeSemgrep())) {
      engines.push(new SemgrepEngine(logger));
    }
    engines.push(new PatternEngine(logger));
    return engines;
  }

  /**
   * Scan `files` against every rule in `contract`.
   * @param files In-memory source files (path + content) to scan.
   * @param contract The parsed rule contract.
   * @param signal Optional abort signal; forwarded to engines so a timed-out
   *   scan can also kill any long-running child process (e.g. Semgrep, audit P2-2).
   * @param logger Logger for engine/registry diagnostics. Defaults to console.
   */
  async run(
    files: SourceFile[],
    contract: Contract,
    signal?: AbortSignal,
    logger: Logger = consoleLogger,
  ): Promise<Violation[]> {
    const engines = await this.resolveEngines(contract, logger);
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
          logger.warn(`no engine for rule type "${rule.type}" (rule "${rule.id}") — skipping`);
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
