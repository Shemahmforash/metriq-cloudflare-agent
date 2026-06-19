# ADR-003: Model-ID Validation (Allow-List) and MCP Ingestion of the Ticket `model` Field

## Status

Accepted (2026-05-28) — applies to feature `open-source-llm`, Phase 1.

## Context

The ticket `model` field is **externally-influenced input**: it originates in a Metriq
work item, authored by a human, and arrives through the MCP `wait_for_assignment` /
`get_item` payload (`src/mcp-client.ts:63-80,124`). That string ultimately becomes the value
passed to a CLI on the container command line (`claude --model "$AGENT_MODEL"`). Two risks:

1. **Injection / command-line abuse** — an unvalidated string flowing onto a command line is a
   classic injection surface.
2. **Cost blow-out** — a (valid-looking) but expensive or unintended model id could silently
   inflate `$/PR`, defeating the entire cost-control objective.

The DISCUSS System Constraint is explicit: *"any externally-supplied model id (ticket field) is
validated against an allow-list before forwarding; an unvalidated string never reaches the
container command line."* A bad value must **fail safe** (fall back to the default + log), never
strand the dispatch (orphan-sweeper invariant). This is also research Finding 5.1 safe-default
principle (2): "validate any ticket-supplied model ID against an allow-list in the DO before
forwarding."

This is additionally a **cross-system dependency**: the Metriq side may not expose the `model`
field yet. The agent side must ship and be testable with the field **absent** (degrade to default).

## Decision

### 1. Validation strategy: explicit allow-list (NOT arbitrary passthrough)

Maintain a small **allow-list of accepted model identifiers** as a named constant in `AgentConfig`
(co-located with the hardcoded Claude default from ADR-002). The resolver (ADR-002) admits a
ticket model **only if** it is on the allow-list:

- on the list → use it (`source=ticket`)
- not on the list (unknown/garbage) → **reject**, log
  `[reject] unknown model "<value>" — falling back to default`, and resolve to the default
  (`source=AGENT_MODEL_DEFAULT` or `hardcoded-default`). The rejected string is **never** forwarded.

In Phase 1 the allow-list contains **only Claude model ids** (the cost tiers the operator wants to
choose between — e.g. an Opus/Sonnet/Haiku set), because Claude Code is the only harness and
`ANTHROPIC_API_KEY` is the only provider credential (ADR-002). Phase 2 extends the list with OSS
`provider/model` ids when the OpenCode harness and its provider creds arrive — additive, no rework.

The allow-list is also the natural place to enforce the **shell-safety** property: every entry is a
known, fixed, shell-safe token, so "on the allow-list" implies "safe to interpolate". The resolver
therefore never needs ad-hoc escaping — membership *is* the sanitization. (Defense-in-depth: the
value is still passed as a single quoted argv element `--model "$AGENT_MODEL"`, never via `eval`.)

### 2. MCP ingestion: optional, graceful-degrading field

Extend the MCP client's read path to surface an **optional** `model` string:

- `WaitResponse.payload` (`src/types.ts:4-8`) gains an optional `model?: string` (and/or
  `WorkItemSummary` gains `model?: string` if the field is read via `get_item`). Optional ⇒ a
  Metriq payload **without** the field deserializes fine; `model` is simply `undefined`.
- `waitForAssignment` returns `payload?.model` upward; `startDispatch` threads it into the
  resolver as `ticketModel` (`src/agent-loop.ts:202-206` → resolution).
- **Blank** (`""` / whitespace) is treated as **absent** → falls through to default, no error.

This rides the *existing* MCP fetch + env-forwarding; no new transport, no new client method.

## Alternatives Considered

| Decision | Option | Evaluation | Verdict |
|----------|--------|------------|---------|
| **Validation** | Allow-list (chosen) | Bounds cost-blow-out and injection deterministically; membership = sanitization; the operator controls exactly which models are billable | **CHOSEN** |
| | Arbitrary string passthrough (validate only shell-safety) | Eliminates allow-list maintenance, BUT leaves the cost-blow-out door open (any valid model id, however expensive, is honored) and trusts an external author with the billing lever. Directly contradicts the DISCUSS constraint. | Rejected |
| | Regex/format check only (e.g. `^[\w./-]+$`) | Catches injection but NOT cost-blow-out (an expensive-but-well-formed id passes); weaker than the explicit constraint requires | Rejected (insufficient) |
| **Reject behavior** | Fall back to default + log (chosen) | Honors the fail-safe / no-strand invariant; the dispatch still produces a PR on a known-good model | **CHOSEN** |
| | Fail the dispatch on unknown id | Would strand a ticket over a typo'd field — violates the orphan-sweeper guarantee and punishes the author for a recoverable mistake | Rejected |
| **Ingestion shape** | Optional `model?` on existing payload types (chosen) | Graceful degradation is automatic (absent ⇒ undefined); zero coupling to Metriq's delivery timeline | **CHOSEN** |
| | Require the field / new MCP tool | Breaks the agent side until Metriq ships the field; over-couples to the cross-system dependency | Rejected |

## Consequences

**Positive**
- Externally-influenced input is bounded at the DO trust boundary, before the command line (injection + cost guard satisfied).
- Allow-list membership doubles as sanitization — no fragile escaping logic.
- The agent side is **shippable and testable today** with the Metriq field absent (degrades to default), decoupling delivery from the Metriq schema timeline.
- Operator decides exactly which models are spend-able (cost discipline).

**Negative / Trade-offs**
- **Allow-list maintenance**: adding a new model means an `AgentConfig` constant edit + redeploy. Accepted: the set of sanctioned models changes rarely and intentionally; the maintenance cost is the price of the cost-blow-out guard. (A future Phase-3 enhancement could source the allow-list from config/secret to avoid a redeploy — noted as a non-binding extension point, out of scope.)
- A typo in a ticket `model` silently falls back to default (logged, not surfaced to the author in Phase 1). Acceptable for Phase 1 plumbing; the author-facing UX is explicitly Phase 3. The dispatch log line is the operator's signal.

## Earned-Trust / Validation Note

The dispatch log line `model-resolved source=<source> model=<model>` is the **observable proof**
that resolution + validation behaved: a known-good id logs `source=ticket`, an absent field logs
`source=AGENT_MODEL_DEFAULT`, and a garbage id logs the rejection + `source=hardcoded-default`.
Acceptance tests assert on these three log signatures against a real dispatch — the empirical
demonstration that the trust boundary holds, not a claim that it does.

## External / Cross-System Dependency

**Metriq-side dependency:** the Metriq work-item schema must add an optional `model`
field, and the MCP tool (`wait_for_assignment` payload and/or `get_item`) must return it. This is
**owned by the Metriq side, not this design**. The agent side
does not block on it. No consumer-driven contract test is mandated for Phase 1 (the field is
optional and absence-tolerant); when Metriq ships it, a lightweight contract assertion that the MCP
payload may carry `model: string` is recommended.
