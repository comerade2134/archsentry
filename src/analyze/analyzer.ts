import type { Contract } from "../config/types";
import { walkSourceFiles } from "./walk";
import { EngineRegistry } from "../engine/registry";
import type { Violation, SourceFile } from "../engine/types";

// Lazily-created singleton registry (audit P3-7): constructing per-scan is
// cheap now that engine resolution is async, but a single shared instance
// shaves allocations under high concurrency.
let _registry: EngineRegistry | null = null;
function getRegistry(): EngineRegistry {
  if (!_registry) _registry = new EngineRegistry();
  return _registry;
}

// Filesystem-backed scan (used by the CLI).
export async function analyze(root: string, contract: Contract): Promise<Violation[]> {
  return runEngine(walkSourceFiles(root), contract);
}

// In-memory scan (used by the GitHub App). The engine is path-agnostic:
// it only ever sees a list of { path, content }, so the source can be a
// local file tree OR raw strings pulled straight from the GitHub API.
// `signal` lets the caller abort a long-running scan (e.g. an aborted Semgrep
// subprocess, audit P2-2).
export async function analyzeSources(
  sources: Record<string, string>,
  contract: Contract,
  signal?: AbortSignal,
): Promise<Violation[]> {
  const files: SourceFile[] = Object.entries(sources).map(([path, content]) => ({
    path,
    content,
  }));
  return runEngine(files, contract, signal);
}

async function runEngine(
  files: SourceFile[],
  contract: Contract,
  signal?: AbortSignal,
): Promise<Violation[]> {
  return getRegistry().run(files, contract, signal);
}
