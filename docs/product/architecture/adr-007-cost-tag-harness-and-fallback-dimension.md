# ADR-007: Cost-Tag Extension — `harness` + `fallback_of` Dimensions

## Status

Accepted (2026-05-28; **adjusted** 2026-05-28 per operator Decisions A + B) — applies to feature
`open-source-llm`, Phase 2. Extends ADR-004 (per-PR cost attribution
tagging), which reserved exactly this evolution. Governed by ADR-006 (revised): the OSS path no longer
uses the CF AI Gateway, so **the cost-tag object is now emitted to TWO sources** — `cf-aig-metadata`
on the Claude path (CF gateway, ADR-004) and **LiteLLM-native metadata** on the OSS path (ADR-005/006).
The tag *schema* (this ADR) is identical on both; only the destination differs.

> **Adjustment note (per Decisions A + B):** the original ADR-007 said both harnesses carry the same
> `cf-aig-metadata` and the bake-off joins on one `aig_metrics` source. Dropping the CF gateway from
> the OSS path (Decision B) means OSS cost lives in **LiteLLM spend logs** (keyed by `work_item_id` /
> `dispatch_id`), not `cf-aig-metadata`. The `harness` + `fallback_of` + `phase`-bump schema is
> unchanged; what changes is that there are now **two cost sources** the deferred bake-off must
> reconcile (added below).

## Context

ADR-004 tags every gateway request with a `cf-aig-metadata` JSON object
(`{dispatch_id, work_item_id, short_id, model, source, phase}`) and **explicitly anticipated** Phase 2
adding `harness` and a `fallback_of` link, including a `phase` marker so older dispatches are
unambiguous: *"Phase 2 adds `harness`, `fallback_of` … out of scope here, flagged as the forward
extension point so the Phase-1 schema (with its `phase` marker) does not paint Phase 2 into a corner."*

Phase 2 introduces two facts the cost log must now carry:

1. **Two harnesses** (Claude, OpenCode) can run the same fleet — the deferred bake-off must
   compute **per-harness** $/PR, CI-green, mergeable, and fallback rates. The request
   log must say *which harness* produced each request.
2. **Auto-escalation** (ADR-008): a failed OSS dispatch is re-run on Claude. The Claude
   rescue's cost MUST be attributed to the **OSS model's fallback overhead**, or OSS $/PR is
   understated (the explicit fallback-cost risk). Both attempts already share `work_item_id` (ADR-004
   roll-up), but the cost log must additionally mark the rescue as a fallback *of* the original OSS
   attempt so the bake-off can split base-cost from fallback-overhead.

This ADR fixes the schema; it does not build the bake-off (DEFERRED until Phase 1's Claude
$/PR baseline accumulates). The deferred bake-off is the **consumer** of these tags.

## Decision

Extend the `cf-aig-metadata` tag object (the `CostAttributionTags` interface in `src/resolve-model.ts`
and the `buildCostAttributionTags` builder) with two new DO-minted fields and bump the `phase` marker:

```jsonc
{
  "dispatch_id":  "<uuid>",
  "work_item_id": "<metriq id>",      // unchanged roll-up key — both attempts share it
  "short_id":     "<8-char>",
  "model":        "<resolved id>",    // the resolved model id
  "source":       "<ticket|AGENT_MODEL_DEFAULT|hardcoded-default>",
  "harness":      "<claude|opencode>",        // NEW (ADR-005): which harness produced this request
  "fallback_of":  "<original dispatch_id> | null",  // NEW (ADR-008): set on a Claude rescue of a failed OSS attempt
  "phase":        "2"                 // bumped 1 → 2; Phase-1 rows stay "1"
}
```

Field semantics:
- **`harness`** is the pure `resolveHarness(model)` output (ADR-005 Part A) — `anthropic/*` →
  `claude`, else `opencode`. DO-minted, derived from the allow-listed model id; no free-text. Lets
  the bake-off filter $/PR and quality rates per harness.
- **`fallback_of`** is `null` on a normal dispatch. On a Claude rescue triggered by auto-escalation
  (ADR-008), it carries the **original OSS dispatch's `dispatch_id`**, so the rescue's cost
  rows link back to the failed OSS attempt. The bake-off attributes the rescue cost to the OSS model's
  fallback overhead by: grouping all rows by `work_item_id`, then summing base-OSS-cost +
  fallback-Claude-cost (rows where `fallback_of` is non-null) into the OSS model's true $/PR. This
  satisfies exactly the requirement that the rescue's Claude cost is attributed to the OSS model's
  fallback overhead, and the guard that fallback overhead is not omitted from per-PR cost.
- **`phase: "2"`** distinguishes the extended schema; Phase-1 dispatches (still `"1"`) lack
  `harness`/`fallback_of`, which the bake-off treats as `harness=claude, fallback_of=null` (Phase 1
  was Claude-only) — the marker makes that back-fill unambiguous.

The fields ride the **same per-dispatch channel** as the Phase-1 tags: minted in the DO at
`startDispatch` (via `buildCostAttributionTags`), serialized into the `/start` body's `cost_tags`.
The **tag object is identical** across harnesses; only its **destination differs by path** (Decision B):
- **Claude path** — exported by `entrypoint.sh` as `cf-aig-metadata` on the CF AI Gateway request
  (ADR-004, unchanged); cost lands in the gateway request log.
- **OSS path** — written into `opencode.json` as a LiteLLM-native metadata header
  (`x-litellm-metadata`, ADR-005); cost lands in **LiteLLM spend logs**, keyed by `work_item_id` /
  `dispatch_id`. **No CF gateway, no `cf-aig-metadata`** on this path.

