import { Command } from "commander";
import { loadContract } from "./config/loader";
import { analyze } from "./analyze/analyzer";
import { formatReport, type Format } from "./report/formatter";
import { selectExplainer, TemplateExplainer } from "./explain/llm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("archsentry")
    .description("Enforce your team's architectural rules on code before merge.")
    .version("0.1.0");

  program
    .command("scan")
    .description("Scan a path against an archsentry.yml contract.")
    .requiredOption("-c, --config <file>", "path to archsentry.yml")
    .requiredOption("-p, --path <dir>", "directory to scan")
    .option("-f, --format <format>", "output format: text | json", "text")
    .option("-e, --explain", "generate AI explanations for violations", false)
    .action(async (opts) => {
      const contract = loadContract(opts.config as string);
      const violations = await analyze(opts.path as string, contract);
      const format = (opts.format as Format) ?? "text";

      let reported = violations;
      if (opts.explain && violations.length > 0) {
        const explainer = selectExplainer();
        const fallback = new TemplateExplainer();
        reported = await Promise.all(
          violations.map(async (v) => {
            let codeContext = v.snippet;
            try {
              const fileContent = readFileSync(join(opts.path as string, v.file), "utf8");
              const lines = fileContent.split("\n");
              const start = Math.max(0, v.line - 6);
              const end = Math.min(lines.length, v.line + 5);
              codeContext = lines.slice(start, end).join("\n");
            } catch {
              codeContext = v.snippet;
            }
            return {
              ...v,
              explanation: await explainer
                .explain(v, codeContext)
                .catch(() => fallback.explain(v)),
            };
          }),
        );
      }

      console.log(formatReport(reported, format));

      const hasError = violations.some((v) => v.severity === "error");
      if (hasError) process.exitCode = 1;
    });

  return program;
}
