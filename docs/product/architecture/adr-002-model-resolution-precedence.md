# ADR-002: Model Resolution, Precedence, and Per-Dispatch Transport

## Status

Accepted (2026-05-28) — applies to feature `open-source-llm`, Phase 1.

## Context

The model the agent runs is currently **implicit**: the `claude -p` invocation in
`container/entrypoint.sh` runs with **no `--model` flag**, so Claude Code picks its own default.
Changing the model means editing code and redeploying (not provider-portable today). We need three
configurable sources for the model, with a fixed precedence:

```
ticket.model  >  AGENT_MODEL_DEFAULT  >  hardcoded Claude default
                                            (the floor)
```

Two facts about the codebase shape this decision:

1. **`AgentConfig` (`src/agent-config.ts`) already implements "env override with typed default"**
   (`parseIntOr`, `env.X ?? DEFAULT`). `AGENT_MODEL_DEFAULT` fits this pattern exactly — a new
   `readonly agentModelDefault` field.
2. **There are TWO distinct transport channels into `entrypoint.sh`, and they have different
   lifetimes** (verified from `src/agent-container.ts:26-30` and `container/server.js:15-26`):
   - **`ContainerEnv` → `process.env`**: set at *container construction*, a **per-DO-instance
     constant** (e.g. `ANTHROPIC_API_KEY`, `GITHUB_PAT`). Inherited by the child via `server.js`
     `...process.env`.
   - **POST `/start` body → `ctx` → child env** (`server.js:19-24`): **per-dispatch** values
     (`WORK_ITEM_ID`, `TITLE`, `DESCRIPTION`, `SHORT_ID`). Built in `startDispatch` as
     `containerBody` (`src/agent-loop.ts:296-302`).

   The resolved model **varies per dispatch** (a ticket override applies to one dispatch only),
   therefore `AGENT_MODEL` is **per-dispatch data and MUST travel in the `/start` body**, joining
   `TITLE`/`DESCRIPTION` — *not* in `ContainerEnv`. (See "Upstream clarification" below; the slice
   briefs loosely said "add `AGENT_MODEL` to `ContainerEnv`", which is the wrong channel.)

## Decision

**Resolve the model once, in the Durable Object, inside `startDispatch`, before building the
`/start` body; transport the single resolved value as a new `model` field on `containerBody`;
`entrypoint.sh` reads it as `AGENT_MODEL` and passes it to `claude --model`.**

### Resolution (pure function, lives in/near `AgentConfig` or a small `resolveModel` helper)

A single pure function decides the model and its provenance. Shape (contract, not implementation):

```
resolveModel(ticketModel: string | undefined, defaultModel: string)
  -> { model: string; source: "ticket" | "AGENT_MODEL_DEFAULT" | "hardcoded-default" }
```

- `ticketModel` present, non-blank, **and on the allow-list** → `{ model: ticketModel, source: "ticket" }`
- `ticketModel` present but **unknown** (fails the allow-list, ADR-003) → fall back to `defaultModel`, log a rejection
- `ticketModel` absent/blank → use `defaultModel`
- `defaultModel` is `AgentConfig.agentModelDefault`, which is `env.AGENT_MODEL_DEFAULT ?? HARDCODED_CLAUDE_DEFAULT`

So `source` distinguishes `AGENT_MODEL_DEFAULT` from `hardcoded-default` by whether the secret was set.
The hardcoded Claude default is a **single named constant** in `AgentConfig` (no scattered magic strings —
shared-artifacts hardcoded-value audit). The resolved `{model, source}` is what `entrypoint.sh` logs as
`[step] model-resolved source=<source> model=<model>`.

### Why the DO (not the container)

The DO already owns the dispatch decision, reads the work item over MCP (`getItem`,
`src/mcp-client.ts:124`), and builds `containerBody`. Resolving in the DO means:
- The allow-list (ADR-003) lives **before** the container command line — an unvalidated externally
  influenced string never reaches `claude --model` (the injection / cost-blowout guard).
- The container stays a dumb executor: it receives one already-decided `AGENT_MODEL` string.
- The resolved model is provably the single value the container runs — the same `agent_model`
  appears consistently from resolution through to the container invocation and the cost tag.

