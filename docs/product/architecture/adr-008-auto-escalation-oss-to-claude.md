# ADR-008: Auto-Escalation of a Failed OSS Dispatch to Claude (Exit-Code Trigger, Escalate-Once, No-Strand Reuse)

## Status

Accepted (2026-05-28) — applies to feature `open-source-llm`, Phase 2.
Builds on ADR-002 (model resolution / fail-safe invariant), ADR-005 (harness routing), ADR-007
(`fallback_of` cost link), and the existing `monitorDispatch` / `rescueOrphanedDispatch` / sweeper
machinery (`src/agent-loop.ts:389-619`, orphan path from commit `1c3d850`).

## Context

When an OSS-harness (OpenCode) dispatch fails, the System Constraint requires it to be **re-run on the
Claude default** — automatically, once, reusing the existing reliability machinery, with the no-strand
invariant intact and the fallback cost attributed.

The **verified codebase shape** (the load-bearing fact this ADR must design around):

- `monitorDispatch` (`agent-loop.ts:389-445`) reacts to the container's `/status`. On **`failed`**
  (non-zero exit — `job-state.mjs:42-46` sets `status:"failed"` from a non-zero `close` code),
  **`unknown`** (container lost the job), and the **watchdog** (`running` past `maxMs`), the current
  behavior is identical: it logs and **`delete("currentDispatch")`**, then re-arms the idle poll.
  There is **no in-DO re-dispatch** — the ticket is simply released, and Metriq's dispatcher
  re-delivers it on a later `waitForAssignment` (`pollForWork`). On the **`done`-but-no-URL** /
  empty-PR case, `finalizeDispatch` (`:459-467`) logs and returns without finalizing — same effect:
  the ticket is not moved to done and gets re-delivered.
- `rescueOrphanedDispatch` (`:561`) is **NOT** a re-dispatch path — it handles the *success*-case
  bookkeeping failure (a PR was produced but `report_artifact`/`move_item` failed) by posting a
  comment + filing a GH issue. It does not re-run anything.
- **Re-delivery is a future, separate `waitForAssignment`** on a later alarm cycle — a *new dispatch_id*
  for the same `work_item_id`. The escalation intent therefore cannot live on the in-flight
  `currentDispatch` (it is deleted on failure); it must **persist in DO storage keyed by
  `work_item_id`** to survive the gap between the failed OSS dispatch and the next delivery of that
  ticket.

The SPIKE is explicit on the trigger: escalate off the **harness exit code**, NOT `--format json`
stdout (the probe host's missing AVX left `run` stdout empty even on success, so stdout shape is
unconfirmed on real hardware). Exit-code-based escalation is the safer contract.

## Decision

**On an OSS-dispatch failure, record an escalation intent in DO storage keyed by `work_item_id`;
on the next dispatch of that work item, coerce the model to the Claude default (escalate-once) and
tag the rescue with `fallback_of` = the failed OSS dispatch_id. Reuse — do not replace — the existing
`monitorDispatch` terminal handling and the Metriq re-delivery path; add no parallel control flow.**

### 1. Trigger: exit code, not stdout

The failure signals are exactly the **existing** terminal branches of `monitorDispatch`, all driven
by the container exit code or its absence — no new detection:
- **`failed`** (non-zero exit) — `job-state.mjs` derives this from the child's `close` code. Covers
  OpenCode crashing, a missing/invalid `OSS_MODEL_API_KEY` (ADR-006 fail-fast), **the LiteLLM backend
  being down / unreachable** (the dial fails → non-zero exit — the new SPOF, ADR-006 §3, covered with
  **no new mechanism**), a non-zero `opencode run`, or a failed push (e.g. a target-repo pre-push hook rejecting it).
- **empty PR** — `finalizeDispatch` sees `done` but `parseLastUrl` returns null (OpenCode made no
  edits). Treated as failure (a failed dispatch).
- **watchdog** — `running` past `containerTimeoutMs` (30 min) — OpenCode hung/overran.
- **unknown** — container restarted and lost the job.

`--format json` stdout is **not** consulted (SPIKE caveat). Each of these four branches is where the
escalation intent is recorded (see §3) — they already converge on "this dispatch failed terminally."
**LiteLLM SPOF note (Decision B):** because the OSS path now depends on a self-hosted LiteLLM service
(ADR-006), its unavailability is a new single point of failure for OSS dispatches — but it surfaces as
exactly the `failed` (non-zero exit) branch above and escalates to Claude, which uses the **separate**
CF AI Gateway path (unaffected by LiteLLM being down). LiteLLM down ⇒ OSS dispatch fails ⇒ Claude
rescue ⇒ no strand. No new failover code.

### 2. Where escalation state lives: a `work_item_id`-keyed map in DO storage

A new storage entry `escalations` (a small map, or per-key entries `escalation:<work_item_id>`) holds:

```
escalation:<work_item_id> = {
  failedDispatchId: "<the OSS dispatch_id that failed>",
  failedModel:      "<the OSS model id>",
  failedHarness:    "opencode",
  recordedAt:       <epoch ms>,
}
```

