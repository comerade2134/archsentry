import type { Violation } from "../engine/types";

export type Format = "text" | "json";

export function formatReport(violations: Violation[], format: Format): string {
  if (format === "json") {
    return JSON.stringify({ violations }, null, 2);
  }
  if (violations.length === 0) {
    return "✅ ArchitectGuard: no rule violations found.";
  }

  const lines: string[] = [];
  lines.push(`❌ ArchitectGuard found ${violations.length} violation(s):\n`);
  for (const v of violations) {
    lines.push(`  • [${v.severity}] ${v.ruleId}  ${v.file}:${v.line}`);
    lines.push(`    ${v.message}`);
    lines.push(`    > ${v.snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function toPrComment(violations: Violation[]): string {
  if (violations.length === 0) {
    return "✅ ArchitectGuard: no architectural-rule violations detected.";
  }
  const body = violations
    .map((v) => {
      let line = `- **${v.ruleId}** (${v.severity}) in \`${v.file}:${v.line}\` — ${v.message}\n  \`${v.snippet}\``;
      if (v.explanation) line += `\n\n  ${v.explanation}`;
      return line;
    })
    .join("\n\n");
  return `### ArchitectGuard — Architectural Rule Violations\n\n${body}\n\n> Fix the flagged lines or update \`architectguard.yml\`.`;
}