### Passing `--model`

`entrypoint.sh` builds the model flag conditionally so that an **empty/unset** `AGENT_MODEL`
preserves today's exact behavior (Claude Code's own default, no `--model`):

- `AGENT_MODEL` non-empty → `claude --model "$AGENT_MODEL" --dangerously-skip-permissions -p "…"`
- `AGENT_MODEL` empty → `claude --dangerously-skip-permissions -p "…"` (current behavior, zero regression)

Because the hardcoded floor is a real Claude model id, the resolved value is normally non-empty;
the empty branch is a defensive belt-and-suspenders for the floor-misconfiguration edge.

## Alternatives Considered

| Decision point | Option | Evaluation | Verdict |
|----------------|--------|------------|---------|
| **Where to resolve** | In the DO before `/start` (chosen) | Allow-list runs before the command line; container stays dumb; single source of the resolved model | **CHOSEN** |
| | In the container (`entrypoint.sh` reads ticket + default envs and decides) | Pushes the security-critical allow-list into bash, downstream of the trust boundary; an unvalidated string would already be on the box; harder to unit-test | Rejected |
| **Transport channel** | `/start` body `model` field (chosen) | Correct lifetime: per-dispatch value via the per-dispatch channel; sits beside `TITLE`/`DESCRIPTION` | **CHOSEN** |
| | `ContainerEnv.AGENT_MODEL` | Wrong lifetime: `ContainerEnv` is a per-DO-instance constant set at construction; conflates a per-dispatch value with constants like `ANTHROPIC_API_KEY`. | Rejected |
| **Default storage** | `AgentConfig.agentModelDefault` via `env.AGENT_MODEL_DEFAULT ?? CLAUDE` (chosen) | Reuses the existing typed-default pattern; one-line prod change; revert = unset secret | **CHOSEN** |
| | New standalone config module | Unjustified new component; `AgentConfig` is exactly this layer | Rejected |

## Consequences

**Positive**
- Operator swaps the fleet default with one secret, no code change; revert = unset it.
- Precedence holds deterministically and is logged per dispatch (`source=…`), making the resolved model auditable.
- `entrypoint.sh`'s empty-`AGENT_MODEL` branch guarantees **zero behavior change** when nothing is configured (an unset default falls back to the hardcoded Claude floor).
- Resolution is a pure function → trivially unit-testable in isolation (testability quality attribute).

**Negative / Trade-offs**
- Adds one field to `containerBody` and a small resolve step in the hot path of `startDispatch`. Negligible cost; no new component.
- In Phase 1 the only harness is Claude Code, so `AGENT_MODEL` selects **which Claude model** (e.g. an Opus/Sonnet/Haiku cost tier), not an OSS model. This is intentional and already delivers cost control (a cheaper Claude tier) before any OSS model arrives in Phase 2. The same seam carries an OSS `provider/model` id unchanged in Phase 2 — no rework. This must be documented so operators understand what `AGENT_MODEL_DEFAULT` accepts in Phase 1 (Claude model ids only; the allow-list, ADR-003, encodes this).
- A model id whose **provider credential is missing** (e.g. a future non-Claude id set before its key exists) must fail fast with a clear error rather than silently bill Claude. In Phase 1 the only credential is `ANTHROPIC_API_KEY` and the allow-list only admits Claude ids, so this edge is naturally guarded; the fail-fast behavior is owned by Claude Code's own error on an unusable model id and surfaces as a normal dispatch failure → existing sweeper/rescue terminal handling.

## Fail-Safe Invariant (ties to the orphan-sweeper guarantee)

A bad or unresolvable model value must **never strand a dispatch**. Resolution always yields a
usable string (the floor is always valid), and any downstream failure (e.g. Claude Code rejects an
id) exits the container non-zero → the existing `monitorDispatch` failed-case
(`src/agent-loop.ts:356-362`) + sweeper/rescue reaches a terminal state. No new control flow.
Phase 2's *model-aware* re-dispatch-on-Claude extends this same path — explicitly out of
scope here, noted only as a forward extension point.
