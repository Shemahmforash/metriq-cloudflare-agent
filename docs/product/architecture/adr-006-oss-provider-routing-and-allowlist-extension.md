# ADR-006: Provider-Agnostic OSS Endpoint + Self-Hosted LiteLLM (Default) + Allow-List Extension

## Status

Accepted (2026-05-28; **revised** 2026-05-28 per operator Decisions A + B) — applies to feature
`open-source-llm`, Phase 2. Extends ADR-003 (allow-list as the cost + injection
guard). **Reconciles** ADR-001 (this ADR removes the CF AI Gateway from the OSS path; ADR-001's
Claude-path interposition stands unchanged).

> **Revision note (supersedes the original ADR-006):** the original routed OSS traffic through the CF
> AI Gateway compat route with a hardcoded `OPENROUTER_API_KEY`. Operator decisions reverse both: the
> OSS backend is **provider-agnostic** behind a generic OpenAI-compatible endpoint, the default
> reference backend is a **self-hosted LiteLLM proxy** (no paid aggregator, no OpenRouter dependency),
> and the **CF AI Gateway is dropped from the OSS path** (LiteLLM owns OSS cost tracking). The Claude
> path is untouched.

## Context

Phase 1's allow-list (`MODEL_ALLOW_LIST` in `src/agent-config.ts`) is **Claude-only** and the only
provider credential is `ANTHROPIC_API_KEY`. The Claude gateway route is the Anthropic provider-native
endpoint (`…/anthropic`, ADR-001), consumed via `ANTHROPIC_BASE_URL`.

Phase 2 must admit OSS `provider/model` ids (e.g. `deepseek/deepseek-v3.2`) so the harness-prefix
router (ADR-005) routes them to OpenCode. The SPIKE confirmed OpenCode dials any custom
OpenAI-**compatible** `baseURL` with bearer auth — i.e. OpenCode does not care *what* is behind the
endpoint, only that it speaks the OpenAI-compatible chat-completions protocol.

**Operator decisions reshape the backend:**

- **Decision A — provider-agnostic, LiteLLM default, no OpenRouter dependency.** The build must depend
  on the *interface* (a generic OpenAI-compatible endpoint), not any one provider. A paid aggregator
  (OpenRouter) and its fee/lock-in are to be avoided. The default/reference backend is a
  **self-hosted LiteLLM proxy** (OSS, operator-run, provider-portable, brings its own cost tracking).
  OpenRouter, Cloudflare Workers AI, and direct providers (Together/Fireworks/etc.) remain
  **interchangeable config** behind the *same* endpoint. (Honest framing: LiteLLM does **not** make
  inference free — it still routes to an upstream the operator pays for or self-hosts; the win is **no
  aggregator fee + provider portability + self-control**.)
- **Decision B — gateway follows the backend.** The OSS path does **not** route through the CF AI
  Gateway; LiteLLM provides cost tracking/observability for OSS dispatches (keyed by `work_item_id` /
  `dispatch_id`). This reduces CF lock-in, consistent with the operator's stance. Phase 2 therefore
  has **two** cost-observability sources — `cf-aig-metadata` (Claude path) + LiteLLM spend logs (OSS
  path) — which the deferred bake-off must reconcile.

Constraint anchors carried forward:
- Allow-list membership IS sanitization (ADR-003): every entry is a fixed, shell-safe `provider/model`
  token, safe to interpolate as `--model "$AGENT_MODEL"`.
- The model value never reaches the command line unvalidated — `resolveModel` (ADR-002) gates it at
  the DO trust boundary; `resolveModel` is **unchanged**.
- The `GITHUB_PAT` path is **separate** (the git/gh clone+push+PR path in `entrypoint.sh`), and is
  **never** routed through LiteLLM. LiteLLM carries only the OSS model traffic and its own key.

## Decision

### 1. A generic, provider-agnostic OpenAI-compatible endpoint (the interface the build depends on)

The harness reaches OSS models via three generic config values — **no provider name baked in**:

