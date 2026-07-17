export type Severity = "error" | "warn";

export interface PatternMatch {
  patterns: string[];
  paths?: string[];
  exclude?: string[];
}

export interface Rule {
  id: string;
  type: string;
  severity?: Severity;
  description: string;
  match?: PatternMatch;
  [key: string]: unknown;
}

export interface Contract {
  version: number;
  rules: Rule[];
}
