import { Command } from "commander";
import { loadContract } from "./config/loader";
import { analyze } from "./analyze/analyzer";
import { formatReport, type Format } from "./report/formatter";

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
    .action(async (opts) => {
      const contract = loadContract(opts.config as string);
      const violations = await analyze(opts.path as string, contract);
      const format = (opts.format as Format) ?? "text";
      console.log(formatReport(violations, format));

      const hasError = violations.some((v) => v.severity === "error");
      if (hasError) process.exitCode = 1;
    });

  return program;
}