| Name | Kind | Channel | Purpose |
|------|------|---------|---------|
| `OSS_MODEL_BASE_URL` | secret | `ContainerEnv` constant | The OpenAI-compatible endpoint OpenCode dials → `opencode.json` `provider.options.baseURL`. Default points at the self-hosted LiteLLM proxy; swappable to any compatible endpoint. |
| `OSS_MODEL_API_KEY` | secret | `ContainerEnv` constant (only-when-set) | The endpoint's auth key → `opencode.json` `provider.options.apiKey`. For LiteLLM, this is the **LiteLLM proxy key** (the proxy is authenticated — §3). Forwarded only-when-set so an OpenCode dispatch without a key fails fast → escalates (ADR-008). |
| (the allow-listed `provider/model` id) | — | `/start` body (Phase 1) | The model id under `--model`; LiteLLM (or any backend) resolves it to an upstream. |

The original `OPENROUTER_API_KEY` is **removed everywhere**. The build knows only "an
OpenAI-compatible endpoint + a key + a model id." Which backend sits there is pure operator config.

### 2. The default/reference backend: a self-hosted LiteLLM proxy — and the swap matrix

The **default reference deployment** is a self-hosted LiteLLM proxy. It is **interchangeable** with
other backends behind the identical endpoint contract:

| Backend (set `OSS_MODEL_BASE_URL`/`OSS_MODEL_API_KEY` to it) | What it is | Cost tracking | Why / when |
|---|---|---|---|
| **Self-hosted LiteLLM** (default/reference) | OSS proxy the operator runs; fans out to any upstream provider | **LiteLLM spend logs** (keyed by request metadata) | No aggregator fee; provider-portable; self-controlled. The reference path. |
| OpenRouter | Paid aggregator | OpenRouter dashboard | Available as config; **not a build dependency**; chosen only if the operator opts into the fee. |
| Cloudflare Workers AI | CF-hosted OSS models, OpenAI-compatible endpoint | CF-side | Available as config; trades some CF lock-in for zero self-hosting. |
| Direct provider (Together / Fireworks / DeepSeek / …) | The provider's own OpenAI-compatible endpoint | Provider dashboard | Available as config; fewest hops, least portability. |

Because the build depends on the interface, switching backend = changing two secrets
(`OSS_MODEL_BASE_URL` + `OSS_MODEL_API_KEY`) and (for cost reconciliation) which spend-log source the bake-off
reads. No code change, no new dependency per backend — provider portability generalized to the
OSS path.

### 3. The new infra dependency: an always-on, IaC-provisioned, pinned, authenticated LiteLLM service

The one-shot dispatch container **cannot** host LiteLLM (it boots, runs one dispatch, dies). LiteLLM
must be an **always-on service** the dispatch container dials. Requirements (deployment requirements):

- **Always-on**: a long-lived service (e.g. a container/VM/Worker-adjacent deployment the operator
  controls), reachable at `OSS_MODEL_BASE_URL`.
- **Provisioned as code**: consistent with the operator's IaC stance (cf. ADR-001's
  `scripts/provision-gateway.sh`) — the LiteLLM deployment + its model/route config is version-controlled,
  not click-ops.
- **Version-pinned + patched**: pin the LiteLLM image/version; track security patches (it sits in the
  OSS-model credential path and is internet-reachable).
- **Authenticated (NOT an open relay)**: the LiteLLM proxy MUST require a key (`OSS_MODEL_API_KEY`).
  An unauthenticated LiteLLM is an open relay billing the operator's upstream — forbidden.
- **Single point of failure covered by the auto-escalation path (ADR-008)**: LiteLLM is a new single
  point of failure for OSS dispatches. **No new
  mechanism is needed** — LiteLLM unavailability makes the OSS dispatch exit non-zero, which the
  existing exit-code escalation (ADR-008) catches and falls back to Claude (which uses the *separate*
  CF AI Gateway path, unaffected). LiteLLM down ⇒ OSS dispatch fails ⇒ Claude rescue ⇒ no strand.

### 4. Allow-list: additive OSS ids; `resolveModel` unchanged

