import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { stringify } from "yaml";
import type { Rule } from "../config/types";
import type { RuleEngine, SourceFile, Violation } from "./types";
import { envInt } from "../util/env";

// Async, memoized availability probe. Replaces the old synchronous
// execFileSync("semgrep", ["--version"]) that blocked the event loop on the
// first scan of every worker (audit P1-3). It only ever runs when a `semgrep`
// rule actually exists in the contract.
let _probe: Promise<boolean> | null = null;
export function probeSemgrep(): Promise<boolean> {
  if (!_probe) {
    _probe = new Promise<boolean>((resolveProbe) => {
      execFile("semgrep", ["--version"], (err) => resolveProbe(!err));
    });
  }
  return _probe;
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
// controlled in the GitHub App path) or disk, so we must reject anything that
// escapes the temp dir — otherwise writeFileSync would let a malicious PR write
// arbitrary files on the bot host. Implemented with path.resolve so it is
// correct on Windows too: a device-relative path like `C:foo` or a UNC path
// like `\\server\share` is resolved by resolve() and then fails the prefix
// check, instead of being silently joined under the temp root (audit P1-2).
export function safeJoin(dir: string, p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  const root = resolve(dir);
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

interface SemgrepResult {
  path: string;
  start: { line: number };
  extra: { message: string; lines?: string };
}

export class SemgrepEngine implements RuleEngine {
  // Semgrep scans a directory on disk, so the registry must materialize the
  // source tree and hand it over via `baseDir` (audit P2-B).
  needsDisk = true;

  // Only claims `semgrep` rules. Pattern rules always use the zero-dep
  // PatternEngine; we never probe for the CLI here (audit P1-3).
  supports(type: string): boolean {
    return type === "semgrep";
  }

  async scan(
    files: SourceFile[],
    rule: Rule,
    baseDir?: string,
    signal?: AbortSignal,
  ): Promise<Violation[]> {
    let sgRule: Record<string, unknown>;
    if (rule.type === "pattern") {
      sgRule = toSemgrepRule(rule);
    } else {
      const native = rule.semgrep;
      if (!native) throw new Error(`Rule "${rule.id}" has type "semgrep" but no "semgrep" field.`);
      sgRule = {
        id: rule.id,
        severity: rule.severity === "warn" ? "WARNING" : "ERROR",
        message: rule.description,
        ...native,
      };
    }

    // When `baseDir` is supplied (the registry writes the source tree once and
    // reuses it across rules — perf fix P1), we scan there instead of
    // materializing the files again.
    const ownDir = !baseDir;
    const dir = baseDir ?? mkdtempSync(join(tmpdir(), "archsentry-"));
    try {
      if (ownDir) {
        for (const f of files) {
          const target = safeJoin(dir, f.path);
          if (!target) {
            console.warn(`[archsentry] skipping unsafe path: ${f.path}`);
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.content);
        }
      }
      const ruleFile = join(dir, "rule.yml");
      writeFileSync(ruleFile, stringify({ rules: [sgRule] }));

      const stdout = await runSemgrep(ruleFile, dir, signal);
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
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    }
  }
}

// Semgrep can hang on very large trees; bound it so a stuck subprocess can't
// pin the bot host indefinitely (audit H2). Overridable via env.
const SEMGREP_TIMEOUT_MS = envInt("ARCHSENTRY_SEMGREP_TIMEOUT_MS", 120_000);

function runSemgrep(ruleFile: string, dir: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "semgrep",
      ["scan", "--config", ruleFile, "--json", "--quiet", dir],
      // `signal` aborts (and kills) the child when the caller's deadline fires,
      // so a timed-out scan doesn't leave a semgrep process running for up to
      // its own 120s timeout (audit P2-2).
      { timeout: SEMGREP_TIMEOUT_MS, signal },
      (err, stdout, stderr) => {
        // A timeout returns err with code ETIMEDOUT (and the child killed). Give
        // a specific message rather than a generic "Semgrep failed".
        if (err && (err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          reject(new Error(`Semgrep timed out after ${SEMGREP_TIMEOUT_MS}ms.`));
          return;
        }
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