This is the **only** new state. It lives in DO storage (not on `currentDispatch`, which is deleted on
failure) precisely because the rescue happens on a **later, separate** dispatch of the same ticket.
The map is keyed by `work_item_id` (the stable identity across attempts, per ADR-004 roll-up).

### 3. The flow — reusing existing seams

```
[OSS dispatch fails]  monitorDispatch: failed | empty-PR | watchdog | unknown
   └─ (existing) delete("currentDispatch"); re-arm idle poll
   └─ (NEW, only if the failed dispatch's harness was opencode AND no escalation
       already recorded for this work_item_id):
         storage.put("escalation:<work_item_id>", { failedDispatchId, failedModel, ... })

[ticket re-delivered]  pollForWork → waitForAssignment returns the SAME work_item_id (new dispatch_id)
   └─ startDispatch:
        resolved = resolveModel(...)                       // normal Phase-1/2 resolution
        esc = storage.get("escalation:<work_item_id>")
        if (esc) {                                          // ESCALATE-ONCE
          resolved = { model: config.agentModelDefault (Claude floor), source: "hardcoded-default" }
          fallbackOf = esc.failedDispatchId                 // ADR-007 cost link
          storage.delete("escalation:<work_item_id>")       // consume the intent — guard against a 2nd escalation
        }
        harness = resolveHarness(resolved.model)            // → "claude" (the floor is anthropic/*)
        costTags = buildCostAttributionTags({ ..., harness, fallbackOf })
        POST /start { ..., model: resolved.model, harness, cost_tags }
```

Key properties:
- **No new control flow / no parallel rescue path.** The escalation is two small touches on the
  *existing* seams: a `storage.put` in the (already-present) `monitorDispatch` failure branches, and a
  storage check + model coercion at the top of the (already-present) `startDispatch` resolution. The
  Metriq re-delivery, the sweeper, `rescueOrphanedDispatch`, and the terminal/GH-issue handling are
  **untouched**.
- **The escalation forces Claude via the existing resolver inputs** — it sets the resolved model to
  `config.agentModelDefault`'s Claude floor; the harness router (ADR-005) then routes it to Claude
  structurally. No special-case "run Claude" branch in `entrypoint.sh`.

### 4. Escalate-once guard (no infinite loop)

The intent is **consumed (deleted) the moment it is applied** at the next `startDispatch`. Therefore:
- An OSS failure → record intent → next dispatch runs **Claude** with the intent cleared.
- If that **Claude rescue also fails**, no escalation intent exists for the work item anymore (it was
  consumed), and the failed harness is `claude` (not `opencode`), so the §3 NEW branch does **not**
  re-record — the ticket falls through to the **existing** terminal handling (re-deliver / sweeper /
  GH issue) exactly as a Claude failure does today. **No second escalation, no loop.**
- Recording is also **idempotent**: the NEW branch records only if `harness === opencode` AND no
  `escalation:<work_item_id>` already exists, so duplicate failure observations for the same dispatch
  cannot stack multiple intents.

### 5. No-strand invariant preserved

The no-strand guarantee is **entirely the existing machinery's** — escalation does not touch it:
- Every failure still ends in `delete("currentDispatch")` + Metriq re-delivery (or, on a
  success-with-bookkeeping-failure, `rescueOrphanedDispatch` → comment + GH issue).
- Escalation only **biases the model** of the next delivery toward Claude; it never short-circuits or
  replaces the terminal handling. If Claude also fails, the ticket reaches the same terminal state it
  would today: a PR, or a filed GH issue — never stranded.
- The watchdog/unknown/empty-PR paths all already release the ticket safely; the NEW branch is purely
  additive bookkeeping beside the existing `delete`.

### 6. Cost roll-up (ADR-004 + ADR-007)

Both attempts share `work_item_id` (existing roll-up). The Claude rescue's `cost_tags` carry
`harness=claude` and `fallback_of=<failed OSS dispatch_id>` (ADR-007), so the deferred bake-off
attributes the rescue cost to the OSS model's fallback overhead — OSS $/PR is not
understated.

## Alternatives Considered

