# Evolution — open-source LLM support (Phase 1)

**Status:** Phase 1 (model default, ticket override, cost attribution) delivered.

## What & why
Make the agent's LLM operator-controllable and per-PR-cost-attributable, so spend is visible/movable and the agent isn't locked to a single vendor — without removing Claude as the default/fallback. Driven by the feasibility research (`docs/research/open-source-llm/`): the swap point is a single `claude -p` line inside the one-shot container; the orchestration layer is model-agnostic.

## How it was built
Research → design (ADR-001..004) → acceptance tests → implementation. See `docs/research/open-source-llm/` and `docs/product/architecture/`.

## Delivered behavior (Phase 1)
- **Model resolution** (`src/resolve-model.ts`, pure): precedence ticket > `AGENT_MODEL_DEFAULT` > hardcoded Claude floor; allow-list fall-through; never throws.
- **Per-dispatch transport**: resolved `{model, source, cost_tags}` ride the POST `/start` body; constant `ANTHROPIC_BASE_URL`/`AI_GATEWAY_TOKEN` ride ContainerEnv.
- **Operator default**: `AGENT_MODEL_DEFAULT` (Worker config) → fleet default; unset = today's Claude behavior (zero regression).
- **Per-ticket override**: optional Metriq work-item `model` (via MCP) overrides the default; unknown/blank/absent → safe default + `console.warn("unknown model …")`, dispatch never strands.
- **AI Gateway + cost attribution**: `ANTHROPIC_BASE_URL` forwarded to the container; six-field `cf-aig-metadata` minted per dispatch (`dispatch_id, work_item_id, short_id, model, source, phase`), rolled up by `work_item_id`; consumed by `container/{server.js,entrypoint.sh}` as `claude --model` + `ANTHROPIC_CUSTOM_HEADERS`.

## Files
NEW: `src/resolve-model.ts`. EXTENDED: `src/agent-loop.ts`, `src/agent-config.ts`, `src/agent-container.ts`, `src/mcp-client.ts`, `src/types.ts`, `container/server.js`, `container/entrypoint.sh`. Tests: `test/model-selection.acceptance.test.ts`, `test/entrypoint.bats` (+7), `test/*.test.mjs` (+4). EXTEND-only; one new pure module, no new classes.

## Quality evidence
vitest 78 pass / 1 `@requires_external` skip / 0 errors · container node:test 11/11 · bats 21/21 · typecheck green · reviewed (0 defects). Built test-first across four commits.
Gaps: mutation testing skipped (no Stryker harness); operator demos are deploy-time (validated locally via the acceptance suite proxy).

## Follow-ups
- **Metriq side (cross-system dependency):** add optional `model` field to the work-item schema + surface via MCP `wait_for_assignment`. Agent ships green with it absent.
- **Deployment:** provision the Cloudflare AI Gateway (`metriq-agent`, Anthropic provider); set secrets `ANTHROPIC_BASE_URL` (+ optional `AGENT_MODEL_DEFAULT`, `AI_GATEWAY_TOKEN`) via `wrangler secret put`; run the operator demos against a preview deploy; confirm per-PR cost rows keyed by `work_item_id`.
- **Phase 3:** auto-routing + user-facing model-choice UX (deferred).
- **Testing:** add StrykerJS (vitest runner) to enable the mutation gate.

---

# Phase 2 — OpenCode harness + auto-escalation

**Status:** Delivered. Bake-off measurement deferred.

## How it was built
Spike (OpenCode headless drop-in — works with caveats) → design (ADR-005..008; revised to drop the OpenRouter dependency) → acceptance tests (+ shared `test/do-harness.ts`) → implementation (four test-first steps + a review-remediation pass).

## Delivered behavior
- **Harness selection by model prefix** (`resolveHarness`, ADR-005): `anthropic/*` → Claude, else OpenCode. Harness is **model-derived, not an operator flag**; Claude stays the structural default + fallback. Reuses Phase-1 operator-default / ticket-override.
- **OpenCode harness in the container**: the `/start` body carries `harness`; `container/server.js` forwards it as `AGENT_HARNESS`; `container/entrypoint.sh` branches — the OpenCode path generates `opencode.json` (built safely via `node`, not bash interpolation) pointing at the **provider-agnostic** `OSS_MODEL_BASE_URL`/`OSS_MODEL_API_KEY` with LiteLLM-native cost metadata, **no cf-aig headers**, and runs `opencode run --model … --dangerously-skip-permissions`; fail-fast on missing OSS key. Claude path byte-for-byte unchanged. `opencode-ai@1.15.11` pinned in the Dockerfile.
- **Provider-agnostic OSS backend** (ADR-006): generic OpenAI-compatible endpoint; **self-hosted LiteLLM is the default/reference** (OpenRouter/Workers-AI/direct are swap-by-config); no paid-aggregator dependency. CF AI Gateway dropped from the OSS path (LiteLLM owns OSS cost tracking); Claude path keeps the gateway. Two cost sources joined on `work_item_id` for the deferred bake-off.
- **Auto-escalation OSS→Claude** (ADR-008): an OSS dispatch failure (container exit code — incl. LiteLLM-down / empty-PR / watchdog) records a `work_item_id`-keyed escalation intent in DO storage; the ticket's next delivery is coerced to the Claude floor with `fallback_of` set; **escalate-once** (consume-on-apply); the existing orphan-sweeper / `rescueOrphanedDispatch` **no-strand** path is untouched. The LiteLLM single-point-of-failure rides this same mechanism.
- **Cost tags** gain `harness` + `fallback_of`, `phase` "2" (ADR-007); injection guard preserved.

## Files
NEW pure helper `resolveHarness` (in `src/resolve-model.ts`). EXTENDED: `src/agent-loop.ts` (routing + escalation), `src/agent-container.ts` (`OSS_MODEL_*`), `src/agent-config.ts` (additive allow-list), `container/entrypoint.sh`, `container/server.js`, `container/Dockerfile` (opencode pin). Tests: `test/do-harness.ts` (extracted shared alarm-clearing harness — also hardens Phase 1 against the CI flake), `test/harness-selection.acceptance.test.ts`, `test/entrypoint.bats`, `test/server-env.test.mjs`, `test/dockerfile-app-files.test.mjs`. EXTEND-only; one new pure helper + one transient generated `opencode.json`.

## Quality evidence
vitest 91 pass / 2 `@requires_external` skip / 0 errors / 0 leaks (deterministic) · container node:test 14/14 · bats 26/26 · typecheck green · reviewed, with one remediation pass (fixed: opencode-ai pin in Dockerfile, safe `node`-built opencode.json, non-empty `failedModel`). Built test-first across five commits.

## Known gaps / follow-ups
- **Bake-off:** the LiteLLM `x-litellm-metadata` header contract is unverified without a real LiteLLM — confirm at deploy; OSS $/PR attribution depends on it.
- **Funded OSS key required** for the live OpenCode→LiteLLM→PR run (`@requires_external`, still skipped) and for the bake-off measurement.
- **Deployment:** stand up the self-hosted LiteLLM proxy (always-on, provisioned, pinned, authenticated) at `OSS_MODEL_BASE_URL`; set `OSS_MODEL_BASE_URL`/`OSS_MODEL_API_KEY` via `wrangler secret put`.