So `harness`/`fallback_of`/`work_item_id` are present and consistent in **both** cost sources — the
schema is uniform even though the storage is split.

## Alternatives Considered

| Decision | Option | Evaluation | Verdict |
|----------|--------|------------|---------|
| **How to record per-harness cost** | **Add `harness` to the existing tag (chosen)** | One-field additive change to a schema ADR-004 designed to evolve; both cost sources (cf-aig + LiteLLM spend logs) carry it; the bake-off joins on it; no *bespoke Worker-side* cost store (the two sources are the gateway's + LiteLLM's own, not a third we invent) | **CHOSEN** |
| | Infer harness from `model` prefix at query time | Works for the bake-off but bakes the ADR-005 routing rule into the analytics layer too — two places to keep consistent; an explicit tag is self-describing and audit-friendly | Rejected (couples analytics to routing) |
| | A separate per-harness datastore in the Worker | New write path + a *third* cost source that can diverge from the two upstream ones (gateway + LiteLLM) — the exact anti-pattern ADR-004 rejected | Rejected (regresses ADR-004) |
| **OSS cost source (Decision B)** | **LiteLLM spend logs, keyed by the same tags (chosen)** | LiteLLM already tracks spend; reusing it avoids a CF gateway hop on the OSS path (reduces lock-in); the tag schema is identical so reconciliation is a join on `work_item_id` | **CHOSEN** |
| | Keep OSS cost in cf-aig-metadata (route OSS through the CF gateway) | Re-introduces the CF lock-in Decision B removes; double-instruments OSS cost for no benefit | Rejected (Decision B) |
| **How to attribute fallback cost** | **`fallback_of` link to the original dispatch (chosen)** | Preserves the `work_item_id` roll-up AND lets the bake-off separate base-cost from fallback-overhead; the link is the minimal fact needed; DO-minted | **CHOSEN** |
| | Rely on `work_item_id` roll-up alone (no link) | Rolls both attempts to one ticket but cannot distinguish base-OSS-cost from Claude-rescue-cost — fallback overhead becomes uncomputable; understates OSS $/PR | Rejected (insufficient for fallback attribution) |
| | A boolean `is_fallback` instead of a link | Marks the rescue but loses the back-link to the specific failed attempt (weaker audit; can't reconstruct the attempt chain) | Rejected (less than the link, no cheaper) |

## Consequences

**Positive**
- The bake-off computes per-harness $/PR and fallback-attributed OSS $/PR by **filtering the
  same tag fields in both sources** — the instrumentation is built once here and in ADR-004, reused,
  never re-instrumented. These rates are derivable from cf-aig (Claude) + LiteLLM spend logs (OSS),
  joined on `work_item_id`.
- `harness` makes every cost row self-describing for audit (which harness, which model, chosen how) in
  both sources.
- `fallback_of` satisfies the "don't understate OSS $/PR" requirement deterministically — the
  Claude rescue's cost lives in cf-aig (Claude path) but links back via `fallback_of` to the OSS
  attempt in the LiteLLM source.
- The `phase` bump keeps Phase-1 and Phase-2 rows unambiguous.

**Negative / Trade-offs**
- **Two cost sources to reconcile** (cf-aig-metadata for Claude, LiteLLM spend logs for OSS) — the
  direct consequence of Decision B. The deferred bake-off joins on `work_item_id`; the cross-source
  fallback link (`fallback_of`, set on the Claude-path cf-aig row, pointing at the OSS-path LiteLLM
  attempt) is the join key for fallback attribution. More work than one source, bounded to the
  deferred bake-off.
- Two more fields in every tag object (still PII-free identifiers — no secrets, no ticket text; the
  ADR-004 injection-guard invariant holds: every field is DO-minted / allow-list-derived). Neither
  the cf-aig nor the LiteLLM metadata ever carries the `GITHUB_PAT` (ADR-006 §6).
- The bake-off must handle the `phase=1` back-fill rule (treat as `claude`/`null`). Documented above;
  trivial.
- `CostAttributionTags` and `buildCostAttributionTags` change shape (EXTEND), so their Phase-1 unit
  tests update to assert the new fields. Bounded, additive.

## Earned-Trust / Validation Note

The tags are only trustworthy if they actually reach **their respective sources**. The
metadata-passthrough smoke probe (ADR-005) asserts the LiteLLM-native metadata header arrives on the
OSS route; the Phase-1 Claude route already carries `cf-aig-metadata`. The fallback-attribution
correctness (a Claude rescue links to its OSS origin **across the two sources**) is demonstrable
end-to-end during implementation: a real failing OSS dispatch (LiteLLM spend-log row,
`harness=opencode`) + its Claude rescue (cf-aig row, `harness=claude`, `fallback_of=<the OSS
dispatch_id>`) must be joinable by `work_item_id`. Acceptance tests assert this against a real
escalation — the empirical proof that fallback cost is attributable across both sources, not a claim.

## Implementation Notes

The deferred bake-off reconciles **two** cost sources keyed by the same tags:
**cf-aig-metadata** (Claude path, the CF gateway request log) + **LiteLLM spend
logs** (OSS path, ADR-006). Reconciliation: group both by `work_item_id`; per group, the OSS base
attempt(s) (LiteLLM) + any `fallback_of`-linked Claude rescue (cf-aig) sum to the OSS model's true
$/PR (incl. fallback overhead); `harness` partitions the per-model/per-harness quality rates;
the fallback rate = count of `fallback_of != null` Claude rescues ÷ OSS dispatches.
The two-source join is the only added complexity vs the original single-source plan (Decision B
trade-off); both sources are upstream-owned (gateway + LiteLLM), so no bespoke Worker-side cost store
is introduced.
