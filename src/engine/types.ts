import type { Rule, Severity } from "../config/types";

export interface SourceFile {
  // `path` is the project-relative path (used for matching + reporting). The
  // engine is path-agnostic: it never touches disk directly for in-memory scans.
  path: string;
  content: string;
}

export interface Violation {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number;
  snippet: string;
  message: string;
  explanation?: string;
}

export interface RuleEngine {
  supports(type: string): boolean;
  // When true the registry materializes the source tree to a temp dir and
  // passes it via `baseDir`, so the engine scans disk instead of re-deriving
  // files. PatternEngine doesn't need disk; SemgrepEngine does. Defaulting to
  // false keeps zero-dep pattern scanning off the filesystem entirely (audit P2-B).
  needsDisk?: boolean;
  // Always async so engines can yield and so callers await uniformly (audit P2-A).
  // `baseDir`, when provided, is a directory that already contains the source
  // tree (written once by the registry) — engines that need disk (Semgrep) scan
  // there instead of re-materializing files per rule. `signal` lets a caller
  // abort a long-running scan (e.g. an aborted Semgrep subprocess, audit P2-2).
  scan(
    files: SourceFile[],
    rule: Rule,
    baseDir?: string,
    signal?: AbortSignal,
  ): Promise<Violation[]>;
}

export type { Severity } from "../config/types";
