import type { Probot } from "probot";
import { parseContract } from "./config/loader";
import { analyzeSources } from "./analyze/analyzer";
import { toPrComment } from "./report/formatter";
import { selectExplainer, TemplateExplainer } from "./explain/llm";

const CODE_EXT = /\.(ts|tsx|js|jsx)$/;
const MARKER = "<!-- archsentry -->";

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
    } catch {
      // No contract in the repo → nothing to enforce.
      return;
    }

    // 2. List the files changed in this PR (we never scan the whole repo).
    const { data: changed } = await context.octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
    });

    // 3. Fetch the raw content of each changed code file → in-memory map.
    const sources: Record<string, string> = {};
    for (const file of changed) {
      if (file.status === "removed") continue;
      if (!CODE_EXT.test(file.filename)) continue;
      try {
        const res = await context.octokit.rest.repos.getContent({
          owner,
          repo,
          path: file.filename,
          ref: pull_request.head.sha,
        });
        if (Array.isArray(res.data) || !("content" in res.data)) continue;
        sources[file.filename] = Buffer.from(res.data.content, "base64").toString("utf8");
      } catch {
        // Unreadable / submodule / generated — skip.
      }
    }

    // 4. Run the deterministic engine (no LLM cost).
    const violations = await analyzeSources(sources, contract);

    // Find any comment we already left on this PR so we can upsert it instead
    // of stacking a new one on every push.
    const { data: comments } = await context.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
    });
    const existing = comments.find((c) => c.body?.includes(MARKER));

    // Clean PR → remove a stale comment if we left one, then bail.
    if (violations.length === 0) {
      if (existing) {
        await context.octokit.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: existing.id,
        });
      }
      return;
    }

    // 5. Attach an explanation. Detection stays free; the explainer is
    //    selected from env (OpenAI key > Ollama > free template fallback).
    const explainer = selectExplainer();
    const fallback = new TemplateExplainer();
    const commented = await Promise.all(
      violations.map(async (v) => ({
        ...v,
        explanation: await explainer
          .explain(v, sources[v.file] ?? v.snippet)
          .catch((e) => {
            console.warn(`[ag] explainer failed, using fallback: ${e}`);
            return fallback.explain(v);
          }),
      })),
    );

    const body = `${MARKER}\n${toPrComment(commented)}`;
    if (existing) {
      await context.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
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
  });
}
