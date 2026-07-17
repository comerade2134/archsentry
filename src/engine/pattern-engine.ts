import type { Rule } from "../config/types";
import type { RuleEngine, SourceFile, Violation } from "./types";
import { mapWithConcurrency } from "../util/async";

function toRegExp(patterns: string[], regex: boolean): RegExp {
  // `regex: true` treats patterns as real RegExp (author owns any ReDoS risk,
  // audit P3-2). Default `false` escapes them so they match literally — safe
  // and non-regex by default.
  const parts = patterns.map((p) => (regex ? p : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(parts.join("|"));
}

// Glob → RegExp is somewhat expensive and the same globs (e.g. the default
// code-glob set) are compiled on every file/rule pair. Cache by glob string so
// a rule scanning 500 files compiles each glob exactly once (perf fix P2).
// Bounded to avoid unbounded module-level growth in multi-tenant setups (P3-5):
// when it fills, we clear and start over (simple, good-enough eviction).
const MAX_GLOB_CACHE = 256;
const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else if ("+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const result = new RegExp(`^${re}$`);
  if (globCache.size >= MAX_GLOB_CACHE) globCache.clear();
  globCache.set(glob, result);
  return result;
}

function matchesGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// Default scope when a pattern rule omits `paths`. Without this, an unscoped
// pattern rule would scan every file in the tree (lockfiles, YAML, etc.) — a
// footgun. Pattern rules are about code, so scope to source extensions.
// (globToRegExp has no brace expansion, so list the extensions explicitly.)
const DEFAULT_CODE_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];

function inScope(file: SourceFile, rule: Rule): boolean {
  const match = (rule.match ?? {}) as { paths?: string[]; exclude?: string[] };
  const paths = match.paths && match.paths.length ? match.paths : DEFAULT_CODE_GLOBS;
  if (!matchesGlob(file.path, paths)) return false;
  if (match.exclude && match.exclude.length && matchesGlob(file.path, match.exclude)) return false;
  return true;
}

export class PatternEngine implements RuleEngine {
  // Zero-dep: reads the already-in-memory content, never touches disk (audit P2-B).
  needsDisk = false;

  supports(type: string): boolean {
    return type === "pattern";
  }

  async scan(files: SourceFile[], rule: Rule): Promise<Violation[]> {
    const match = (rule.match ?? {}) as { patterns?: string[]; regex?: boolean };
    const patterns = match.patterns ?? [];
    if (!patterns.length) return [];

    const re = toRegExp(patterns, match.regex === true);
    const severity = (rule.severity ?? "error") as Violation["severity"];

    // Process per-file with bounded concurrency and yield inside the line loop,
    // so a huge file/PR can't monopolize the event loop and void the global
    // timeout (audit P2-1). `mapWithConcurrency` lets other webhooks and the
    // withTimeout timer run between files.
    const scanFile = async (file: SourceFile): Promise<Violation[]> => {
      if (!inScope(file, rule)) return [];
      const lines = file.content.split(/\r?\n/);
      const out: Violation[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] as string)) {
          out.push({
            ruleId: rule.id,
            severity,
            file: file.path,
            line: i + 1,
            snippet: (lines[i] as string).trim(),
            message: rule.description,
          });
        }
        // Yield every 1024 lines so timers (withTimeout) and other webhooks run.
        if ((i & 0x3ff) === 0) await Promise.resolve();
      }
      return out;
    };

    const batches = await mapWithConcurrency(files, 16, scanFile);
    return batches.flat();
  }
}
