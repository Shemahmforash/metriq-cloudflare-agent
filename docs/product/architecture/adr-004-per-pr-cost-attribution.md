# ADR-004: Per-PR Cost Attribution Tagging

## Status

Accepted (2026-05-28) — applies to feature `open-source-llm`, Phase 1.

## Context

Per-PR cost must be visible for **100% of dispatches**. AI Gateway (ADR-001) records
tokens + cost **per request**, but a raw request log is not yet *attributable to a PR/ticket*: the
operator needs to answer "what did dispatch `f3a9c2…` / work item `WI-3088` cost?" — including the
edge where a ticket is **rescued/retried** and produces *two* request rows that must roll up to one
ticket's true total.

Cloudflare AI Gateway supports attaching **custom metadata** to each request via a
`cf-aig-metadata` request header (a JSON object), which is then queryable/filterable in the
dashboard and logs. Claude Code forwards custom headers set via `ANTHROPIC_CUSTOM_HEADERS`
(research Finding 1.1). The DO already mints the identifiers we want to tag with (`dispatch_id`,
`work_item_id`) and resolves the model (ADR-002) before container start.

## Decision

**Tag every Anthropic request with a `cf-aig-metadata` JSON object carrying the dispatch's
identity, set as a forwarded custom header so AI Gateway attributes each request to a
ticket/PR/model.**

### Tag schema

```jsonc
// cf-aig-metadata value (JSON object)
{
  "dispatch_id":  "<uuid>",         // the dispatch (1:1 with a container run / attempt)
  "work_item_id": "<metriq id>",    // the ticket — rolls multiple attempts up to one ticket
  "short_id":     "<8-char>",       // human-readable correlation with the agent/<short_id> branch + PR
  "model":        "<resolved id>",  // the resolved model — enables per-model $/PR (Phase-2 bake-off seam)
  "source":       "<ticket|AGENT_MODEL_DEFAULT|hardcoded-default>", // provenance of the model choice
  "phase":        "1"               // schema/feature-phase marker for forward evolution
}
```

Rationale per field:
- `work_item_id` is the **roll-up key**: a rescued/retried ticket yields multiple `dispatch_id`s but one `work_item_id`, so the operator reads the ticket's *true* total by filtering on it (solves the rescued/retried-ticket edge).
- `dispatch_id` / `short_id` correlate a request row with the exact container run and the resulting `agent/<short_id>` branch + PR (the `short_id` and PR-creation steps in `container/entrypoint.sh`), giving "this PR cost $X".
- `model` + `source` make the request log already carry what the Phase-2 bake-off accounting needs to compute per-model $/PR — so Phase 2 joins on existing tags rather than re-instrumenting (the gateway log stays the *single* cost source for the Claude path).

### Where it is set

The metadata is **per-dispatch**, so it is injected the same way `AGENT_MODEL` is (ADR-002): the DO
knows all the fields at `startDispatch` time and forwards them into the container via the `/start`
body; `entrypoint.sh` assembles the JSON and exports it as part of `ANTHROPIC_CUSTOM_HEADERS`
(`cf-aig-metadata: <json>`) for the `claude` invocation. The DO is the single author of the tag
values, keeping them consistent with the logged `model-resolved` line.

(Implementation detail of *how* the header string is assembled in bash is the software-crafter's;
this ADR fixes the schema and the channel, not the shell.)

## Alternatives Considered

| Option | Evaluation | Verdict |
|--------|------------|---------|
| **`cf-aig-metadata` custom-metadata tags (chosen)** | First-party AI Gateway feature; queryable/filterable per field; rolls attempts up by `work_item_id`; carries the model so Phase 2 reuses it; zero extra storage we own | **CHOSEN** |
| Parse/correlate by timestamp only | Fragile (concurrent dispatches interleave; `max_instances=5`); no reliable roll-up of retries; breaks the rescued-ticket edge | Rejected |
| Build a separate cost-attribution datastore in the Worker (e.g. write each request's cost to DO storage) | New component + new write path + a *second* cost source that could diverge from the gateway's — directly violates the single-cost-source rule; over-engineered for "read a dashboard" | Rejected |
| Tag with only `dispatch_id` | Loses the ticket roll-up across retries (the explicit rescued-ticket edge) and the per-model dimension Phase 2 needs | Rejected (insufficient) |

## Consequences

**Positive**
- Per-PR / per-ticket / per-model cost is **queryable from the gateway itself** — no new storage, no second cost source.
- Rescued/retried tickets roll up correctly via `work_item_id` (the rescued-ticket edge is satisfied).
- The Phase-2 bake-off joins on tags already present from Phase 1 — the cost-attribution instrumentation is built once and reused.
- `model`/`source` in the tag make the cost log self-describing for audit (which model, chosen how).

**Negative / Trade-offs**
- Metadata is only as trustworthy as the header reaching the gateway: if `ANTHROPIC_BASE_URL` is misconfigured and traffic bypasses the gateway (ADR-001 negative), no tagged rows appear — same "zero requests = routing not in effect" operational signal applies.
- Tag values are PII-free identifiers (uuids, metriq ids, model ids) — no sensitive data placed in metadata. (Explicitly: never put `GITHUB_PAT`, `ANTHROPIC_API_KEY`, ticket `title`/`description`, or any secret in `cf-aig-metadata`.)
- **Tag-field provenance is shell-safe by construction:** every tagged field is DO-minted — `dispatch_id`/`short_id` are uuid-derived (`agent-loop.ts`), `work_item_id` is a Metriq id, `model`/`source` come from the allow-listed resolver (ADR-002/003). No free-text, externally-influenced string (e.g. ticket title/body) enters the metadata JSON, so the bash JSON assembly cannot be turned into a header-injection vector. The `model` field is doubly safe: it is allow-list-validated before it can appear here.
- A `phase` marker is included so the tag schema can evolve (e.g. Phase 2 adds `harness`, `fallback_of`) without ambiguity about which dispatches predate the change.

## Implementation Notes

The cost-attribution instrumentation contract is satisfied by these
tags: per-dispatch `{model, exit, pr_url(joined), cost}` is reconstructable by filtering the gateway
log on `work_item_id` / `dispatch_id`. Phase-2 dashboards and the `fallback-to-Claude` attribution
extend the tag with `harness` and a `fallback_of` link — out of scope here, flagged as the
forward extension point so the Phase-1 schema (with its `phase` marker) does not paint Phase 2 into
a corner.
