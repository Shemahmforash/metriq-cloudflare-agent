# ADR-001: AI Gateway Interposition Mechanism

## Status

Accepted (2026-05-28) — applies to feature `open-source-llm`, Phase 1.

## Context

The agent's only LLM call is the single `claude -p` invocation in `container/entrypoint.sh`,
authenticated by an `ANTHROPIC_API_KEY` that the Worker forwards into the container
(`src/agent-container.ts:6,29`). Today that traffic goes **directly to `api.anthropic.com`**.
There is no per-PR cost visibility — the operator only sees the aggregate month-end
Anthropic invoice (per-PR cost is visible for 0% of dispatches today).

We must interpose **Cloudflare AI Gateway** (a first-party Cloudflare service) between Claude
Code and Anthropic so that every dispatch's request, token count, and cost become queryable
per-PR, **with no model change** and **without inserting any non-first-party hop into the
`GITHUB_PAT`-carrying path** (the reason research Path A — community proxies like
claude-code-router / LiteLLM — was rejected; research Finding 1.3).

Constraint anchors:
- Claude Code honors `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_CUSTOM_HEADERS` (research Finding 1.1, official Claude Code LLM-gateway docs).
- The wire format Claude Code emits is the **Anthropic Messages** format with Anthropic-specific
  beta/version headers; any interposed endpoint must speak that format faithfully (Finding 1.1).
- AI Gateway natively fronts Anthropic as a provider and forwards provider headers (Finding 3.2).

## Decision

**Use the AI Gateway Anthropic *provider-native* endpoint via `ANTHROPIC_BASE_URL` (Option a).**

Set, as a Worker secret forwarded into the container exactly like `ANTHROPIC_API_KEY` is today:

```
ANTHROPIC_BASE_URL = https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic
```

Claude Code continues to send the Anthropic Messages format to that base URL; AI Gateway
forwards it to `api.anthropic.com` unchanged, recording tokens + cost per request. The existing
`ANTHROPIC_API_KEY` is carried through as the Anthropic `x-api-key` header unchanged — **no
credential reshaping**. If the gateway is configured "authenticated", a `cf-aig-authorization:
Bearer <token>` header is added via `ANTHROPIC_CUSTOM_HEADERS` (a second forwarded secret,
`AI_GATEWAY_TOKEN`); if the gateway is "unauthenticated", that header is omitted.

`ANTHROPIC_BASE_URL` is a **per-DO-instance constant**, so it travels via `ContainerEnv`
(`src/agent-container.ts:3-7,26-30`) — the same channel as `ANTHROPIC_API_KEY` — NOT via the
per-dispatch `/start` body. (Contrast with `AGENT_MODEL`, ADR-002, which IS per-dispatch.)

## Alternatives Considered

| Option | Mechanism | Evaluation | Verdict |
|--------|-----------|------------|---------|
| **(a) Anthropic provider-native endpoint** (chosen) | `ANTHROPIC_BASE_URL` → `…/anthropic` gateway route; Claude Code speaks Anthropic Messages; `ANTHROPIC_API_KEY` passes through as `x-api-key` | Zero credential reshaping; Claude Code's Anthropic-specific beta/version headers are forwarded faithfully (Finding 3.2); smallest, most reversible change (one secret); first-party only | **CHOSEN** |
| (b) Universal / OpenAI-compatible endpoint | Point Claude Code at the gateway's OpenAI-compatible `…/compat` route | Claude Code emits Anthropic Messages, **not** OpenAI chat format — would require format translation, which AI Gateway's compat endpoint does not do for an Anthropic-format *client*. Misuse of the endpoint; would break header/beta passthrough (Finding 1.1, 3.3). The compat/OpenRouter route is the **Phase 2** path for the OSS *harness* (OpenCode), not for Claude Code. | Rejected for Phase 1 |
| (c) Provider-native but via a self-hosted/3rd-party proxy first | Insert claude-code-router or LiteLLM, then gateway | Inserts a non-first-party hop into the `GITHUB_PAT` path; Anthropic disclaims LiteLLM; documented credential-stealing CVE (Finding 1.3); adds a second long-lived process + `NON_INTERACTIVE_MODE` hang risk in a one-shot container (Finding 1b.1). Violates the hard "first-party only" constraint. | Rejected (this is research Path A) |

## Consequences

**Positive**
- Per-request token + cost observability for 100% of dispatches with **no model change** — still Claude.
- First-party only: the `GITHUB_PAT` path is untouched; no third-party proxy (honors the hard constraint that the credential path stays first-party).
- Fully reversible: `wrangler secret delete ANTHROPIC_BASE_URL` reverts to direct Anthropic with zero code change.
- Establishes the Claude `$/PR` baseline that every later $/PR comparison (Phase 2 bake-off) measures against — and the AI Gateway log becomes the *single* cost source for the Claude path.

**Negative / Trade-offs**
- Adds one network hop (Cloudflare → Anthropic). Latency impact negligible (Cloudflare-to-Anthropic is fast; the dispatch is dominated by minutes of agent work, not a sub-second hop).
- A **misconfigured** base URL is a silent-failure risk: traffic could bypass the gateway and no metrics appear. Mitigation: the operator treats "zero requests in the dashboard after a known dispatch" as the signal that routing is not in effect. This is an **operational** check, not an automated one in Phase 1.
- Gateway availability becomes a dependency of the dispatch path. Cloudflare AI Gateway supports request retry/fallback (Finding 3.2); Phase 1 does not configure a fallback chain (Claude is the only model), so a gateway outage would fail dispatches the same way an Anthropic outage does today — and the existing sweeper/rescue path already handles dispatch failure terminally (no ticket stranded).

## Provisioning (as code, not click-ops)

The `metriq-agent` gateway is provisioned by **`scripts/provision-gateway.sh`** — an idempotent
Cloudflare-API call (`POST/PUT …/ai-gateway/gateways`, create-if-absent then reconcile settings) —
run in CI in the `deploy` job **before `wrangler deploy`** (`.github/workflows/ci.yml`), using the
same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets (the token additionally needs the
"AI Gateway: Edit" permission).

Why a script and not (a) the dashboard or (b) Terraform: the gateway is an **account-level resource
reached by URL** (`ANTHROPIC_BASE_URL`), not a Worker binding, so `wrangler.toml` cannot declare it.
A committed script keeps provisioning in the **same imperative-CLI-in-CI toolchain** the repo already
uses (`wrangler secret put`, `wrangler deploy`) with the gateway's settings (logging, cache, rate
limit, auth) version-controlled as the source of truth — without adding a second IaC tool (Terraform)
and its state backend for a single resource. Secret *values* (`ANTHROPIC_BASE_URL`, `AI_GATEWAY_TOKEN`,
`AGENT_MODEL_DEFAULT`) remain injected via `wrangler secret` / CI secrets, never committed.

## External Integration Note

Cloudflare AI Gateway is a first-party Cloudflare service consumed via an HTTPS base-URL override.
It is not a consumer-driven-contract candidate (no client-defined schema we own). The **upstream
Anthropic Messages API** remains the external dependency it already is today; this ADR does not
change that contract surface. No new contract tests are introduced by Phase 1.
