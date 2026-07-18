import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "../engine/types";
import { envInt } from "../util/env";
import { consoleLogger } from "../util/log";

// Skip common build/output/vendor directories so a CLI scan of a monorepo
// doesn't walk enormous trees (audit P3-4). The GitHub App path never uses this
// (it scans only the in-memory changed-file set), but the CLI does.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "out",
  ".cache",
  "vendor",
  "target",
  ".svelte-kit",
  "coverage",
]);

// Guard against pathological depth blowing the call stack (audit P3-4).
const MAX_WALK_DEPTH = 25;

export function walkSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  // Mirror the GitHub App's per-file guard so a huge/minified blob can't OOM the
  // CLI scan (security audit, CLI parity). Default 512 KiB; override via env.
  const MAX_FILE_BYTES = envInt("ARCHSENTRY_MAX_FILE_BYTES", 512 * 1024, consoleLogger);

  const visit = (dir: string, depth = 0): void => {
    if (depth > MAX_WALK_DEPTH) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      // lstatSync (not statSync) so symlinks are reported as links rather than
      // being followed — statSync would chase a symlink pointing at a parent
      // directory and recurse forever (audit P3-D). We skip symlinks entirely.
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      } else if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        visit(abs, depth + 1);
      } else if (st.isFile()) {
        // Skip oversized files before reading them into memory (parity with the
        // App's download-time size guard, audit finding: CLI walk lacked it).
        if (typeof st.size === "number" && st.size > MAX_FILE_BYTES) continue;
        const rel = relative(root, abs).split("\\").join("/");
        out.push({ path: rel, content: readFileSync(abs, "utf8") });
      }
    }
  };

  visit(root);
  return out;
}
