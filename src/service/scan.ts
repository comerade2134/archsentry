import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Violation } from "../engine/types";
import type { Explainer } from "../explain/llm";
import { selectExplainer, TemplateExplainer } from "../explain/llm";

// Shared by the CLI and the GitHub App so the explain step never drifts between
// the two entry points. Detection is always deterministic; this only attaches
// the (optional) LLM/Template explanation.
export async function attachExplanations(
  violations: Violation[],
  contextFor: (v: Violation) => string,
  explain = false,
  explainer: Explainer = selectExplainer(),
): Promise<Violation[]> {
  if (!explain || violations.length === 0) return violations;
  const fallback = new TemplateExplainer();
  return Promise.all(
    violations.map(async (v) => ({
      ...v,
      explanation: await explainer.explain(v, contextFor(v)).catch(() => fallback.explain(v)),
    })),
  );
}

// Builds a context provider that reads a few lines around the violation from
// disk — used by the CLI path. The App uses an in-memory provider instead.
export function diskContext(root: string): (v: Violation) => string {
  return (v) => {
    try {
      const lines = readFileSync(join(root, v.file), "utf8").split(/\r?\n/);
      const start = Math.max(0, v.line - 6);
      const end = Math.min(lines.length, v.line + 5);
      return lines.slice(start, end).join("\n");
    } catch {
      return v.snippet;
    }
  };
}
