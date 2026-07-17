import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Contract, Rule, Severity, PatternMatch } from "./types";

const VALID_SEVERITIES: readonly Severity[] = ["error", "warn"];
const VALID_TYPES = ["pattern", "semgrep"] as const;
// Only the v1 schema is understood today. A typo'd/forward-versioned config must
// fail closed rather than silently mis-parsing (consolidated audit sweep).
const SUPPORTED_VERSIONS = new Set([1]);
// Bound the ruleset so a malicious/buggy archsentry.yml can't trigger unbounded
// scan work (consolidated audit sweep).
const MAX_RULES = 1000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

// Thrown for any malformed archsentry.yml. Carrying its own type lets callers
// (CLI, GitHub App) print a clean message instead of a stack trace.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseContract(raw: string): Contract {
  const data = parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("Config root must be a YAML mapping with `version` and `rules`.");
  }
  const root = data as Record<string, unknown>;

  if (typeof root.version !== "number") {
    throw new ConfigError('Config is missing a numeric "version" field.');
  }
  if (!SUPPORTED_VERSIONS.has(root.version)) {
    throw new ConfigError(
      `Unsupported config version ${root.version}. Supported versions: ${[...SUPPORTED_VERSIONS].join(", ")}.`,
    );
  }
  if (!Array.isArray(root.rules) || root.rules.length === 0) {
    throw new ConfigError('Config "rules" must be a non-empty array.');
  }
  if (root.rules.length > MAX_RULES) {
    throw new ConfigError(
      `Config has ${root.rules.length} rules; the maximum is ${MAX_RULES}. Split into multiple configs or raise ARCHSENTRY_MAX_RULES.`,
    );
  }

  const rules = root.rules.map((r, i) => validateRule(r, i));

  // A duplicate rule id is almost always a copy/paste mistake. We don't fail
  // hard (a team may intentionally shadow a base rule), but we surface it so the
  // author knows enforcement semantics may not be what they expect (audit P3-H).
  const seen = new Map<string, number>();
  for (const rule of rules) {
    seen.set(rule.id, (seen.get(rule.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) console.warn(`[archsentry] duplicate rule id "${id}" (${count} occurrences).`);
  }

  return { version: root.version, rules };
}

// Known Semgrep pattern keys. A semgrep rule must declare at least one or it is
// misconfigured (it would match nothing or everything) — we reject it so the
// failure is loud instead of silently wrong (audit M4, fail-closed).
const SEMGREP_PATTERN_KEYS = [
  "pattern",
  "patterns",
  "pattern-either",
  "pattern-and",
  "pattern-not",
  "pattern-inside",
  "pattern-not-inside",
  "pattern-regex",
  "pattern-where-python",
  "metavariable-pattern",
  "metavariable-comparison",
  "fix",
  "fix-regex",
  "taint-mode",
  "mode",
];

function validateSemgrepRule(sg: unknown, where: string): void {
  if (!sg || typeof sg !== "object" || Object.keys(sg as object).length === 0) {
    throw new ConfigError(
      `${where} (type "semgrep") requires a non-empty "semgrep" mapping (e.g. pattern / patterns / pattern-either).`,
    );
  }
  const map = sg as Record<string, unknown>;
  if (!SEMGREP_PATTERN_KEYS.some((k) => k in map)) {
    throw new ConfigError(
      `${where} (type "semgrep") has no recognized Semgrep pattern key. ` +
        `Expected one of: ${SEMGREP_PATTERN_KEYS.join(", ")}.`,
    );
  }
  for (const key of [
    "patterns",
    "pattern-either",
    "pattern-and",
    "pattern-not",
    "pattern-inside",
    "pattern-not-inside",
  ]) {
    const val = map[key];
    if (val !== undefined && !Array.isArray(val)) {
      throw new ConfigError(`${where} (type "semgrep"): "${key}" must be a list.`);
    }
  }
}

function validateRule(raw: unknown, index: number): Rule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Rule at index ${index} must be a mapping.`);
  }
  // Clone before mutating so the caller's parsed object is never altered
  // (audit L4 — keeps parseContract idempotent and side-effect free).
  const r = { ...(raw as Record<string, unknown>) };
  const where = typeof r.id === "string" ? `Rule "${r.id}"` : `Rule at index ${index}`;

  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new ConfigError(`${where} is missing a non-empty string "id".`);
  }
  if (typeof r.type !== "string") {
    throw new ConfigError(`${where} is missing a string "type".`);
  }
  if (!(VALID_TYPES as readonly string[]).includes(r.type)) {
    throw new ConfigError(
      `${where} has unsupported type "${r.type}". Supported types: ${VALID_TYPES.join(", ")}.`,
    );
  }
  if (typeof r.description !== "string" || r.description.length === 0) {
    throw new ConfigError(`${where} is missing a non-empty string "description".`);
  }
  if (r.severity !== undefined && !VALID_SEVERITIES.includes(r.severity as Severity)) {
    throw new ConfigError(
      `${where} has invalid severity "${String(r.severity)}". Must be "error" or "warn".`,
    );
  }

  if (r.type === "pattern") {
    const match = (r.match ?? {}) as Record<string, unknown>;
    if (!isStringArray(match.patterns)) {
      throw new ConfigError(
        `${where} (type "pattern") requires "match.patterns" as a non-empty array of strings.`,
      );
    }
    if (match.paths !== undefined && !isStringArray(match.paths)) {
      throw new ConfigError(`${where}: "match.paths" must be an array of glob strings.`);
    }
    if (match.exclude !== undefined && !isStringArray(match.exclude)) {
      throw new ConfigError(`${where}: "match.exclude" must be an array of glob strings.`);
    }
    if (match.regex !== undefined && typeof match.regex !== "boolean") {
      throw new ConfigError(`${where}: "match.regex" must be a boolean.`);
    }
  }

  if (r.type === "semgrep") {
    validateSemgrepRule(r.semgrep, where);
  }

  // Surface typos / unknown keys instead of silently dropping them (audit P3-3).
  // A mis-typed `sev: warn` or `discription: ...` would otherwise be ignored and
  // the rule would run with surprising defaults.
  const KNOWN = new Set(["id", "type", "severity", "description", "match", "semgrep"]);
  const extra = Object.keys(r).filter((k) => !KNOWN.has(k));
  if (extra.length) {
    console.warn(`[archsentry] ${where} has unknown key(s): ${extra.join(", ")} (ignored)`);
  }

  // Centralize the default severity so every engine sees the same value.
  // Fail-closed: a rule you explicitly wrote to enforce blocks the merge by
  // default ("error") rather than merely warning.
  if (r.severity === undefined) r.severity = "error";

  // Build a fully-typed Rule from the validated fields instead of casting the
  // loose record — keeps the public type honest and avoids `as unknown as Rule`
  // (audit P3-G).
  const rule: Rule = {
    id: r.id as string,
    type: r.type as "pattern" | "semgrep",
    severity: r.severity as Severity,
    description: r.description as string,
  };
  if (r.match !== undefined) rule.match = r.match as PatternMatch;
  if (r.semgrep !== undefined) rule.semgrep = r.semgrep as Record<string, unknown>;
  return rule;
}

export function loadContract(path: string): Contract {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`Could not read config at "${path}": ${(e as Error).message}`);
  }
  return parseContract(raw);
}
