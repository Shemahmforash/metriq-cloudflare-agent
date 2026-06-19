# ADR-005: Harness Selection Mechanism + Dispatch-Time `opencode.json` Generation (Version-Pinned)

## Status

Accepted (2026-05-28; **adjusted** 2026-05-28 per operator Decisions A + B) — applies to feature
`open-source-llm`, Phase 2. Extends ADR-002 (model resolution / per-dispatch
transport). The OSS path's backend is governed by ADR-006 (revised): the `opencode.json` provider
block points at the generic **`OSS_MODEL_BASE_URL`** (default: a self-hosted LiteLLM proxy), **NOT**
the CF AI Gateway, and the OSS path carries **no `cf-aig-*` headers** — OSS cost attribution is
LiteLLM-native (ADR-007). Harness selection (Part A) is unchanged.

> **Adjustment note (per Decisions A + B):** the original Part B pointed `opencode.json`'s `baseURL`
> at the CF AI Gateway compat route and wrote the `cf-aig-*` headers into the provider block. The
> revision drops the CF gateway from the OSS path: the block now points at the provider-agnostic
> `OSS_MODEL_BASE_URL` (LiteLLM by default; swappable per ADR-006) with `OSS_MODEL_API_KEY`, and carries
> cost attribution as **LiteLLM-native metadata** (work_item_id + dispatch_id) instead of cf-aig
> headers. Everything else stands: model-prefix routing (Part A), the write-it-in-`entrypoint.sh`
> decision (Part B), and the OpenCode version pin (Part C — now guarding the LiteLLM-metadata
> passthrough, same undocumented `options` surface).

## Context

Phase 1 ships a single agentic harness — Claude Code — invoked once by the `claude -p` call in
`container/entrypoint.sh` (`claude --dangerously-skip-permissions "${MODEL_ARGS[@]}" -p …`).
The model id already rides the per-dispatch `/start` body as `model` (→ `AGENT_MODEL`), is
allow-list-validated in the DO (ADR-003), and the AI Gateway route + `cf-aig-metadata` cost tags are
in place (ADR-001/004). Claude reads `ANTHROPIC_BASE_URL` + `ANTHROPIC_CUSTOM_HEADERS` from the env
**for free** — no per-dispatch config file.

A spike (not included in this repo) on OpenCode v1.15.11 (**works with caveats**)
validated OpenCode as a headless drop-in:
`opencode run --model provider/model --dangerously-skip-permissions "<positional prompt>"`,
~145 MiB self-contained Bun binary, non-interactive with `< /dev/null`, self-exits ~5 s. Two
mechanism facts drive this ADR:

1. **OpenCode does NOT read `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS`.** Its backend routing
   + any per-request metadata must be supplied via an **`opencode.json` custom-provider block**
   (`provider.<id>.options = { baseURL, apiKey, headers }`). This is the **one genuinely new glue**
   vs. the Claude path. The spike proved the mechanism end-to-end against a request sink: a custom
   OpenAI-compatible provider dialed the custom `baseURL` with `Authorization: Bearer <apiKey>` and
   carried arbitrary `options.headers` on every upstream request.
2. **`provider.options.headers` is an UNDOCUMENTED passthrough.** It is not an enumerated key in the
   published config schema (`ProviderConfig.options` lists only `apiKey, baseURL, enterpriseUrl,
   setCacheKey, timeout, headerTimeout, chunkTimeout`); it works because OpenCode forwards extra
   `options` to `@ai-sdk/openai-compatible`, which accepts `headers`. The OSS cost-attribution
   metadata path depends on this, so the OpenCode version **must be pinned**.
3. **Per Decisions A + B (ADR-006), the OSS path does NOT route through the CF AI Gateway.** The
   `opencode.json` `baseURL` points at the provider-agnostic **`OSS_MODEL_BASE_URL`** (a self-hosted
   LiteLLM proxy by default; swappable to OpenRouter / Workers AI / a direct provider). OSS cost
   tracking is **LiteLLM-native** (keyed by `work_item_id` + `dispatch_id`), not `cf-aig-metadata`.
   The Claude path keeps the CF AI Gateway unchanged (ADR-001 stands).