| Decision | Option | Evaluation | Verdict |
|----------|--------|------------|---------|
| **Trigger** | **Container exit code (failed/empty-PR/watchdog/unknown)** — chosen | Reuses the four existing terminal branches verbatim; robust on real hardware; SPIKE-mandated (stdout shape unconfirmed) | **CHOSEN** |
| | Parse `opencode run --format json` stdout for a failure signal | Stdout shape unconfirmed on real Cloudflare hardware (SPIKE: empty even on success on the probe host); a fragile, unproven surface for a safety-critical trigger | Rejected (SPIKE caveat) |
| **Where escalation state lives** | **`work_item_id`-keyed map in DO storage** — chosen | Survives the gap between the failed dispatch and the ticket's next (separate) delivery; keyed by the stable cross-attempt identity; minimal new state | **CHOSEN** |
| | On `currentDispatch` | Deleted on failure (the very moment escalation is needed); cannot survive to the next dispatch | Rejected (lifetime mismatch) |
| | Re-dispatch synchronously inside `monitorDispatch` (don't release to Metriq) | Invents a parallel re-dispatch control flow (a second `startContainer` from the monitor), duplicating claim/cap/move logic; bypasses Metriq's queue/claim model; the slice explicitly says "reuse existing machinery, no new control flow" | Rejected (violates the reuse constraint; new control flow) |
| **Escalate-once guard** | **Consume (delete) the intent on application** — chosen | Structurally prevents a second escalation; a Claude rescue failure falls through to today's terminal handling; no counter to maintain | **CHOSEN** |
| | A retry counter on the work item | More state, more edge cases (reset semantics, persistence); escalate-once needs only a present/absent flag | Rejected (over-engineered for once) |
| | No guard (always re-escalate on OSS failure) | Infinite OSS→Claude→(if mis-keyed)→… risk; cost runaway | Rejected (unsafe) |
| **Forcing Claude** | **Coerce resolved model to the Claude floor; let ADR-005 router route to Claude** — chosen | No special-case harness branch; reuses the resolver + router; the floor is always a valid Claude id | **CHOSEN** |
| | A dedicated "rescue mode" flag through to `entrypoint.sh` | A second code path in the container to test + keep safe; the model-coercion approach needs none | Rejected (needless container branch) |

## Consequences

**Positive**
- Auto-escalation is **two additive touches** on existing seams (a `storage.put` in `monitorDispatch`'s
  failure branches; a storage check + model coercion in `startDispatch`) — no parallel rescue control
  flow, honoring the slice's hard constraint.
- No-strand is preserved by construction: escalation never bypasses the existing terminal/sweeper/GH-issue
  machinery; it only biases the next delivery's model.
- Escalate-once is structural (intent consumed on use) — a Claude rescue failure degrades gracefully to
  today's behavior; no loop, no runaway.
- Fallback cost is attributed (ADR-007 `fallback_of`), so OSS $/PR in the deferred bake-off is honest.

**Negative / Trade-offs**
- One new storage key family (`escalation:<work_item_id>`). Small, self-cleaning (consumed on use).
  A ticket that fails on OSS but is then **never re-delivered** (e.g. permanently removed in Metriq)
  would leave a dangling intent; bounded mitigation: an optional TTL/expiry sweep on the map (noted,
  low priority — a stale intent is harmless: it only biases a delivery that will never come).
- Escalation depends on Metriq re-delivering the released ticket (the existing re-delivery contract).
  This is the **same** dependency the current failed-dispatch handling already relies on; this design
  does not add a new external dependency; it rides the existing one. (If Metriq's re-delivery ever
  changed, today's failed-dispatch recovery would change identically — orthogonal to this ADR.)
- The first dispatch of a freshly-failed ticket that races re-delivery before the `put` commits is
  not possible: the `put` is awaited in `monitorDispatch` before the idle poll is re-armed, and
  re-delivery is a subsequent alarm cycle.

## Earned-Trust / Validation Note (CRITICAL)

The dependency-lies this design must survive, each with its probe:

1. **"The OSS harness lies by exiting zero with no work" (empty PR).** Probed by the `finalizeDispatch`
   no-URL branch → recorded as a failure → escalated. An acceptance test exercises a real OSS dispatch
   that produces no edits escalating to a real Claude rescue PR.
2. **"The OSS endpoint key is missing/wrong."** ADR-006 fail-fast → non-zero exit → `failed` branch →
   escalated. Acceptance: an OSS dispatch with `OSS_MODEL_API_KEY` deliberately unset escalates, no
   strand.
3. **"The LiteLLM backend is down / unreachable"** (the new SPOF, Decision B). The dial fails →
   non-zero exit → `failed` branch → escalated to Claude (separate CF gateway path). Acceptance: an
   OSS dispatch with LiteLLM stopped escalates to a real Claude PR, no strand. **No new mechanism** —
   the existing exit-code escalation covers it.
4. **"The harness hangs."** Watchdog (30 min) → abandon → escalate.
5. **Escalate-once must actually be once.** Probe: force two consecutive OSS failures on the same work
   item in a test — assert the second delivery runs Claude and the third (Claude) failure does NOT
   re-escalate (falls to terminal handling). This is the self-applied Earned-Trust probe: a test that
   the guard is genuinely consume-on-use, not merely claimed.
6. **No-strand under escalation.** Probe: an OSS failure whose Claude rescue also fails ends with a PR
   or a filed GH issue and `stranded count == 0` ("No ticket is stranded").

The observable signals the acceptance tests assert on: the `fallback_of`-linked, `work_item_id`-matched
pair of cost rows (one `harness=opencode`, one `harness=claude`), and the recorded fallback event in the
dispatch-outcome record.

## Implementation Notes

- The dispatch-outcome record must capture the fallback event (`opencode FAILED→claude`) so the
  deferred bake-off can compute the fallback rate — the `fallback_of` cost tag (ADR-007) is the durable
  record; the dispatch-outcome event is the operator-facing roll-up.
- Acceptance scenarios: the six Earned-Trust probes above (incl. the LiteLLM-SPOF probe) map 1:1 to
  the acceptance scenarios (re-dispatch on Claude / no strand / rescued cost attributed) plus the
  escalate-once guard.
