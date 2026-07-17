import type { Rule } from "../config/types";
import type { RuleEngine, SourceFile, Violation } from "./types";

function toRegExp(patterns: string[]): RegExp {
  const escaped = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"));
}

function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${re}$`);
}

function matchesGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

function inScope(file: SourceFile, rule: Rule): boolean {
  const match = (rule.match ?? {}) as { paths?: string[]; exclude?: string[] };
  if (match.paths && match.paths.length && !matchesGlob(file.path, match.paths)) return false;
  if (match.exclude && match.exclude.length && matchesGlob(file.path, match.exclude)) return false;
  return true;
}

export class PatternEngine implements RuleEngine {
  supports(type: string): boolean {
    return type === "pattern";
  }

  scan(files: SourceFile[], rule: Rule): Violation[] {
    const match = (rule.match ?? { patterns: [] }) as { patterns?: string[] };
    const patterns = match.patterns ?? [];
    if (!patterns.length) return [];

    const re = toRegExp(patterns);
    const severity = (rule.severity ?? "error") as Violation["severity"];
    const violations: Violation[] = [];

    for (const file of files) {
      if (!inScope(file, rule)) continue;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] as string)) {
          violations.push({
            ruleId: rule.id,
            severity,
            file: file.path,
            line: i + 1,
            snippet: (lines[i] as string).trim(),
            message: rule.description,
          });
        }
      }
    }
    return violations;
  }
}
