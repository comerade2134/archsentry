export type Severity = "error" | "warn";

export interface PatternMatch {
  patterns: string[];
  // When true, `patterns` are treated as real RegExp (author owns any ReDoS
  // risk, audit P3-2). Default false → patterns are matched literally (and
  // regex-special chars are escaped), which is safe and the common case.
  regex?: boolean;
  paths?: string[];
  exclude?: string[];
}

export interface Rule {
  id: string;
  type: "pattern" | "semgrep";
  severity?: Severity;
  description: string;
  // For `pattern` rules: the regex patterns + optional path scoping.
  match?: PatternMatch;
  // For `semgrep` rules: a raw Semgrep rule body (pattern / patterns /
  // pattern-either / etc.). Typed as an open map because Semgrep's schema is
  // large and versioned; the loader validates the shape at config-parse time.
  semgrep?: Record<string, unknown>;
}

export interface Contract {
  version: number;
  rules: Rule[];
}
