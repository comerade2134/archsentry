import type { Rule, Severity } from "../config/types";

export interface SourceFile {
  path: string;
  absolutePath: string;
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
  // `baseDir`, when provided, is a directory that already contains the source
  // tree (written once by the registry) — engines that need disk (Semgrep) scan
  // there instead of re-materializing files per rule.
  scan(files: SourceFile[], rule: Rule, baseDir?: string): Violation[] | Promise<Violation[]>;
}

export type { Severity } from "../config/types";