`MODEL_ALLOW_LIST` gains operator-chosen OSS `provider/model` entries (the ids LiteLLM/the backend
knows). `resolveModel` (ADR-002) and its precedence/fail-safe are **untouched** — it already admits
"any allow-listed id" and falls back to the (Claude) default otherwise. The hardcoded floor stays
`anthropic/*`, so the fail-safe default remains Claude (ADR-005 Part A). The allow-list stays a **code
constant** (the operator-curated cost/injection boundary; config-sourced list noted as a Phase-3
extension).

### 5. The OSS path does NOT touch the CF AI Gateway (Decision B)

OpenCode dials `OSS_MODEL_BASE_URL` (the LiteLLM proxy) **directly** — no `cf-aig-*` headers, no
gateway hop. Cost attribution on the OSS path is **LiteLLM-native** (ADR-005/007: tags/metadata keyed
by `work_item_id` + `dispatch_id`). The **Claude path keeps the CF AI Gateway unchanged** (ADR-001
stands): Claude → `…/anthropic` route with `cf-aig-metadata`. Two cost sources, reconciled by the deferred bake-off.

### 6. ADR-001 Path-A reconciliation (why a proxy is now ACCEPTED here)

ADR-001 rejected research **Path A**: inserting an **untrusted third-party** proxy
(claude-code-router / LiteLLM-as-a-service-someone-else-runs) into the **`GITHUB_PAT`-carrying Claude
credential path** (documented credential-stealing CVE, Anthropic disclaimer). **This is different on
every axis that mattered:**

| Path-A (rejected, ADR-001) | This ADR (accepted) |
|---|---|
| Untrusted **third-party** proxy | **Self-hosted, operator-controlled** LiteLLM |
| In the **Claude** credential path | On the **separate OSS-model** path |
| Carried the **`GITHUB_PAT`** | Carries **only the OSS model key** (`OSS_MODEL_API_KEY`); the `GITHUB_PAT` stays on the separate git/gh path, never through LiteLLM |
| Unpinned, unhardened community service | **Version-pinned, patched, authenticated** (§3) |

The hard constraint ADR-001 enforced — *no untrusted hop in the `GITHUB_PAT` path* — is **fully
honored**: the `GITHUB_PAT` never traverses LiteLLM, and LiteLLM is first-party (operator-controlled),
not third-party. The CF AI Gateway remains the (first-party) interposition for the Claude path. So the
"first-party only credential path" stance holds, with a precise, documented exception only for the OSS
**model** key on an operator-controlled, hardened proxy.

## Alternatives Considered

| Decision | Option | Evaluation | Verdict |
|----------|--------|------------|---------|
| **OSS backend coupling** | **Provider-agnostic generic OpenAI-compatible endpoint (chosen)** | Build depends on the interface, not a provider; LiteLLM/OpenRouter/Workers-AI/direct are swap-by-config; provider portability on the OSS path; honors the operator's anti-aggregator stance | **CHOSEN** |
| | Hardcode OpenRouter (`OPENROUTER_API_KEY`) (the original ADR-006) | Couples the build to a paid aggregator + its fee/lock-in; contradicts the operator's anti-aggregator goal; less portable | Rejected (superseded by Decision A) |
| **Default backend** | **Self-hosted LiteLLM (chosen)** | OSS, operator-controlled, provider-portable, brings cost tracking; no aggregator fee | **CHOSEN (default/reference)** |
| | OpenRouter as default | A paid aggregator as the default contradicts the operator's stance; kept only as interchangeable config | Rejected as default (allowed as config) |
| | Direct provider as default | Fewest hops but least portable (re-couples per provider); LiteLLM gives portability for free | Rejected as default (allowed as config) |
| **Gateway on OSS path** | **Drop the CF gateway; LiteLLM owns OSS cost tracking (chosen, Decision B)** | Reduces CF lock-in; LiteLLM already tracks spend keyed by metadata; the two-source cost picture is reconciled by the deferred bake-off | **CHOSEN** |
| | Keep the CF gateway in front of LiteLLM too | Re-introduces the CF lock-in the operator is reducing; double-instruments cost (gateway + LiteLLM) for no benefit on the OSS path | Rejected (Decision B) |
| **OSS proxy trust** | **Self-hosted + pinned + patched + authenticated, GITHUB_PAT excluded (chosen)** | Reconciles ADR-001 Path-A: operator-controlled, OSS-key-only, hardened; the GITHUB_PAT never traverses it | **CHOSEN** |
| | A community-hosted LiteLLM-as-a-service | Re-creates the Path-A "untrusted third-party" risk ADR-001 rejected | Rejected (regresses ADR-001) |
| **Key transport** | **`OSS_MODEL_API_KEY` as a ContainerEnv constant, only-when-set (chosen)** | One proxy key per fleet → constant lifetime, same discipline as `ANTHROPIC_API_KEY`; key-absent signal → fail fast → escalate | **CHOSEN** |

