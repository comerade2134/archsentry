# ArchSentry

> Enforce *your* team's architectural rules on every PR — before merge. Deterministic, config-first, and free to scan.

AI coding assistants now write the majority of enterprise code, but the review layer built for humans has broken down. ArchSentry is a GitHub App that catches AI-generated (and human) code which violates **your team's specific architectural contract** — the rules a generic SAST tool simply can't see.

- **Deterministic detection. Zero LLM cost on scan.** Rules are structured YAML, not prompts. No token is spent *finding* a violation.
- **LLM only explains.** Once a violation is found, an LLM writes a plain-English fix hint — and silently falls back if the model is unavailable.
- **Config-first.** Your contract lives in `archsentry.yml` in the repo. No dashboard, no vendor lock-in.
- **Runs on the PR diff.** Only changed files are analyzed, in-memory, with no filesystem access.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![CI](https://github.com/comerade2134/archsentry/actions/workflows/ci.yml/badge.svg)

## Why not just use SAST?

SAST tools find *known vulnerability patterns* (CVEs, insecure APIs). They have no idea what **your** architecture is — "controllers must not talk to the database directly," "all Kafka producers go through the `events` module," "no `eval` in product code." That's exactly the contract ArchSentry enforces, expressed in your own words.

| | SAST | ArchSentry |
|---|---|---|
| Finds CVEs / insecure APIs | ✅ | ➖ (run SAST too) |
| Enforces *your* team's architecture | ➖ | ✅ |
| Cost to scan | varies | **free** (deterministic) |
| Explains *why* in your context | ➖ | ✅ (LLM, free tier available) |

## How it works

1. `archsentry.yml` in your repo declares structured rules (a `pattern` or `semgrep` matcher + paths + severity + a description).
2. On every `pull_request.opened` / `pull_request.synchronize`, ArchSentry reads the contract from the base branch, fetches **only the changed code files**, and runs the deterministic engine in-memory.
3. Violations are posted as a PR comment — with an LLM-written explanation when configured.

The same engine powers a local CLI, so you can run the exact same checks in CI or locally:

```bash
pnpm scan --config archsentry.yml --path .
```

## Quick start

### As a CLI

```bash
pnpm install
pnpm scan --config samples/dummy-target/archsentry.yml --path samples/dummy-target
```

Flags the seeded violation in `controllers/user.controller.ts` and exits non-zero on `error` severity — a drop-in CI gate.

### As a GitHub App

```bash
pnpm install
cp .env.example .env      # then fill in APP_ID, WEBHOOK_SECRET, PRIVATE_KEY_PATH, WEBHOOK_PROXY_URL
pnpm start               # Probot under tsx + smee-client webhook proxy
```

**Register the app** (one-time):
1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Homepage URL: `https://github.com/comerade2134/archsentry`. Webhook URL: your Smee channel (e.g. `https://smee.io/xxxx`); Webhook secret: any string (set it in `.env` as `WEBHOOK_SECRET`).
3. Permissions: *Repository contents* (read), *Pull requests* (read & write). Subscribe to the **Pull request** event.
4. Create the app, download the private key (`.pem`), save it as `private-key.pem` in the repo root. Install the app on the repos you want to guard.

Then install it on a repo that has `archsentry.yml` and push a PR. See `archsentry.yml.example` for the contract format and `.env.example` for the required variables.

### As a GitHub Action (zero infra)

Prefer a CI check over a hosted app? Drop `examples/github-action.yml` into your repo as `.github/workflows/archsentry.yml`. It runs the CLI on every PR. (Requires `archsentry` published to npm; until then use the GitHub App above.)

## Explanations (optional, free)

Every violation comment can include a plain-English explanation. Detection is always free; the explainer is chosen from the environment (first match wins):

- `OPENROUTER_API_KEY` → any [OpenRouter](https://openrouter.ai) model, including **free** tiers like `nvidia/nemotron-3-ultra-550b-a55b:free`. No card.
- `OPENAI_API_KEY` → GPT-4o-mini (billed per call).
- `OLLAMA_MODEL` → a free local model via [Ollama](https://ollama.com) (private, no key).
- none → built-in template fallback (always works).

If the chosen model errors, ArchSentry silently falls back so the comment always posts.

## Rule schema

```yaml
version: 1
rules:
  - id: no-direct-sql
    type: pattern
    severity: error
    description: "All database writes must go through the repository layer."
    match:
      patterns: ["INSERT INTO", "db.query("]
      paths: ["**/*.ts"]
      exclude: ["**/repositories/**"]
  - id: no-eval
    type: semgrep
    severity: error
    description: "Do not call eval() in product code."
    semgrep:
      languages: ["typescript", "javascript"]
      pattern-either:
        - pattern: eval(...)
        - pattern: new Function(...)
```

`type: pattern` rules are handled by the zero-dependency engine; `type: semgrep` rules (and `pattern` rules, once the [Semgrep](https://semgrep.dev) CLI is installed) use the AST-aware Semgrep engine — a drop-in upgrade with no config change.

## What a PR comment looks like

When a rule is violated, ArchSentry posts a comment like this on the PR — and removes it automatically once the PR is clean:

```text
### ArchSentry — Architectural Rule Violations

- **no-direct-sql** (error) in `src/checkout.service.ts:12` — All database writes must go through the repository layer.
  `const rows = await db.query("INSERT INTO users (...)")`

  ArchSentry: move this query into the repository layer (e.g. repositories/users.ts) instead of calling db.query from a service.

> Fix the flagged lines or update `archsentry.yml`.
```

## Status

- ✅ Deterministic scan engine + CLI
- ✅ GitHub App (Probot) with `pull_request` handler — verified end-to-end
- ✅ LLM explanations (OpenRouter free tier by default)
- ⏳ Your design partners & first installs

## License

MIT.
