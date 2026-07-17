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
  scan(files: SourceFile[], rule: Rule): Violation[] | Promise<Violation[]>;
}

export type { Severity } from "../config/types";
