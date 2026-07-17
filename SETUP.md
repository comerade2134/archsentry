# ArchSentry — Setup Guide

Three ways to run ArchSentry. Pick whichever fits your workflow.

## Prerequisites

- Node.js >= 18
- A repo with an `archsentry.yml` contract (see [`archsentry.yml.example`](archsentry.yml.example))

## Option A — GitHub App (hosted, PR comments)

1. Clone and install:

   ```bash
   git clone https://github.com/comerade2134/archsentry
   cd archsentry
   pnpm install
   cp .env.example .env
   ```

2. Register a GitHub App: **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Homepage URL: `https://github.com/comerade2134/archsentry`
   - Webhook URL: your Smee channel, e.g. `https://smee.io/xxxx`
   - Webhook secret: any string; set it as `WEBHOOK_SECRET` in `.env`
   - Permissions (read the trade-off note below):
     - _Repository contents_: **read** — read `archsentry.yml` and file blobs
     - _Pull requests_: **read** — list files changed in a PR
     - _Issues_: **write** — **REQUIRED**: ArchSentry posts PR conversation comments through the Issues API (`octokit.rest.issues.createComment`); there is no narrower "PR-comment-only" GitHub permission. As documented, granting only _Pull requests_ write would 403 at runtime.
   - Subscribe to the **Pull request** event

> **Least-privilege note.** Posting inline review comments via `pulls.createComment` would need only _Pull requests: write_, but ArchSentry posts a single top-level summary comment, which the Issues API serves — so _Issues: write_ is unavoidable with the current API choice. _Issues: write_ also permits creating/closing real issues; if that's a concern, self-host the CLI/Action path (Options B/C) instead of the App.

3. Create the app, download the private key (`.pem`), save it as `private-key.pem` in the repo root. Set `APP_ID` and `PRIVATE_KEY_PATH` in `.env`.
4. Install the app on the repos you want to guard.
5. For local dev, expose the webhook via Smee and start:

   ```bash
   pnpm start
   ```

   (`smee-client` is included; set `WEBHOOK_PROXY_URL` to your Smee channel.)

## Option B — GitHub Action (zero infra, no app)

Add `.github/workflows/archsentry.yml` to the repo you want to guard (copy [`examples/github-action.yml`](examples/github-action.yml)). It installs `archsentry` from npm on every PR and runs the CLI. No app registration required.

Optional: set `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`, or run Ollama locally) as a repo secret to get LLM explanations; otherwise a built-in template is used.

## Option C — Local CLI / CI gate

```bash
pnpm scan --config archsentry.yml --path .

# or, from anywhere (no clone needed):
npx archsentry@latest scan --config archsentry.yml --path .
```

Exits non-zero on `error` severity — drop it into any CI as a gate.

## Writing your first rule

See [`archsentry.yml.example`](archsentry.yml.example). A minimal `pattern` rule:

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
```

## Next

- Rule schema & PR-comment format: see the [README](README.md)
- Public app: install `archsentry-Dev` from its App page