## Consequences

**Positive**
- **No OpenRouter dependency**; the build depends only on a generic OpenAI-compatible interface. Any
  backend (LiteLLM/OpenRouter/Workers AI/direct) is swap-by-two-secrets — provider portability extended
  to the OSS path.
- LiteLLM is OSS + self-hosted ⇒ no aggregator fee, full operator control, its own cost tracking.
- Reduced CF lock-in: the OSS path has no CF gateway hop.
- The allow-list extension stays purely additive; `resolveModel` unchanged.
- The new LiteLLM single point of failure is **covered by the existing escalation** (ADR-008) — LiteLLM down ⇒ OSS fails
  ⇒ Claude rescue (separate gateway path) ⇒ no strand. No new failover mechanism.
- ADR-001's first-party-credential-path constraint is **honored, not violated**: the `GITHUB_PAT`
  never traverses LiteLLM; LiteLLM is operator-controlled.

**Negative / Trade-offs**
- **New always-on infra**: a self-hosted LiteLLM service to deploy (IaC), pin, patch, and authenticate.
  This is a real operational cost (an operational item) — accepted as the price of provider portability +
  no aggregator fee + no CF lock-in on the OSS path. (For zero self-hosting, Workers AI or a direct
  provider remain config options.)
- **Two cost sources** (cf-aig-metadata for Claude, LiteLLM spend logs for OSS). The deferred bake-off
  must reconcile $/PR across both (documented in ADR-007). More work than one source, but it is the
  direct consequence of dropping the gateway from the OSS path (Decision B) and is bounded to the
  bake-off (deferred).
- LiteLLM is in the OSS-model credential path and internet-reachable → it must be authenticated +
  patched. A hardening obligation, not optional (§3).
- Allow-list maintenance still needs a redeploy to add a model (ADR-003 trade-off carried forward).

## Earned-Trust / Validation Note

Dependency-lies this design must survive, each with a probe:
1. **"LiteLLM is down / unreachable."** OpenCode dial fails → non-zero exit → ADR-008 escalation →
   Claude rescue (separate gateway path). Acceptance: an OSS dispatch with LiteLLM stopped escalates
   to a real Claude PR, no strand. This is the single-point-of-failure probe.
2. **"The OSS endpoint key is missing/wrong."** `OSS_MODEL_API_KEY` absent/invalid → fail fast →
   escalate. Acceptance: an OSS dispatch with the key unset escalates.
3. **"LiteLLM is an open relay."** Probe: assert the proxy rejects an unauthenticated request (the
   authenticated-not-open-relay invariant of §3). This is a deploy-time check.
4. **"The backend is swappable."** Probe: point `OSS_MODEL_BASE_URL` at a second compatible backend and
   confirm a dispatch runs with **no code change** (provider portability on the OSS path).

## External Integration Note

- **New operational infra item:** a self-hosted, always-on, IaC-provisioned, **version-pinned + patched +
  authenticated** LiteLLM proxy reachable at `OSS_MODEL_BASE_URL`; it carries only the OSS model key,
  never the `GITHUB_PAT`. Deploy-time check: it must reject unauthenticated requests.
- **External dependency:** the upstream OSS provider(s) LiteLLM fans out to (operator config) — their
  OpenAI-compatible surface. A liveness/shape assertion at the LiteLLM boundary is recommended.
- **Two cost sources** to reconcile in the deferred bake-off: cf-aig-metadata (Claude) + LiteLLM spend
  logs (OSS), both keyed by `work_item_id` / `dispatch_id` (ADR-007).
