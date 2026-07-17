import type { Probot } from "probot";
import { parseContract } from "./config/loader";
import { analyzeSources } from "./analyze/analyzer";
import { toPrComment } from "./report/formatter";
import { selectExplainer, TemplateExplainer } from "./explain/llm";

const CODE_EXT = /\.(ts|tsx|js|jsx)$/;

export default function app(app: Probot): void {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    const { repository, pull_request } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pull_request.number;

    // 1. Load the contract from architectguard.yml in the PR's base branch.
    let contract;
    try {
      const res = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: "architectguard.yml",
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
    if (violations.length === 0) return;

    // 5. Week 3: attach an explanation. Detection stays free; the explainer is
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

    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: toPrComment(commented),
    });
  });
}
