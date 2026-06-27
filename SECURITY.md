# Security Policy

## Supported versions

This project is a single deployed Cloudflare Worker, not a released library.
Only the current `main` branch is supported — fixes land there and deploy
forward. There are no maintained release branches.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Open a private [GitHub Security Advisory](https://github.com/Shemahmforash/metriq-cloudflare-agent/security/advisories/new) on this repository, **or**
- email the maintainer at `cmrosao@gmail.com`.

Include enough detail to reproduce. You'll get an acknowledgement as soon as
the report is triaged.

## Secret-handling posture

- **All secrets flow through `wrangler secret put`** and are injected at runtime
  via the Worker `Env` — they are **never committed**.
- `.env` is a **names-only template** (committed). Real values live in
  `.env.local` / `.dev.vars`, which are gitignored.
- No secret is passed as a CLI positional argument (that leaks to shell history
  and logs). `wrangler secret put NAME` reads the value from an interactive
  prompt or stdin only.

## The agent container and the GitHub PAT

Each dispatch runs an LLM coding agent with `--dangerously-skip-permissions` on
untrusted ticket text — a prompt-injection vector. The **GitHub PAT** is the
secret worth protecting: a stolen one could push to `TARGET_REPO` outside the
human-review gate.

In the container (`container/entrypoint.sh`):

- the repo is cloned **tokenless** — auth comes from a call-time `git` credential
  helper scoped to `https://github.com`, so the PAT value is never written to
  `.git/config` where the agent could read it;
- `GITHUB_PAT` / `GH_TOKEN` are **scrubbed from the agent's env** (`env -u`); the
  agent only edits files, and all `git`/`gh` work runs in the entrypoint before
  and after it.

These remove the *trivial* read paths but are **bar-raisers, not an isolation
boundary** — the agent shares the entrypoint's uid, so the PAT remains reachable
via `/proc`, and the model API key is irreducibly in the agent's env. The
**load-bearing** controls are operator-side and live on `TARGET_REPO`:

- a **fine-grained, single-repo PAT** (`Contents` + `Pull requests` write) bounds
  what a stolen token can touch;
- **branch protection requiring PR review** ensures even a stolen PAT can't merge
  without a human.

We deliberately do **not** run a secret-scanner inside the container: it would be
bypassable from the same prompt-injection position (an agent can plant a
`.gitleaks.toml` to neuter it) and duplicates GitHub's own **push protection**.
Enable secret-scanning push protection on `TARGET_REPO` instead.

## Access control on the public Worker

The control and debug routes (`/wake`, `/stop`, `/pause`, `/resume`, `/debug`)
require a bearer token: `Authorization: Bearer <CONTROL_TOKEN>`. The token is
set via `wrangler secret put CONTROL_TOKEN`. The check is **fail-closed** — if
`CONTROL_TOKEN` is unset, those routes reject every request. Only `/health`
(GET) is unauthenticated.

The container's internal HTTP server is intentionally unauthenticated: Cloudflare
container networking is private to the Worker binding and is not reachable from
the public internet.
