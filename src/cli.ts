import { Command } from "commander";
import pkg from "../package.json";
import { loadContract, ConfigError } from "./config/loader";
import { analyze } from "./analyze/analyzer";
import { formatReport, type Format } from "./report/formatter";
import { attachExplanations, diskContext } from "./service/scan";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("archsentry")
    .description("Enforce your team's architectural rules on code before merge.")
    .version(pkg.version);

  program
    .command("scan")
    .description("Scan a path against an archsentry.yml contract.")
    .requiredOption("-c, --config <file>", "path to archsentry.yml")
    .requiredOption("-p, --path <dir>", "directory to scan")
    .option("-f, --format <format>", "output format: text | json", "text")
    .option("-e, --explain", "attach an AI/LLM explanation to each violation", false)
    .option("-s, --severity <level>", "minimum severity to report: error | warn", "warn")
    .option("--no-fail", "report only — never exit non-zero, even on errors")
    .action(async (opts) => {
      try {
        const contract = loadContract(opts.config as string);
        const violations = await analyze(opts.path as string, contract);
        const explained = await attachExplanations(
          violations,
          diskContext(opts.path as string),
          opts.explain as boolean,
        );

        const reported =
          (opts.severity as string) === "error"
            ? explained.filter((v) => v.severity === "error")
            : explained;

        console.log(formatReport(reported, (opts.format as Format) ?? "text"));

        const hasError = violations.some((v) => v.severity === "error");
        if (hasError && opts.fail !== false) process.exitCode = 1;
      } catch (err) {
        const message = err instanceof ConfigError ? err.message : (err as Error).message;
        console.error(`❌ ArchSentry: ${message}`);
        process.exitCode = 1;
      }
    });

  return program;
}
