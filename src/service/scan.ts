import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Violation } from "../engine/types";
import type { Explainer } from "../explain/llm";
import { selectExplainer, TemplateExplainer } from "../explain/llm";
import { mapWithConcurrency } from "../util/async";
import { envInt } from "../util/env";

// Shared by the CLI and the GitHub App so the explain step never drifts between
// the two entry points. Detection is always deterministic; this only attaches
// the (optional) LLM/Template explanation.
//
// To bound cost and load on the LLM endpoint we (a) explain at most
// `ARCHSENTRY_MAX_EXPLAIN` violations with the (paid) explainer and (b) run those
// calls with bounded concurrency via `ARCHSENTRY_EXPLAIN_CONCURRENCY` so a PR
// with hundreds of violations can't open hundreds of simultaneous requests
// (audit P2-E). Violations beyond the cap still get the free TemplateExplainer.
export async function attachExplanations(
  violations: Violation[],
  contextFor: (v: Violation) => string,
  explain = false,
  explainer: Explainer = selectExplainer(),
  signal?: AbortSignal,
): Promise<Violation[]> {
  if (!explain || violations.length === 0) return violations;
  const fallback = new TemplateExplainer();
  const cap = envInt("ARCHSENTRY_MAX_EXPLAIN", 30);
  const concurrency = envInt("ARCHSENTRY_EXPLAIN_CONCURRENCY", 5);

  const toExplain = violations.slice(0, cap);
  const rest = violations.slice(cap);

  const explained = await mapWithConcurrency(toExplain, concurrency, async (v) => ({
    ...v,
    explanation: await explainer.explain(v, contextFor(v), signal).catch(() => fallback.explain(v)),
  }));

  const templated = await Promise.all(
    rest.map(async (v) => ({ ...v, explanation: await fallback.explain(v) })),
  );
  return [...explained, ...templated];
}

// Returns a small window of lines around `line` (1-based) from a full file's
// content. This is what we send to the LLM — never the whole file — so a
// 10k-line file can't blow the prompt or the token budget (audit H3).
export function windowedContext(content: string, line: number, before = 6, after = 5): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, line - before - 1);
  const end = Math.min(lines.length, line + after);
  return lines.slice(start, end).join("\n");
}

// Builds a context provider that reads a few lines around the violation from
// disk — used by the CLI path. The App uses an in-memory provider instead.
export function diskContext(root: string): (v: Violation) => string {
  return (v) => {
    try {
      return windowedContext(readFileSync(join(root, v.file), "utf8"), v.line);
    } catch {
      return v.snippet;
    }
  };
}
