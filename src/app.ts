import type { Probot } from "probot";
import { parseContract, ConfigError } from "./config/loader";
import { analyzeSources } from "./analyze/analyzer";
import { toPrComment } from "./report/formatter";
import { attachExplanations, windowedContext } from "./service/scan";
import type { Violation } from "./engine/types";

const CODE_EXT = /\.(ts|tsx|js|jsx)$/;
const MARKER = "<!-- archsentry -->";
const PAGE_SIZE = 100;
// Skip any single file larger than this before it ever enters memory (audit L6).
const MAX_FILE_BYTES = Number(process.env.ARCHSENTRY_MAX_FILE_BYTES ?? 512 * 1024);

// GitHub returns file blobs as base64 (occasionally with embedded newlines).
// Buffer handles that; we just guard against a missing/undefined payload.
function decodeBlob(content: string | undefined): string {
  if (!content) return "";
  return Buffer.from(content, "base64").toString("utf8");
}

export default function app(app: Probot): void {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    const { repository, pull_request } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pull_request.number;

    // 1. Load the contract from archsentry.yml in the PR's base branch.
    let contract;
    try {
      const res = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: "archsentry.yml",
        ref: pull_request.base.sha,
      });
      if (Array.isArray(res.data) || !("content" in res.data)) return;
      contract = parseContract(Buffer.from(res.data.content, "base64").toString("utf8"));
    } catch (e) {
      // No contract file → nothing to enforce.
      if (e instanceof ConfigError) {
        console.warn(`[archsentry] invalid contract in ${owner}/${repo}: ${e.message}`);
      }
      return;
    }

    // 2. List the files changed in this PR (we never scan the whole repo).
    //    listFiles is paginated (max 100/page) — page through all of them so a
    //    PR with >100 changed files isn't silently truncated (audit H1).
    type ChangedFile = Awaited<
      ReturnType<typeof context.octokit.rest.pulls.listFiles>
    >["data"][number];
    const changed: ChangedFile[] = [];
    for (let page = 1; ; page++) {
      const res = await context.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: PAGE_SIZE,
        page,
      });
      changed.push(...res.data);
      if (res.data.length < PAGE_SIZE) break;
    }

    // 3. Fetch the raw content of each changed code file → in-memory map.
    //    Fetched in parallel and capped per-file so a single huge blob can't
    //    OOM the host (audit P3 + L6).
    const entries = await Promise.all(
      changed.map(async (file) => {
        if (file.status === "removed" || !CODE_EXT.test(file.filename)) return null;
        try {
          const res = await context.octokit.rest.repos.getContent({
            owner,
            repo,
            path: file.filename,
            ref: pull_request.head.sha,
          });
          if (Array.isArray(res.data) || !("content" in res.data)) return null;
          const content = decodeBlob(res.data.content);
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
            console.warn(`[archsentry] skipping ${file.filename}: exceeds per-file size cap`);
            return null;
          }
          return [file.filename, content] as const;
        } catch {
          // Unreadable / submodule / generated — skip.
          return null;
        }
      }),
    );
    const sources: Record<string, string> = {};
    for (const e of entries) if (e) sources[e[0]] = e[1];

    // 3b. Guard against pathologically large PRs. Limits are read per-PR so
    //     self-hosted deployments can tune them via env without a redeploy.
    const maxFiles = Number(process.env.ARCHSENTRY_MAX_FILES ?? 300);
    const maxBytes = Number(process.env.ARCHSENTRY_MAX_BYTES ?? 5 * 1024 * 1024);
    const fileCount = Object.keys(sources).length;
    const totalBytes = Object.values(sources).reduce((n, s) => n + Buffer.byteLength(s), 0);
    if (fileCount > maxFiles || totalBytes > maxBytes) {
      console.warn(
        `[archsentry] PR ${owner}/${repo}#${pullNumber} exceeds scan cap ` +
          `(${fileCount} files / ${totalBytes} bytes) — skipping.`,
      );
      await upsert(
        `${MARKER}\n⚠️ ArchSentry skipped this PR: it exceeds the scan size cap ` +
          `(${fileCount} files / ${(totalBytes / 1024 / 1024).toFixed(1)} MB). ` +
          `Split it into smaller PRs or raise the limit via ARCHSENTRY_MAX_FILES / ARCHSENTRY_MAX_BYTES.`,
      );
      return;
    }

    // 4. Run the deterministic engine (no LLM cost), wrapped so a single failure
    //    posts a non-blocking warning instead of silently dropping enforcement.
    try {
      const violations = await analyzeSources(sources, contract);

      // Clean PR → remove a stale comment if we left one, then bail.
      if (violations.length === 0) {
        const existing = await findExisting();
        if (existing) {
          await context.octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: existing,
          });
        }
        return;
      }

      // 5. Attach an explanation. Detection stays free; the explainer is
      //    selected from env (OpenAI key > Ollama > free template fallback).
      //    We pass only a windowed slice of the file (never the whole file) to
      //    the LLM — bounds the prompt and token cost on large files (audit H3).
      const contextFor = (v: Violation): string => {
        const full = sources[v.file];
        return full ? windowedContext(full, v.line) : v.snippet;
      };
      const commented = await attachExplanations(violations, contextFor, true);

      await upsert(`${MARKER}\n${toPrComment(commented)}`);
    } catch (e) {
      console.error(`[archsentry] scan failed for ${owner}/${repo}#${pullNumber}:`, e);
      await upsert(
        `${MARKER}\n⚠️ ArchSentry could not complete the scan: ${(e as Error).message}\n` +
          `A maintainer should check the bot logs.`,
      );
    }

    async function findExisting(): Promise<number | undefined> {
      const { data: comments } = await context.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
      });
      return comments.find((c) => c.body?.includes(MARKER))?.id;
    }

    async function upsert(body: string): Promise<void> {
      const existing = await findExisting();
      if (existing !== undefined) {
        await context.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing,
          body,
        });
      } else {
        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body,
        });
      }
    }
  });
}
