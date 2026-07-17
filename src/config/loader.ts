import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Contract, Rule, Severity } from "./types";

const VALID_SEVERITIES: readonly Severity[] = ["error", "warn"];
const VALID_TYPES = ["pattern", "semgrep"] as const;

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
  if (!Array.isArray(root.rules) || root.rules.length === 0) {
    throw new ConfigError('Config "rules" must be a non-empty array.');
  }

  const rules = root.rules.map((r, i) => validateRule(r, i));
  return { version: root.version, rules };
}

function validateRule(raw: unknown, index: number): Rule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Rule at index ${index} must be a mapping.`);
  }
  const r = raw as Record<string, unknown>;
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
  }

  if (r.type === "semgrep") {
    const sg = r.semgrep as Record<string, unknown> | undefined;
    if (!sg || typeof sg !== "object" || Object.keys(sg).length === 0) {
      throw new ConfigError(
        `${where} (type "semgrep") requires a non-empty "semgrep" mapping (e.g. pattern / patterns / pattern-either).`,
      );
    }
  }

  // Centralize the default severity so every engine sees the same value.
  // Fail-closed: a rule you explicitly wrote to enforce blocks the merge by
  // default ("error") rather than merely warning.
  if (r.severity === undefined) r.severity = "error";

  return r as unknown as Rule;
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
