# metriq-cloudflare-agent

Cloudflare-hosted runtime for the Metriq agent loop. When a human dispatches a ticket to the **Cloudflare Agent** identity in Metriq, this is the thing that wakes up, clones the target repo, asks Claude Code to do the work, opens a real GitHub PR, and hands the ticket back for blessing.

## What this is

A Cloudflare Worker fronts a **`MetriqAgentLoop`** Durable Object that holds an agent session open against Metriq's HTTP MCP server and long-polls for work. On a dispatch hit the DO boots a **`AgentContainer`** Cloudflare Container (Node 24 + `git` + `gh` + `pnpm` + `claude-code`), which clones the target repo and runs `claude -p` against the ticket. The container prints the PR URL on stdout; the DO captures it, reports it as the artifact, and moves the work item to `done` (with `reviewRequired: true` so a human still blesses before merge).

## What you need to run this yourself

To deploy and run your own instance you'll need:

- A **Cloudflare account** with **Workers + Containers** enabled (the agent runs in a 4 GiB Cloudflare Container).
- A **GitHub PAT** scoped to the repo you want the agent to work on (`TARGET_REPO`), with push + PR access.
- An **Anthropic API key** (or an AI Gateway in front of one) with credit — `claude -p` calls this.
- A reachable **Metriq MCP endpoint** (`METRIQ_MCP_URL`) plus an API key for the Metriq **Cloudflare Agent** identity — this is where the agent sources work. See **Point it at your own repo** for the Metriq-specific coupling that isn't parameterized yet.

