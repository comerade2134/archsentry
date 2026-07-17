import type { Violation } from "../engine/types";

export type Format = "text" | "json";

// A violation's snippet (raw source) and explanation (LLM output) are
// attacker-influenced text. Escaping before we drop them into a Markdown PR
// comment prevents HTML/JS injection into the review thread (audit M1). We also
// escape quotes and backticks so the text can't break out of a Markdown code
// span/attribute, and so a stray backtick can't end a fenced block (audit P3-C).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

export function formatReport(violations: Violation[], format: Format): string {
  if (format === "json") {
    return JSON.stringify({ violations }, null, 2);
  }
  if (violations.length === 0) {
    return "✅ ArchSentry: no rule violations found.";
  }

  const lines: string[] = [];
  lines.push(`❌ ArchSentry found ${violations.length} violation(s):\n`);
  for (const v of violations) {
    lines.push(`  • [${v.severity}] ${escapeHtml(v.ruleId)}  ${escapeHtml(v.file)}:${v.line}`);
    lines.push(`    ${escapeHtml(v.message)}`);
    lines.push(`    > ${escapeHtml(v.snippet)}`);
    if (v.explanation) lines.push(`    ${escapeHtml(v.explanation)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function toPrComment(violations: Violation[]): string {
  if (violations.length === 0) {
    return "✅ ArchSentry: no architectural-rule violations detected.";
  }
  const body = violations
    .map((v) => {
      let line = `- **${escapeHtml(v.ruleId)}** (${v.severity}) in \`${escapeHtml(v.file)}:${v.line}\` — ${escapeHtml(v.message)}\n  \`${escapeHtml(v.snippet)}\``;
      if (v.explanation) line += `\n\n  ${escapeHtml(v.explanation)}`;
      return line;
    })
    .join("\n\n");
  return `### ArchSentry — Architectural Rule Violations\n\n${body}\n\n> Fix the flagged lines or update \`archsentry.yml\`.`;
}
