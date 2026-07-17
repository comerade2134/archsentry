import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "../engine/types";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export function walkSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];

  const visit = (dir: string): void => {
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
        visit(abs);
      } else if (st.isFile()) {
        const rel = relative(root, abs).split("\\").join("/");
        out.push({ path: rel, content: readFileSync(abs, "utf8") });
      }
    }
  };

  visit(root);
  return out;
}
