import type { Probot, Context } from "probot";

// The handler only ever fires for pull_request webhook events, so narrow the
// context to that payload (which carries `repository` + `pull_request`).
type PrContext = Context<"pull_request">;
import { parseContract, ConfigError } from "./config/loader";
import { analyzeSources } from "./analyze/analyzer";
import { toPrComment } from "./report/formatter";
import { attachExplanations, windowedContext } from "./service/scan";
import type { Violation } from "./engine/types";
import { mapWithConcurrency, withTimeout } from "./util/async";
import { envInt } from "./util/env";

const CODE_EXT = /\.(ts|tsx|js|jsx)$/;
const MARKER = "<!-- archsentry -->";
const PAGE_SIZE = 100;
// Status codes that mean "we genuinely could not read this file" — missing
// permission (403), unauthenticated (401), gone (404), or rate-limited (429).
// On any of these we must NOT silently proceed as if the file were clean
// (fail-closed, audit P1-C).
const HARD_FAILURES = new Set([401, 403, 404, 429]);

// GitHub returns file blobs as base64 (occasionally with embedded newlines).
// Buffer handles that; we just guard against a missing/undefined payload.
function decodeBlob(content: string | undefined): string {
  if (!content) return "";
  return Buffer.from(content, "base64").toString("utf8");
}

export default function app(app: Probot): void {
  // Acknowledge the webhook immediately and run the (potentially long) scan in
  // the background. Awaiting the full pipeline here used to blow GitHub's ~10s
  // webhook deadline on large PRs (audit P1-A). We `void` it so Probot acks with
  // 200 right away; failures are logged, not thrown to the webhook.
  app.on(["pull_request.opened", "pull_request.synchronize"], (context) => {
    void handlePr(context as PrContext).catch((e) =>
      console.error("[archsentry] unhandled error in PR handler:", e),
    );
  });
}

export async function handlePr(context: PrContext): Promise<void> {
  const { repository, pull_request } = context.payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const pullNumber = pull_request.number;

  // Caps are read per-PR from env so self-hosted deployments can tune them
  // (and tests can override them) without a redeploy. envInt (not Number)
  // guards against a malformed value silently disabling the cap (audit P3-E).
  const MAX_FILE_BYTES = envInt("ARCHSENTRY_MAX_FILE_BYTES", 512 * 1024);
  const MAX_FILE_LINES = envInt("ARCHSENTRY_MAX_FILE_LINES", 5_000);
  const MAX_FILES = envInt("ARCHSENTRY_MAX_FILES", 300);
  const MAX_BYTES = envInt("ARCHSENTRY_MAX_BYTES", 5 * 1024 * 1024);
  // Bound how many file contents we fetch at once (audit P1-C).
  const FETCH_CONCURRENCY = envInt("ARCHSENTRY_FETCH_CONCURRENCY", 8);
  // Hard ceiling on the whole scan so a slow PR can never pin the (detached)
  // worker indefinitely. Stays under GitHub's webhook timeout (audit P2-C).
  const PIPELINE_TIMEOUT_MS = envInt("ARCHSENTRY_PIPELINE_TIMEOUT_MS", 9_000);

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

  // Pre-filter before any download (audit P1-B): drop removed files and
  // non-source extensions, and skip files whose diff is implausibly large
  // (a cheap proxy, from data we already have, for a huge/minified blob we
  // don't want to fetch at all).
  const candidates = changed.filter(
    (f) =>
      f.status !== "removed" && CODE_EXT.test(f.filename) && (f.changes ?? 0) <= MAX_FILE_LINES,
  );

  // 3. Fetch the raw content of each candidate in memory, with bounded
  //    concurrency and fail-closed error handling (audits P1-C, L6).
  const hardErrors: string[] = [];
  const entries = await mapWithConcurrency(candidates, FETCH_CONCURRENCY, async (file) => {
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
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status !== undefined && HARD_FAILURES.has(status)) {
        hardErrors.push(`${file.filename} (HTTP ${status})`);
        return null;
      }
      // Transient (network blip, 5xx) — skip this file but keep going.
      console.warn(`[archsentry] could not read ${file.filename}: ${(e as Error).message}`);
      return null;
    }
  });

  // Fail-closed: if we couldn't read some files for permission/availability
  // reasons, we must not claim the PR is clean. Surface it and stop.
  if (hardErrors.length > 0) {
    await upsert(
      `${MARKER}\n⚠️ ArchSentry could not fully scan this PR: ${hardErrors.length} changed ` +
        `file(s) were unreadable (missing read permission, not found, or rate-limited):\n` +
        hardErrors.map((h) => `- ${h}`).join("\n") +
        `\n\nGrant the app "Contents: read" access (or retry) so the check can run. ` +
        `The architectural rules were NOT verified.`,
    );
    return;
  }

  const sources: Record<string, string> = {};
  for (const e of entries) if (e) sources[e[0]] = e[1];

  // 3b. Guard against pathologically large PRs. Limiting happens post-filter so
  //     a PR can't OOM the host (audit P3 + L6).
  const fileCount = Object.keys(sources).length;
  const totalBytes = Object.values(sources).reduce((n, s) => n + Buffer.byteLength(s), 0);
  if (fileCount > MAX_FILES || totalBytes > MAX_BYTES) {
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

  // 4. Run the deterministic engine (no LLM cost). Wrapped in a global deadline
  //    so a stuck scan can't pin the worker (audit P2-C).
  try {
    const violations = await withTimeout(analyzeSources(sources, contract), PIPELINE_TIMEOUT_MS);

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
    //    selected from env (OpenRouter key > OpenAI key > Ollama > template).
    //    We pass only a windowed slice of the file (never the whole file) to
    //    the LLM — bounds the prompt and token cost on large files (audit H3).
    //    A deadline signal aborts in-flight LLM calls if we run long (P2-C).
    const deadline = AbortSignal.timeout(PIPELINE_TIMEOUT_MS);
    const contextFor = (v: Violation): string => {
      const full = sources[v.file];
      return full ? windowedContext(full, v.line) : v.snippet;
    };
    const commented = await withTimeout(
      attachExplanations(violations, contextFor, true, undefined, deadline),
      PIPELINE_TIMEOUT_MS,
    );

    await upsert(`${MARKER}\n${toPrComment(commented)}`);
  } catch (e) {
    console.error(`[archsentry] scan failed for ${owner}/${repo}#${pullNumber}:`, e);
    await upsert(
      `${MARKER}\n⚠️ ArchSentry could not complete the scan: ${(e as Error).message}\n` +
        `A maintainer should check the bot logs.`,
    );
  }

  async function findExisting(): Promise<number | undefined> {
    // listComments returns at most PAGE_SIZE per page; paginate so a PR with
    // many comments can't hide our marker (audit P3-B).
    const comments = [];
    for (let page = 1; ; page++) {
      const { data } = await context.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: PAGE_SIZE,
        page,
      });
      comments.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return comments.find((c) => c.body?.includes(MARKER))?.id;
  }

  async function upsert(body: string): Promise<void> {
    // A comment failure must never crash the (detached) webhook handler
    // (audit P3-F). Log and move on.
    try {
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
    } catch (e) {
      console.error(`[archsentry] failed to upsert comment on ${owner}/${repo}#${pullNumber}:`, e);
    }
  }
}
