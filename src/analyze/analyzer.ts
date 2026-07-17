import type { Contract } from "../config/types";
import { walkSourceFiles } from "./walk";
import { EngineRegistry } from "../engine/registry";
import type { Violation, SourceFile } from "../engine/types";

// Filesystem-backed scan (used by the CLI).
export async function analyze(root: string, contract: Contract): Promise<Violation[]> {
  return runEngine(walkSourceFiles(root), contract);
}

// In-memory scan (used by the GitHub App). The engine is path-agnostic:
// it only ever sees a list of { path, content }, so the source can be a
// local file tree OR raw strings pulled straight from the GitHub API.
export async function analyzeSources(
  sources: Record<string, string>,
  contract: Contract,
): Promise<Violation[]> {
  const files: SourceFile[] = Object.entries(sources).map(([path, content]) => ({
    path,
    content,
  }));
  return runEngine(files, contract);
}

async function runEngine(files: SourceFile[], contract: Contract): Promise<Violation[]> {
  const registry = new EngineRegistry();
  return registry.run(files, contract);
}
