import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "../engine/types";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export function walkSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        visit(abs);
      } else if (st.isFile()) {
        const rel = relative(root, abs).split("\\").join("/");
        out.push({ path: rel, absolutePath: abs, content: readFileSync(abs, "utf8") });
      }
    }
  };

  visit(root);
  return out;
}
