import type { Rule } from "../config/types";
import type { RuleEngine, SourceFile, Violation } from "./types";
import { mapWithConcurrency } from "../util/async";
import { consoleLogger, type Logger } from "../util/log";

/**
 * Compile a rule's patterns into a single `RegExp`. With `regex: false` (the
 * default) every metacharacter is escaped so the pattern matches the literal
 * text — safe and ReDoS-free. With `regex: true` the author's patterns are used
 * as-is (they own any catastrophic-backtracking risk; see audit P3-2). The
 * alternatives are joined with `|` so a rule with several patterns compiles to
 * one pass over each line.
 */
function toRegExp(patterns: string[], regex: boolean): RegExp {
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

/**
 * Translate a glob (supporting `**`, `*` and `?`) into an anchored `RegExp`.
 * Brace expansion is intentionally not implemented — rule authors list
 * extensions explicitly (see {@link DEFAULT_CODE_GLOBS}). The cache makes the
 * per-file cost O(1) after the first compilation of a given glob.
 */
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

/**
 * Deterministic, zero-dependency scanning engine.
 *
 * Every rule whose `type` is `"pattern"` is handled here. The engine is
 * path-agnostic and fully in-memory: it never reads from disk (audit P2-B) and
 * receives the already-fetched file contents from the caller. For each file it
 * tests every line against the compiled rule `RegExp`; matches become
 * {@link Violation}s. Because this runs synchronously per line, the scan yields
 * every 1024 lines (`await Promise.resolve()`) and is wrapped in bounded
 * concurrency by the caller so a large file or PR can never monopolise the
 * event loop and void the global timeout (audit P2-1).
 */
export class PatternEngine implements RuleEngine {
  // Zero-dep: reads the already-in-memory content, never touches disk (audit P2-B).
  needsDisk = false;

  // The logger is accepted for interface uniformity (engines are constructed by
  // the registry, which forwards the active logger); PatternEngine itself is
  // silent, so it is intentionally unused here.
  constructor(private readonly _logger: Logger = consoleLogger) {}

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