See [Secrets — production](#secrets--production-set-via-wrangler-secret-put-in-a-real-terminal-not-via--prefixed-shells) for the full list and [CONTRIBUTING.md](CONTRIBUTING.md) to run the test suite (no Cloudflare account required for tests).

This project is licensed under the [MIT License](LICENSE).

## Getting started

Pick your path:

- **Just want to see it run — no Cloudflare account?** → [Local development](#local-development): `pnpm install && pnpm dev`.
- **Deploy your own agent?** → [Quickstart](#quickstart-deploy-your-own-instance) below (needs a Cloudflare account **and a running Metriq instance**).
- **Understand how it works?** → [Architecture](#architecture).
- **Want to contribute?** → [CONTRIBUTING.md](CONTRIBUTING.md).

### Quickstart: deploy your own instance

> ⚠️ **Hard prerequisite — a running Metriq instance.** Metriq is the agent's
> *work source*: without a reachable `METRIQ_MCP_URL` + API key, the agent boots
> but has nothing to poll. You'll also need a Cloudflare account (Workers +
> Containers), a GitHub PAT, and an Anthropic API key — see
> [What you need to run this yourself](#what-you-need-to-run-this-yourself).

1. **Clone & install** (fork instead if you want CI-based auto-deploy):
   ```bash
   git clone https://github.com/Shemahmforash/metriq-cloudflare-agent.git
   cd metriq-cloudflare-agent
   pnpm install
   ```
2. **Log in to Cloudflare:** `pnpm wrangler login`
3. **Set the required secrets** (interactive prompts — never pass values as CLI
   args). Full list + the ⚠️ trust-model note in
   [Secrets — production](#secrets--production-set-via-wrangler-secret-put-in-a-real-terminal-not-via--prefixed-shells):
   ```bash
   wrangler secret put METRIQ_API_KEY      # from your Metriq instance
   wrangler secret put METRIQ_MCP_URL      # https://<your-metriq-host>/api/v1/mcp
   wrangler secret put GITHUB_PAT          # fine-grained, scoped to TARGET_REPO
   wrangler secret put GITHUB_USER
   wrangler secret put CONTROL_TOKEN       # a random bearer token you choose
   wrangler secret put TARGET_REPO         # owner/name the agent opens PRs against
   wrangler secret put ANTHROPIC_API_KEY   # or use the AI Gateway path
   ```
4. **Deploy:** `pnpm wrangler deploy` (or wire CI secrets for auto-deploy on
   push — see [Deployment](#deployment)).
5. **Wake the loop** — replace the placeholders with your deployed Worker's URL;
   `CONTROL_TOKEN` is the secret you set in step 3:
   ```bash
   curl -X POST https://<your-worker>.<your-subdomain>.workers.dev/wake \
     -H "authorization: Bearer $CONTROL_TOKEN"
   ```

## Status

Working end-to-end and deployable. What the agent does today:

- **Polls Metriq for work** — holds an MCP agent session open and long-polls (`wait_for_assignment`, 25s) for tickets dispatched to its identity.
- **Runs the work in a container** — on a hit it boots a Cloudflare Container, clones `TARGET_REPO`, and runs `claude -p` (or the OpenCode harness) against the ticket.
- **Opens a real PR** — commits, pushes, and `gh pr create`s against your target repo, reports the PR URL back to Metriq as the artifact, and moves the ticket to `done` for a human to bless before merge.
- **Operational controls** — daily dispatch cap, `/pause`-`/resume` and `AGENT_PAUSED` kill-switches, a per-dispatch watchdog, transport-level exponential back-off, and auto-filed GitHub Issues on container boot failure.
- **Model flexibility** — Claude by default; per-ticket model override and an OpenCode/OSS harness path with auto-escalation back to Claude on failure.

**Tests:** vitest (worker + Durable Object), container tests (`node --test`), and bats for `entrypoint.sh`. This repo's own pre-push hook (lefthook) runs typecheck + vitest + container + bats in parallel and gates every push.

**Live URL (after you deploy):** `https://<your-worker>.<your-subdomain>.workers.dev`

Open follow-ups are tracked at the bottom of this README.

## Architecture

```
┌─────────────────────┐   long-poll HTTP   ┌──────────────────────┐
│  Cloudflare Worker  │ ◄──────────────►  │  Metriq MCP server   │
│   src/worker.ts     │   8 tools          │  /api/v1/mcp         │
│       │             │                    └──────────────────────┘
│       ▼             │
│  Durable Object     │
│  MetriqAgentLoop    │
│  src/agent-loop.ts  │
│  ─ sessionId        │  IDLE: POST /start  ┌──────────────────────┐
│  ─ alarm state-     │ ──────────────────► │  AgentContainer DO   │
│    machine (idle/   │     → 202 (fast)    │  src/agent-container │
│    monitor)         │                     │  └─ wraps Cloudflare │
│  ─ daily-cap, pause │  MONITOR: poll      │     Container (4 GiB)│
│       │             │  GET /status ~15s   │   ┌──────────────────┘
│       ▼             │ ◄──────────────────►   │  container/
│  status==done →     │  8080 /start /status   │  ├─ Dockerfile
│  parseLastUrl       │                        │  │  Node 24-slim
│  → report_artifact  │                        │  │  + git/gh/pnpm
│  → move_item        │                        │  │  + claude-code
│                     │                        │  │  USER: node
│  (no invocation     │                        │  ├─ server.js
│   awaits the job —  │                        │  │  /start spawns,
│   survives the      │                        │  │  /status reports
│   15-min ceiling)   │                        │  ├─ job-state.mjs
└─────────────────────┘                        │  └─ entrypoint.sh
                                               │    clone→install
                                               │    →claude -p
                                               │    →commit→push
                                               │    →gh pr create
                                               │    →echo PR_URL
                                               └─ git push → ┌─────────────┐
                                                             │ github.com/ │
                                                             │ <TARGET_    │
                                                             │  REPO>      │
                                                             └─────────────┘
```

### Key DO endpoints (forwarded by the Worker to the singleton)

| Route | Verb | Effect |
|---|---|---|
| `/health` | GET | 200 `ok` — uptime probe |
| `/wake` | POST | Registers session (idempotent), schedules alarm. Returns 202. |
| `/stop` | POST | `end_agent_session` MCP call, clears `sessionId`, deletes alarm. 204. |
| `/pause` | POST | Sets `paused: true` in DO storage. Alarm goes dormant. 204. |
| `/resume` | POST | Sets `paused: false`, re-arms alarm immediately. 204. |
| `/debug` | GET | Dumps DO storage (`currentDispatch`, counters, alarm timestamp). JSON. |

### Dispatch flow

1. Alarm fires (cadence ~26s = 25s long-poll + 1s re-arm).
2. `wait_for_assignment(25s, sessionId)` → either `dispatch_id: null` (logged `polled, nothing.`) or a hit.
3. `claim_assigned_task(dispatch_id, sessionId)`. `lost_race` / `superseded` → drop + re-arm.
4. `get_item(itemId)` to discover current state. (Metriq doesn't auto-move on dispatch; agent has to.)
5. Daily-cap check. If counter ≥ cap → `post_agent_comment("rate-limited; retry tomorrow")` + `move_item(<current> → backlog)`. Else increment counter.
6. If `currentState !== "in_progress"` → `move_item(<current> → in_progress)`.
7. **IDLE → start container** via `env.AGENT_CONTAINER.get(idFromName(dispatchId)).fetch("/start", body=ctx)`. `/start` spawns `entrypoint.sh` and returns `202` immediately. The DO stores `currentDispatch{startedAt}` and re-arms a short monitor poll — it does **not** await the agent's work (which can exceed the 15-min DO alarm wall-clock ceiling).
8. **MONITOR** (subsequent alarms, ~15s cadence): `GET /status?dispatch_id=…`.
   - `running` → re-arm another poll, unless `now − startedAt` exceeds the watchdog (`CONTAINER_TIMEOUT_MS`, default 30min) → abandon, sweeper reclaims.
   - `failed` (non-zero exit) / no URL in `done` output / `unknown` (container restarted, lost its in-memory job) → log, abandon, sweeper reclaims.
   - status fetch throws (container re-booting / transport blip) → keep monitoring, retry next poll (bounded by the watchdog).
   - `done` → `parseLastUrl(stdoutTail)` finds the PR URL.
9. `report_artifact(itemId, url=<PR URL>, kind="pr", title=...)` with retry-once; `null` (claim superseded mid-work) → rescue: `post_agent_comment` + auto-filed GitHub Issue.
10. `move_item(in_progress → done)`. Metriq returns `blessingRequested: true`; `null` → rescue: GitHub Issue.
11. Human reviews the GitHub PR, blesses in Metriq → ticket flips to `done`.

Because the long agent run is decoupled from the alarm, every alarm invocation stays short and the loop's re-arm always runs — even across DO restarts, where the persisted `currentDispatch` makes the next alarm resume MONITORING the still-running container. See [ADR-009](docs/product/architecture/adr-009-alarm-dispatch-decoupling.md).

Failure paths: container non-zero exit (`failed`) / no URL in `done` output / status `unknown` / watchdog expiry → no `move_item`, sweeper reclaims. Container fail-to-boot (`/start` throws) → log + 60s back-off + auto-filed GitHub Issue. MCP unreachable → transport-layer exponential back-off `[5s, 30s, 5min]` capped at 5min.

## Local development

**Prereqs:** Node 24 (the container + CI runtime; Node ≥22 is enough to run the tests locally), pnpm 10.

```bash
pnpm install
pnpm exec lefthook install   # one-time per clone — wires the pre-push hook
```

### Secrets — Worker side

`.env` is a **committed template** (names only); `.env.local` is **gitignored** (real values). The `.env.local` values are read by `direnv` (`.envrc` contains `dotenv_if_exists .env.local`) so they're in your shell environment whenever you `cd` into the repo. Required for Claude Code's project-scoped `.mcp.json` to interpolate `${METRIQ_API_KEY}` + `${METRIQ_MCP_URL}` when it launches.

```bash
cp .env .env.local
$EDITOR .env.local   # fill in real values
direnv allow         # if you use direnv
```

For `wrangler dev`, also copy to `.dev.vars` (same format, different consumer — both gitignored):

```bash
cp .env.local .dev.vars
```

### Secrets — production (set via `wrangler secret put` in a real terminal, not via `!`-prefixed shells)

**Minimal required set** for a working deployment: `METRIQ_API_KEY`, `METRIQ_MCP_URL`,
`GITHUB_PAT`, `GITHUB_USER`, `CONTROL_TOKEN`, `TARGET_REPO`, and **one** model-auth
path — either a direct `ANTHROPIC_API_KEY`, or the AI Gateway path
(`ANTHROPIC_BASE_URL` + `AI_GATEWAY_TOKEN`). Everything marked
*(optional)* has a working default.

> **Change these for your deployment:** `METRIQ_MCP_URL` (your Metriq instance),
> `TARGET_REPO` (the repo the agent works on — **required, no default**), and
> `ALERT_GITHUB_REPO` (where boot-failure alerts land — defaults to `TARGET_REPO`).
> Leaving the shipped example values in place will point the agent at repos you
> don't own.

| Name | Purpose |
|---|---|
| `METRIQ_API_KEY` | Bearer token for the Metriq **Cloudflare Agent** identity (Settings → Agents → reveal) |
| `METRIQ_MCP_URL` | Your Metriq MCP HTTP endpoint, e.g. `https://<your-metriq-host>/api/v1/mcp` |
| `GITHUB_PAT` | PAT for the GitHub user the agent commits as. **Use a fine-grained token scoped to `TARGET_REPO` only**, with `Contents: Read and write` + `Pull requests: Read and write` — *not* a classic `repo`-scoped token. This token is the blast-radius control (see the security note below). |
| `GITHUB_USER` | The GitHub username that owns the PAT |
| `TARGET_REPO` | **Required, no default.** `owner/name` the agent clones + opens PRs against. The `GITHUB_PAT` must have push + PR access to it. The container fails fast if this is unset. See **Point it at your own repo** below. |
| `ANTHROPIC_API_KEY` | Anthropic API key with credit balance — `claude -p` calls this. **Required unless** you use the AI Gateway path below. |
| `CONTROL_TOKEN` | Bearer token required on the control + debug routes (`/wake` `/stop` `/pause` `/resume` `/debug`). Send as `Authorization: Bearer <token>`. **Fail-closed**: if unset, those routes reject every request. `/health` stays open. |
| `ANTHROPIC_BASE_URL` *(optional)* | Points Claude Code at a [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) Anthropic endpoint instead of calling Anthropic directly. Routing it through the gateway buys per-PR cost attribution (ADR-001/004). When set, the gateway forwards to Anthropic, so `ANTHROPIC_API_KEY` is still the upstream credential. The gateway itself (slug `GATEWAY_ID`) is created by `scripts/provision-gateway.sh`, not a `wrangler secret`. |
| `AI_GATEWAY_TOKEN` *(optional)* | Authenticated-gateway token, sent as `cf-aig-authorization`. Only needed if your AI Gateway requires auth. Forwarded **only when set**. |
| `AGENT_MODEL_DEFAULT` *(optional)* | Fleet-wide default model (e.g. `anthropic/claude-...`). Unset = the built-in Claude floor (zero-config behavior). A per-ticket `model` field overrides it. See ADR-002. |
| `OSS_MODEL_BASE_URL` / `OSS_MODEL_API_KEY` *(optional)* | OpenAI-compatible endpoint + key for the OSS (OpenCode) harness, used when a ticket selects a non-`anthropic/*` model. LiteLLM is the reference backend (ADR-005/006). |
| `AGENT_PAUSED` *(optional)* | Deploy-driven kill-switch. Set to `true` / `1` / `yes` (case-insensitive) to make the loop skip the MCP poll and idle (re-arming a long alarm) until cleared; propagates within ~1 min. Anything else (incl. unset) = running. Distinct from the per-DO `/pause` route — this is fleet-wide. |
| `DAILY_CAP` *(optional)* | dispatches/UTC-day. Default `5`. Bump for stress tests. |
| `CONTAINER_TIMEOUT_MS` *(optional)* | per-dispatch watchdog — max wall-clock before the monitor abandons a still-running dispatch. Enforced across short status polls (`now − startedAt`), **not** as a blocking timeout, so it may safely exceed the 15-min alarm ceiling. Default `1800000` (30min). |
| `MONITOR_POLL_MS` *(optional)* | monitor-phase status-poll cadence. Must stay under the container's `sleepAfter` (10min) so each poll keeps it awake. Default `15000` (15s). |
| `CONTAINER_BOOT_BACKOFF_MS` *(optional)* | back-off after container fail-to-boot. Default `60000` (60s). |
| `RETRY_DELAY_MS` *(optional)* | gap between `report_artifact`/`move_item` retry. Default `5000` (5s). |
| `ALERT_GITHUB_REPO` *(optional)* | `owner/name` where container-fail-to-boot events file a GitHub Issue (reuses `GITHUB_PAT` for auth). **No hardcoded default** — falls back to `TARGET_REPO`; if both are unset, alerting is skipped. Set it to a repo you own if you want alerts somewhere other than `TARGET_REPO`. |
| `TARGET_BASE_BRANCH` *(optional)* | PR base branch on `TARGET_REPO`. Default `main`. |

> ⚠️ **Security — trust model.** Each dispatch runs a coding LLM with
> `--dangerously-skip-permissions` inside a disposable container, on the
> **ticket's title/description as its prompt**. Treat ticket submission as a
> trusted, authenticated path: a maliciously-crafted ticket is a prompt-injection
> vector that can drive the agent's tools. The **`GITHUB_PAT` is the secret worth
> protecting** — a stolen one could push to `TARGET_REPO` outside the
> human-review gate. The **load-bearing controls are operator-side** — keep them
> all tight:
> - **Scope the `GITHUB_PAT`** to `TARGET_REPO` only (fine-grained, `Contents` +
>   `Pull requests` write). A broad classic `repo` token would let an injected
>   ticket reach *every* repo your account can write to.
> - **Turn on branch protection on `TARGET_REPO`** (require a PR review before
>   merge to the default branch). This is the real backstop: even if the PAT
>   leaked, it couldn't merge code without a human — preserving the
>   agent-proposes / human-blesses model.
> - **Keep `TARGET_REPO` and the ticket source under your control.** Don't point
>   this at a public/untrusted intake queue.
>
> In the container, the GitHub creds are kept out of the agent's reach by default:
> the repo is cloned **tokenless** (auth via a call-time credential helper, so the
> PAT is never written to `.git/config`) and `GITHUB_PAT`/`GH_TOKEN` are
> **scrubbed from the agent's env** (`env -u`) — all `git`/`gh` work runs in the
> entrypoint before/after the agent. These close the *trivial* read paths but are
> **bar-raisers, not an isolation boundary**: the agent runs as the same uid as
> the entrypoint, so a determined prompt-injected agent could still reach the PAT
> via `/proc`, and the model API key is irreducibly in its env. That's why the
> operator-side controls above are the ones that actually bound the damage.

### Run the Worker locally

```bash
pnpm dev   # wrangler dev on http://localhost:8787
```

Then drive the loop. The control + debug routes require `Authorization: Bearer $CONTROL_TOKEN` (`/health` does not):

```bash
curl -X POST http://localhost:8787/wake   -H "authorization: Bearer $CONTROL_TOKEN"
curl       http://localhost:8787/debug    -H "authorization: Bearer $CONTROL_TOKEN"   # see DO state
curl -X POST http://localhost:8787/pause  -H "authorization: Bearer $CONTROL_TOKEN"
curl -X POST http://localhost:8787/resume -H "authorization: Bearer $CONTROL_TOKEN"
curl -X POST http://localhost:8787/stop   -H "authorization: Bearer $CONTROL_TOKEN"
```

The container itself can't be exercised in `wrangler dev` without Docker integration; container behavior is covered by `node --test` job-store tests (`container/job-state.mjs`) + bats tests against the stubbed entrypoint.

## Testing

```bash
pnpm typecheck                       # tsc --noEmit
pnpm test                            # vitest on workerd via @cloudflare/vitest-pool-workers
pnpm test:container                  # node --test test/*.test.mjs (container job-store + env/Dockerfile checks)
pnpm exec bats test/entrypoint.bats  # shell tests for the container entrypoint
```

The pre-push hook (lefthook) runs all four in parallel.

**What's covered** (run the suites for current totals — per-file counts aren't hard-coded here, they drift):

- `test/mcp-client.test.ts` — the 8 MCP wrappers (register, wait, claim, report, move, getItem, postAgentComment, endAgentSession), JSON + SSE parsing, and transport-level back-off.
- `test/agent-loop.test.ts` — the two-phase DO state machine: cold-start register, long-poll + re-arm, IDLE→start + MONITOR→done, drop paths (lost_race/superseded), retry-once + rescue on report/move failure, container `failed`/`unknown` status, watchdog abandonment, resume-after-restart, daily-cap, pause/resume, and MCP-failure back-off.
- `test/agent-config.test.ts`, `test/model-selection.acceptance.test.ts`, `test/harness-selection.acceptance.test.ts` — config parsing, per-ticket model resolution, and harness (Claude vs OpenCode) selection + auto-escalation.
- `test/worker.test.ts` — HTTP routing + the control/debug bearer auth.
- `test/parse-last-url.test.ts` — the stdout PR-URL parser.
- `test/*.test.mjs` (run by `pnpm test:container`) — the container job-store (`container/job-state.mjs`) plus env-forwarding and Dockerfile checks.
- `test/entrypoint.bats` — the container `entrypoint.sh` flow: clone → install → `claude`/`opencode` → commit → push → `gh pr create`, env-var guards, `--frozen-lockfile`, the never-`--no-verify` rule, and exit-code propagation.

**Expected wrangler warning** (`pnpm test` and `wrangler dev`):

```
[mf:warn] The latest compatibility date supported by the installed Cloudflare Workers Runtime is
"2025-12-13", but you've requested "2026-05-01". Falling back to "2025-12-13"...
```

We request a future compat date in `wrangler.toml` so the runtime upgrades cleanly when the toolchain bumps; the fallback is harmless.

## Deployment

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck + vitest + container + bats on every push and PR. On `main` pushes, if tests pass, it runs `pnpm wrangler deploy` using two GitHub Secrets:

- `CLOUDFLARE_API_TOKEN` — custom token with **Workers Scripts:Edit**, **Cloudflare Containers:Edit**, **Account Settings:Read**, **User Details:Read**
- `CLOUDFLARE_ACCOUNT_ID` — find with `pnpm wrangler whoami`

The `deploy` and `provision-gateway` jobs are gated on those two secrets being present: without them (a fresh fork, or this repo before you wire it up) a `gate` job makes them **skip cleanly** instead of failing, so CI is green out of the box. Set both secrets to enable deploys.

To set them: repo **Settings → Secrets and variables → Actions → New repository secret**, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Remove them to turn deploys back off.

Container image is built and pushed to Cloudflare's registry automatically as part of `wrangler deploy` (the local Docker daemon does the build, then wrangler uploads).

Manual deploy: `pnpm wrangler deploy` from a logged-in shell (`pnpm wrangler login` first).

### Point it at your own repo

The agent clones and opens PRs against a target repo. `TARGET_REPO` is **required** (no default — the container fails fast if it's unset); `TARGET_BASE_BRANCH` defaults to `main`. Set them as deploy-time vars:

```bash
wrangler secret put TARGET_REPO         # required, e.g. acme/widgets
wrangler secret put TARGET_BASE_BRANCH  # optional, defaults to main
```

Then provision a `GITHUB_PAT` whose user has push + PR access to `TARGET_REPO`.

**Known coupling not parameterized in this pass:** the *work source* is still the Metriq MCP endpoint (`METRIQ_MCP_URL`), and the agent's commit + PR body still read `Closes Metriq ticket #<id>`. So even pointed at your own repo, the agent sources tickets from Metriq and writes Metriq-flavored PR text. Decoupling the work source is a larger, separate effort (see **Open follow-ups**).

## Project rules

These are load-bearing. Read them before touching code.

1. **Tests are mandatory for every code change.** No exceptions for "trivial" fixes. Add a test, watch it fail, then write the fix.
2. **Never `--no-verify`.** **Never bypass git hooks.** The agent pushes normally, so whatever pre-push hooks the target repo defines run and gate the push. If a hook fails, fix the underlying issue.
3. **README is updated on every feature touch.** Documentation drift is a bug.
4. **No secrets in CLI args.** `wrangler secret put NAME` reads the value from an interactive prompt or stdin. Passing as a positional arg both fails and leaks the value to shell history, the wrangler log file, and (if pasted in chat) the conversation transcript. Real-terminal interactive flow only.
5. **Destructive ops require explicit confirmation, every time.** This includes `wrangler secret delete`, force pushes, and database resets in any sibling project we might shell out to.

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the test commands, the hook policy, and the TDD/commit conventions.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability and the project's secret-handling posture.

## Open follow-ups

- **Per-dispatch visibility** — Metriq lacks a `list_active_dispatches` MCP tool + agent-activity panel; you can't easily see what the agent is doing right now without hitting the `/debug` endpoint.
- **Multi-tenant support** — the target repo is now parameterized (`TARGET_REPO` / `TARGET_BASE_BRANCH`, see **Point it at your own repo**), but a single instance still authenticates with one static `GITHUB_PAT`. True multi-tenant needs a GitHub App with per-installation tokens.
- **Concurrent dispatch / agent fleet** — today the loop is a single `MetriqAgentLoop` *singleton* that processes one dispatch at a time, so the container binding's `max_instances` headroom sits idle. The Durable-Object-native path to a fleet is to **shard the loop by key** — `idFromName(<stream>)` per project/agent instead of `"singleton"` — each shard running its own independent loop. The hard part is the assignment protocol (how the work source hands tickets to N sessions without two grabbing the same one), not the Cloudflare side; the per-dispatch lifecycle could also move to a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) for durable, retryable steps.
- **Decouple the work source from Metriq** — even pointed at your own repo, the agent still sources tickets from the Metriq MCP endpoint and writes Metriq-flavored PR text (`Closes Metriq ticket #<id>`). Parameterizing the work source is a larger, separate effort.
- **bless = merge hook** — clicking bless in Metriq could trigger `gh pr merge --squash` server-side.
- **`record_failure` MCP tool** — let the agent leave a failure breadcrumb on the work item instead of only Cloudflare logs.

## Reference

Architecture and design rationale live in [`docs/`](docs/README.md) — the ADRs
under `docs/product/architecture/`, plus the open-source-LLM feasibility research
under `docs/research/`.
