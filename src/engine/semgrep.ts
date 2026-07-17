import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, normalize, sep } from "node:path";
import { stringify } from "yaml";
import type { Rule } from "../config/types";
import type { RuleEngine, SourceFile, Violation } from "./types";

let _available: boolean | null = null;
function semgrepAvailable(): boolean {
  if (_available !== null) return _available;
  try {
    execFileSync("semgrep", ["--version"], { stdio: "ignore" });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Translate our structured `pattern` rule into a Semgrep rule (regex match).
export function toSemgrepRule(rule: Rule): Record<string, unknown> {
  const match = (rule.match ?? {}) as { patterns?: string[]; paths?: string[]; exclude?: string[] };
  const patterns = match.patterns ?? [];
  const out: Record<string, unknown> = {
    id: rule.id,
    severity: rule.severity === "warn" ? "WARNING" : "ERROR",
    message: rule.description,
    languages: ["typescript", "javascript"],
    "pattern-regex": patterns.map(escapeRegex).join("|"),
  };
  const paths: Record<string, string[]> = {};
  if (match.paths) paths.include = match.paths;
  if (match.exclude) paths.exclude = match.exclude;
  if (Object.keys(paths).length) out.paths = paths;
  return out;
}

// Contain a file path inside `dir`. File paths come from the PR (attacker-
// controlled in the GitHub App path) or disk, so we must reject absolute paths
// and any `..` sequence that escapes the temp dir — otherwise writeFileSync
// would let a malicious PR write arbitrary files on the bot host.
export function safeJoin(dir: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  const abs = join(dir, normalize(p));
  if (abs !== dir && !abs.startsWith(dir + sep)) return null;
  return abs;
}

interface SemgrepResult {
  path: string;
  start: { line: number };
  extra: { message: string; lines?: string };
}

export class SemgrepEngine implements RuleEngine {
  // Claims `semgrep` rules always, and `pattern` rules only when the CLI exists
  // — so it transparently takes over from PatternEngine once Semgrep is installed.
  supports(type: string): boolean {
    if (type === "semgrep") return true;
    if (type === "pattern") return semgrepAvailable();
    return false;
  }

  async scan(files: SourceFile[], rule: Rule): Promise<Violation[]> {
    let sgRule: Record<string, unknown>;
    if (rule.type === "pattern") {
      sgRule = toSemgrepRule(rule);
    } else {
      const native = (rule as Record<string, unknown>).semgrep as
        Record<string, unknown> | undefined;
      if (!native) throw new Error(`Rule "${rule.id}" has type "semgrep" but no "semgrep" field.`);
      sgRule = {
        id: rule.id,
        severity: rule.severity === "warn" ? "WARNING" : "ERROR",
        message: rule.description,
        ...native,
      };
    }

    const dir = mkdtempSync(join(tmpdir(), "archsentry-"));
    try {
      for (const f of files) {
        const target = safeJoin(dir, f.path);
        if (!target) {
          console.warn(`[archsentry] skipping unsafe path: ${f.path}`);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content);
      }
      const ruleFile = join(dir, "rule.yml");
      writeFileSync(ruleFile, stringify({ rules: [sgRule] }));

      const stdout = await runSemgrep(ruleFile, dir);
      const parsed = JSON.parse(stdout || '{"results":[]}') as { results?: SemgrepResult[] };
      const normDir = dir.replace(/\\/g, "/");
      return (parsed.results ?? []).map((r) => {
        const p = r.path.replace(/\\/g, "/");
        const file = p.startsWith(normDir) ? p.slice(normDir.length).replace(/^\//, "") : p;
        return {
          ruleId: rule.id,
          severity: (rule.severity ?? "error") as Violation["severity"],
          file,
          line: r.start.line,
          snippet: (r.extra.lines ?? "").trim(),
          message: r.extra.message || rule.description,
        };
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function runSemgrep(ruleFile: string, dir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "semgrep",
      ["scan", "--config", ruleFile, "--json", "--quiet", dir],
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              "Semgrep is not installed. Install it with `pip install semgrep` or `uv tool install semgrep`.",
            ),
          );
          return;
        }
        // Semgrep exits 1 when it finds matches — stdout still holds valid JSON, so
        // a non-zero exit WITH output is the expected "has findings" case (not a failure).
        // A genuine failure (malformed rule, internal crash) exits non-zero with empty
        // stdout; treat that as a hard error so we never falsely report "clean".
        if (err && !stdout) {
          reject(new Error(`Semgrep failed: ${(stderr || err.message).trim()}`));
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}