Two decisions are bundled here because they are inseparable in the entrypoint flow: **which harness
runs** (Decision 1) and **how OpenCode is wired to its OSS backend** (Decision 2). Claude must stay
the default and the fallback (System Constraint).

## Decision

### Part A — Harness selection: model-prefix routing off the already-resolved `/start`-body `model`

**The harness is chosen from the resolved model id, not from a second independent switch.** After
`resolveModel(...)` (ADR-002) produces the per-dispatch `{ model, source }`, a pure
`resolveHarness(model)` maps the id to a harness: `anthropic/*` → `claude` (the default + fallback),
any other allow-listed `provider/model` → `opencode`. The resolved harness rides the `/start` body
as a new `harness` field (→ `AGENT_HARNESS` in the child env) and `entrypoint.sh` branches on it.

Because the harness is **derived from the model**, the Phase-1 precedence chain
(`ticket.model > AGENT_MODEL_DEFAULT > hardcoded Claude`) already decides the harness for free:

- A ticket override of `deepseek/deepseek-v3.2` (allow-listed in Phase 2) → `opencode`.
- An `AGENT_MODEL_DEFAULT` of an `anthropic/*` id, or the unset hardcoded floor → `claude`.
- The hardcoded floor is `anthropic/*`, so **the safe default is structurally Claude**: any
  resolution that falls back (absent/blank/unknown ticket model, or unset `AGENT_MODEL_DEFAULT`)
  lands on an `anthropic/*` id and therefore on the Claude harness. There is no way to fall back to a
  default and *also* land on OpenCode — the fail-safe and the harness default are the same fact.

`AGENT_HARNESS` remains a **read-only output** of resolution carried for the container's benefit and
for the `harness` cost tag (ADR-007); it is not an operator input in this design (see "Alternatives").

### Part B — `opencode.json` generation: write it in `entrypoint.sh`, from the forwarded env, only on the OpenCode branch

When `AGENT_HARNESS=opencode`, `entrypoint.sh` writes an `opencode.json` into the working directory
(the cloned `metriq` dir, which is OpenCode's CWD) **before** invoking `opencode run`, assembled from
the **same env the DO already forwards** — no new transport channel. The provider block points at the
provider-agnostic OSS endpoint (LiteLLM by default, ADR-006), and carries cost attribution as
**LiteLLM-native metadata** (work_item_id + dispatch_id) — **no `cf-aig-*` headers** (Decision B):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "oss": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OSS backend (LiteLLM by default)",
      "options": {
        "baseURL": "<OSS_MODEL_BASE_URL>",   // generic OpenAI-compatible endpoint (self-hosted LiteLLM by default; swappable — ADR-006)
        "apiKey": "<OSS_MODEL_API_KEY>",      // the endpoint's auth key (the LiteLLM proxy key) — ContainerEnv secret, only-when-set
        "headers": {                          // UNDOCUMENTED passthrough — version-pinned. Carries LiteLLM-native cost-attribution metadata, NOT cf-aig.
          "x-litellm-metadata": "<CF_AIG_METADATA json>"  // the DO-minted tags { work_item_id, dispatch_id, model, harness, fallback_of, ... } — keys LiteLLM spend logs (ADR-007)
        }
      },
      "models": { "<AGENT_MODEL>": {} }
    }
  }
}
```

Notes on the OSS path (contrast with the Claude path, which is byte-for-byte the Phase-1 `claude`
line through the CF gateway, untouched):
- **No CF AI Gateway, no `cf-aig-*` headers** on the OSS path (Decision B). LiteLLM owns OSS cost
  tracking; the DO-minted tag object (same shape as the Claude `cf-aig-metadata`, ADR-007, including
  `harness` + `fallback_of`) is forwarded as LiteLLM-native metadata (e.g. the
  `x-litellm-metadata`/`metadata` header LiteLLM logs against spend; exact key per LiteLLM's contract,
  confirmed at pin time) so OSS $/PR is attributable in LiteLLM by `work_item_id` / `dispatch_id`.
- `OSS_MODEL_API_KEY` is forwarded **only when set** (membership rule, like the Phase-1 secrets); an
  OpenCode dispatch with no key fails fast → escalates (ADR-006/008). The same DO-minted
  `CF_AIG_METADATA` env JSON (kept its name for transport continuity) is reused as the metadata body
  — only its *destination header* differs by path.
- The model id under `--model` is the allow-list-validated, DO-resolved `AGENT_MODEL` (no free-text).
- The `GITHUB_PAT` is **never** placed in `opencode.json` or sent to LiteLLM — it stays on the
  separate git/gh path (ADR-006 §6).

The file is regenerated per dispatch (one-shot container), placed off `parseLastUrl`'s path (it is a
file write, not stdout), written `0600` under the dispatch workdir, and removed implicitly when the
ephemeral container is reaped.

### Part C — version pinning (the undocumented-passthrough guard)

The Dockerfile pins the exact version: `RUN npm install -g opencode-ai@1.15.11` (alongside, not
replacing, the Claude Code install — Claude stays default + fallback). The spike additionally
recommends `RUN opencode models` once as the `node` user at build to pre-warm the first-run SQLite
migration off the dispatch hot path. A CI smoke check asserts that the
**LiteLLM-native metadata header reaches the OSS backend** (a request hits a sink carrying the
`x-litellm-metadata` tags) after any version bump — the **empirical guard** that the undocumented
`options.headers` passthrough still holds (Earned-Trust probe; see note).

## Alternatives Considered

| Decision point | Option | Evaluation | Verdict |
|----------------|--------|------------|---------|
| **Harness selection** | (b) **Model-prefix routing** off the resolved `model` (`anthropic/*`→claude, else opencode) — chosen | One source of truth (the model id already decides everything); the Phase-1 precedence chain decides the harness for free; the safe default IS Claude by construction (the floor is `anthropic/*`); no second config surface to keep consistent; the allow-list (ADR-006) is the single gate on which OSS ids — hence which harness — are reachable | **CHOSEN** |
| | (a) Explicit `AGENT_HARNESS=claude\|opencode` operator secret, independent of the model | Adds a **second** switch that can disagree with the model (e.g. `AGENT_HARNESS=opencode` + an `anthropic/*` model, or vice-versa) → an illegal/ambiguous combination to validate and an extra failure mode; duplicates the decision the model id already encodes; an operator could pick OpenCode while the model is Claude-only | Rejected (redundant, introduces an inconsistency surface) |
| | (c) Hybrid: prefix-route by default, allow an explicit `AGENT_HARNESS` override | All of (b)'s benefits but re-introduces (a)'s disagreement surface for a Phase-3 need (forcing OpenCode on an `anthropic/*` id) that does not exist in Phase 2 (no Anthropic-compat-via-OpenCode use case) | Rejected for Phase 2 (YAGNI); noted as a forward extension point if a future model is dual-harness-capable |
| **Where `opencode.json` is generated** | **`entrypoint.sh`, on the opencode branch, from forwarded env** — chosen | The env is already present in the child (Phase-1 `server.js` forward + `ContainerEnv`); generation sits next to the header-assembly logic it mirrors in `container/entrypoint.sh`, so both harness paths share one mental model; no new transport, no new file in `src/`; the bash that already assembles `ANTHROPIC_CUSTOM_HEADERS` is the natural author of the equivalent JSON | **CHOSEN** |
| | `server.js` writes the file before spawning `entrypoint.sh` | Splits the OSS-backend wiring across two files (server.js for OpenCode, entrypoint.sh for Claude) — divergent mental models; server.js would need the OSS-endpoint + key env it currently only passes through; the file's lifetime is the dispatch, which entrypoint already owns (workdir, cleanup) | Rejected (splits a single concern) |
| | A new TS helper `opencode-config.ts` in the DO, serialized into the `/start` body | Pushes a container-implementation detail (a provider-SDK config shape) up into the Worker; couples the DO to OpenCode's config schema; the DO would carry a second large JSON blob in the body for one harness only | Rejected (wrong layer; bloats the body) |
| **Version handling** | **Pin exact `opencode-ai@1.15.11` + CI metadata-passthrough smoke check** — chosen | The OSS metadata path relies on an undocumented passthrough (`options.headers`); a silent CLI/config surface drift would break OSS cost attribution invisibly; pin + empirical post-bump probe is the only defensible posture (SPIKE caveat 2) | **CHOSEN** |
| | Float `opencode-ai@latest` | A surface drift (the passthrough is unenumerated) could break OSS metadata or the flag contract silently on any rebuild — exactly the failure the SPIKE flagged | Rejected (unsafe given the undocumented dependency) |

## Consequences

**Positive**
- One decision surface: the resolved model id drives model **and** harness; Phase-1 precedence and
  the allow-list are reused unchanged. No `AGENT_HARNESS` operator secret to set or keep consistent.
- Claude is the default + fallback **structurally**, not by a separately-maintained flag: the
  hardcoded floor is `anthropic/*`, so every fail-safe path lands on Claude.
- The cost-tag object (ADR-007) is identical across harnesses (same `harness`/`fallback_of`/`work_item_id`
  fields); only its *destination* differs — `cf-aig-metadata` to the CF gateway on the Claude path,
  `x-litellm-metadata` to LiteLLM on the OSS path. A deferred follow-up reconciles the two cost
  sources (ADR-006/007); the tag schema is built once and reused.
- `opencode.json` generation reuses the existing env forward + the existing header-assembly idioms;
  zero new transport, one new file written transiently in the container.

**Negative / Trade-offs**
- Adding a new OSS model id means an allow-list edit (ADR-006) that *also* implicitly enables the
  OpenCode harness for it — the operator must understand that `provider/model` ids route to OpenCode.
  Documented in the allow-list comment.
- The OSS metadata path through OpenCode depends on an undocumented `options.headers` passthrough; the
  version pin + CI smoke check are mandatory carrying costs (accepted; the alternative is no OSS
  harness).
- A future model that should run on OpenCode but has an `anthropic/*`-shaped id (none today) would
  need the rejected hybrid (c). Flagged, not designed.
- `entrypoint.sh` grows a branch and a JSON-assembly block. Bounded: the Claude branch is byte-for-byte
  the Phase-1 path; `< /dev/null`, `--dangerously-skip-permissions`, and the commit/push/PR steps
  are shared by both branches (ADR-008 safety invariants).

## Earned-Trust / Validation Note (CRITICAL)

The OSS metadata path through OpenCode is an **act of faith on an undocumented passthrough**. It MUST
be probed empirically, not assumed:

1. **CI metadata-passthrough smoke probe:** after any image build (and
   mandatorily after any `opencode-ai` version bump), a CI step runs one `opencode run` against a
   small request sink (the same minimal HTTP sink the spike used) and asserts the sink received the
   LiteLLM-native metadata header (`x-litellm-metadata`) carrying the tag JSON. This is the exact lie
   the environment can tell — a silent passthrough drop → OSS cost attribution silently lost —
   exercised directly. A failed probe **fails the build**: an image whose OpenCode no longer
   carries the OSS metadata must not deploy.
2. **Live edit→PR acceptance:** the spike did NOT exercise the real model
   edit→commit→PR loop (no funded key). The first live OpenCode→PR run
   against the LiteLLM backend with a funded upstream is the empirical demonstration that the harness
   honors its contract (gate-passing PR), not a claim that it does.
3. **Observable signal:** `entrypoint.sh` logs `[step] opencode-start model=<id>` and the existing
   `pr-create-ok url=…` line; the acceptance tests assert on these against a real dispatch.

## External Integration Note

OpenCode reaches the OSS model **through the provider-agnostic `OSS_MODEL_BASE_URL`** — a self-hosted
LiteLLM proxy by default (a new always-on operational infra item, ADR-006), swappable to OpenRouter /
Workers AI / a direct provider. The OSS path does **not** traverse the CF AI Gateway (Decision B);
LiteLLM owns OSS cost tracking. The metadata-passthrough smoke probe above is the contract test for
the undocumented `options.headers` surface. The LiteLLM proxy's OpenAI-compatible surface (and the
upstream provider behind it) is the external dependency; a lightweight liveness/shape assertion at the
LiteLLM boundary is recommended (ADR-006 handoff).
