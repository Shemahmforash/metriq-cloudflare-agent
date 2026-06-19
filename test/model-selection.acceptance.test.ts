/**
 * Acceptance tests — model selection, Phase 1 (model default, ticket override,
 * AI Gateway cost attribution).
 *
 * These are the OUTER LOOP of Outside-In TDD: they describe observable operator
 * outcomes and drive the real Worker/DO logic through its real entry protocol
 * (the DO fetch /wake → alarm poll → /start). Harness selection / auto-escalation
 * is OUT of scope here (see harness-selection.acceptance.test.ts).
 *
 * Test strategy: the real DO orchestration runs in the
 * @cloudflare/vitest-pool-workers in-process runtime; the costly externals are
 * faked — the container subprocess (`/start` + `/status` via the DO's test
 * hooks), the Cloudflare AI Gateway, and the Metriq MCP server (fetchMock).
 * A real `claude`/gateway path, if any, is a single contract smoke skipped by
 * default.
 *
 * The resolved per-dispatch model travels in the POST /start BODY (beside
 * TITLE/DESCRIPTION); the constant ANTHROPIC_BASE_URL stays in ContainerEnv
 * (see ADR-002). Tests assert exactly this split.
 *
 * Observable acceptance signal: the resolved { model, source } that the DO
 * forwards in the /start body — the same value the container logs as
 * `[step] model-resolved source=<source> model=<model>`.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fetchMock, runInDurableObject } from "cloudflare:test";

import {
  type CapturedCall,
  queueOk,
} from "./mcp-test-helpers";
import { preContainerQueue } from "./mcp-fixtures";
import {
  resolveModel,
  buildCostAttributionTags,
  type ModelSource,
} from "../src/resolve-model";
import { buildContainerEnvVars } from "../src/agent-container";
// Shared DO harness (extracted to test/do-harness.ts so Phase 1 + Phase 2
// acceptance suites share ONE copy of the alarm-clearing / isolated-storage-safe
// driving logic — the fix for the CI UND_MOCK_ERR / "Isolated storage failed"
// flake). Behavior identical to the previously-inlined helpers.
import {
  agentStub,
  cleanupTestState,
  drive,
  installContainerHooks,
} from "./do-harness";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    AGENT_LOOP: DurableObjectNamespace;
    AGENT_CONTAINER: DurableObjectNamespace;
    METRIQ_API_KEY: string;
    METRIQ_MCP_URL: string;
    RETRY_DELAY_MS: string;
    GITHUB_PAT: string;
    GITHUB_USER: string;
    ANTHROPIC_API_KEY: string;
    ALERT_GITHUB_REPO: string;
  }
}

// The DO test harness (agentStub / installContainerHooks / drive /
// cleanupTestState + touchedStubs) lives in ./do-harness.ts and is imported
// above — shared verbatim with the Phase-2 acceptance suite so the
// alarm-clearing / isolated-storage-safe logic is defined once. `runInDurableObject`
// is still imported here for the per-test config overrides (testAgentModelDefault).

// =============================================================================
// End-to-end wiring test — exactly one.
// Real DO, faked MCP + faked container. Drives the DO's real entry
// protocol (fetch /wake → alarm poll), asserts the OBSERVABLE outcome (the model
// the container is told to run + dispatch reaches a terminal state), not an
// internal helper call.
// =============================================================================

describe("Operator model control — walking skeleton (US-01/US-02, journey S1+S2)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(cleanupTestState);

  // @walking_skeleton @real-io @driving_port  (US-02)
  // Real DO orchestration; faked MCP + faked container subprocess (@in-memory).
  it("dispatches a claimed ticket on the operator's resolved model and the dispatch reaches a terminal state [@walking_skeleton @real-io @driving_port US-02]", async () => {
    // GIVEN the agent already runs end-to-end with Claude as the default
    //   (AGENT_MODEL_DEFAULT unset ⇒ the hardcoded Claude default is the floor),
    //   and a Metriq ticket "Fix pagination on the orders list" is waiting.
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-ws",
        workItemId: "wi-ws",
        title: "Fix pagination on the orders list",
      }),
      { artifact_id: "a-ws", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);

    const stub = agentStub("model-ws");
    await installContainerHooks(stub, {
      start: async (_dispatchId, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/9001\n",
      }),
    });

    // WHEN the operator wakes the agent and it dispatches the next ticket.
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the container was told which model to run, carried in the /start body
    //   (per-dispatch channel, UC-1) — and it equals the resolved default
    //   (hardcoded Claude floor, since AGENT_MODEL_DEFAULT is unset).
    expect(startBodies).toHaveLength(1);
    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.source).toBe("hardcoded-default");

    // AND the dispatch reached a terminal state (no-strand invariant): the PR
    //   was reported and the ticket moved to done.
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
    expect(names[names.length - 1]).toBe("move_item");
    const finalMove = JSON.parse(calls[calls.length - 1]!.body).params.arguments;
    expect(finalMove.toState).toBe("done");
    // No inline cleanup here: this assertion block is RED by design, so any
    // teardown after it would be skipped. afterEach(cleanupTestState) wipes the
    // DO storage + alarm unconditionally.
  });
});

// =============================================================================
// SLICE B — default transport (US-02). One-at-a-time: it.todo / it.skip.
// =============================================================================

describe("Slice B — operator default model transport (US-02, journey S2)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(cleanupTestState);

  // Operator sets AGENT_MODEL_DEFAULT; dispatch runs it.
  // The configured default is supplied via the DO test-config override
  // (testAgentModelDefault, mirroring testDailyCap); assert startBody.model ==
  // that value and source=AGENT_MODEL_DEFAULT.
  it("runs a dispatch on the operator-configured default and forwards it in the /start body, source=AGENT_MODEL_DEFAULT [@driving_port US-02]", async () => {
    // GIVEN the operator configured an allow-listed fleet default via
    //   AGENT_MODEL_DEFAULT, and a Metriq ticket is waiting (no per-ticket model).
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-def",
        workItemId: "wi-def",
        title: "Tune the search relevance ranker",
      }),
      { artifact_id: "a-def", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);

    const stub = agentStub("model-default");
    await installContainerHooks(stub, {
      start: async (_dispatchId, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/9002\n",
      }),
    });
    // Operator-configured default (mirrors testDailyCap; production sets it via
    // the AGENT_MODEL_DEFAULT secret, never this field).
    await runInDurableObject(stub, async (instance) => {
      (instance as { testAgentModelDefault?: string }).testAgentModelDefault =
        "anthropic/claude-sonnet-4";
    });

    // WHEN the operator wakes the agent and it dispatches the next ticket.
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the container is told to run the operator's configured default,
    //   carried in the /start body with source=AGENT_MODEL_DEFAULT.
    expect(startBodies).toHaveLength(1);
    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/claude-sonnet-4");
    expect(startBody.source).toBe("AGENT_MODEL_DEFAULT");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });

  // @driving_port (US-02) — unset default ⇒ hardcoded Claude floor, no regression.
  // The explicit US-02 traceability anchor for the unset-default case (an
  // isolated example distinct from the WS): no testAgentModelDefault override,
  // so the DO falls through to the hardcoded Claude floor.
  it("falls back to the hardcoded Claude default when AGENT_MODEL_DEFAULT is unset, source=hardcoded-default [@driving_port US-02]", async () => {
    // GIVEN AGENT_MODEL_DEFAULT is unset (no override) and a ticket is waiting.
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-floor",
        workItemId: "wi-floor",
        title: "Backfill the audit log index",
      }),
      { artifact_id: "a-floor", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);

    const stub = agentStub("model-floor");
    await installContainerHooks(stub, {
      start: async (_dispatchId, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/9003\n",
      }),
    });

    // WHEN the operator wakes the agent and it dispatches the next ticket.
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the container falls back to the hardcoded Claude floor (zero
    //   regression to today's behavior), source=hardcoded-default.
    expect(startBodies).toHaveLength(1);
    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.source).toBe("hardcoded-default");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });

  // @property (US-02) — resolveModel is pure: same inputs → same output, no I/O.
  // This is the Mandate-4 pure-function tier (CM-D). RED via the throwing scaffold.
  it("resolves the same model for the same inputs every time (pure, no I/O) [@property US-02]", () => {
    const args = {
      ticketModel: undefined,
      defaultModel: "anthropic/claude-opus-4",
      defaultIsFromSecret: true,
      allowList: ["anthropic/claude-opus-4"] as const,
    };
    const first = resolveModel(args);
    const second = resolveModel(args);
    expect(first).toEqual(second);
    expect(first.model).toBe("anthropic/claude-opus-4");
    expect(first.source).toBe<ModelSource>("AGENT_MODEL_DEFAULT");
  });
});

// =============================================================================
// SLICE C — ticket override + precedence + fail-safe (US-03). One-at-a-time.
// Precedence ladder: ticket > AGENT_MODEL_DEFAULT > hardcoded Claude.
// =============================================================================

describe("Slice C — per-ticket model override (US-03, journey S3)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(cleanupTestState);

  // @driving_port (US-03) — happy path: allow-listed ticket model overrides default.
  it("dispatches a ticket on its own allow-listed model, overriding the operator default, source=ticket [@driving_port US-03]", async () => {
    // GIVEN Marco set an allow-listed model on the work item.
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-tk",
        workItemId: "wi-3088",
        title: "Refactor the billing reconciliation engine",
        ticketModel: "anthropic/claude-opus-4.7",
      }),
      { artifact_id: "a-tk", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("model-ticket-ok");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/3088\n",
      }),
    });

    // WHEN the ticket is dispatched.
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the container runs the ticket's model (precedence level 1).
    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/claude-opus-4.7");
    expect(startBody.source).toBe("ticket");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });

  // @driving_port (US-03) [ERROR PATH] — unknown/malformed ticket model rejected,
  // falls back to a safe default, dispatch STILL proceeds (no-strand invariant),
  // and the rejected string never appears in the /start body.
  it("rejects an unknown ticket model, falls back to the safe default, logs the rejection, and never strands the dispatch [@driving_port US-03 error-path]", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    const warnSpy = vi.spyOn(console, "warn");
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-bad",
        workItemId: "wi-3089",
        title: "Add rate-limit headers",
        ticketModel: "totally-not-a-real-model; rm -rf /",
      }),
      { artifact_id: "a-bad", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("model-ticket-bad");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/3089\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    // Fell back to a known-good default (NOT the garbage value).
    expect(startBody.model).not.toContain("totally-not-a-real-model");
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.source).not.toBe("ticket");
    // The unvalidated string never reached the per-dispatch command channel.
    expect(startBodies[0]).not.toContain("rm -rf");
    // Rejection was logged.
    expect(
      warnSpy.mock.calls.flat().some((m) => String(m).includes("unknown model")),
    ).toBe(true);
    // No-strand: the dispatch still finalized (terminal state reached).
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
    // warnSpy restore + DO cleanup are unconditional in afterEach(cleanupTestState).
  });

  // @driving_port (US-03) [ERROR PATH] — absent `model` field (cross-system: Metriq
  // may not expose it yet) ⇒ default used, no error (graceful degradation).
  it("uses the default with no error when the ticket has no model field at all [@driving_port US-03 error-path]", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      // No `ticketModel` ⇒ the payload has no `model` field (real absent shape).
      ...preContainerQueue({
        dispatchId: "d-absent",
        workItemId: "wi-3071",
        title: "Tidy the changelog",
      }),
      { artifact_id: "a-absent", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("model-ticket-absent");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/3071\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.source).not.toBe("ticket");
    // The dispatch completed normally — no error path taken.
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });

  // @driving_port (US-03) [ERROR PATH] — blank/whitespace model treated as absent.
  it("treats a blank ticket model as absent and falls through to the default with no error [@driving_port US-03 error-path]", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      // Blank/whitespace `ticketModel` ⇒ resolveModel trims it to absent.
      ...preContainerQueue({
        dispatchId: "d-blank",
        workItemId: "wi-3072",
        title: "Bump the lockfile",
        ticketModel: "   ",
      }),
      { artifact_id: "a-blank", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("model-ticket-blank");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/3072\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.source).not.toBe("ticket");
    // The dispatch completed normally — no error path taken.
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });

  // [ERROR PATH] pure-function tier — malformed MCP payload shape around `model`
  // resolves to a safe default and never throws (defensive). RED via scaffold.
  it("resolves a safe default and does not throw when the ticket model is absent/blank/unknown [@property US-03 error-path]", () => {
    const allowList = ["anthropic/claude-opus-4"] as const;
    const cases: Array<string | undefined> = [
      undefined,
      "",
      "   ",
      "not-on-the-list",
    ];
    for (const ticketModel of cases) {
      const r = resolveModel({
        ticketModel,
        defaultModel: "anthropic/claude-opus-4",
        defaultIsFromSecret: false,
        allowList,
      });
      expect(r.model).toBe("anthropic/claude-opus-4");
      expect(r.source).not.toBe<ModelSource>("ticket");
    }
  });

  // @property (US-03) — precedence ladder holds for any input combination.
  it("honors precedence ticket > AGENT_MODEL_DEFAULT > hardcoded for any input [@property US-03]", () => {
    const allowList = [
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.7",
    ] as const;
    // ticket wins when allow-listed
    expect(
      resolveModel({
        ticketModel: "anthropic/claude-opus-4.7",
        defaultModel: "anthropic/claude-opus-4",
        defaultIsFromSecret: true,
        allowList,
      }),
    ).toEqual({ model: "anthropic/claude-opus-4.7", source: "ticket" });
    // default wins when no ticket, secret set
    expect(
      resolveModel({
        ticketModel: undefined,
        defaultModel: "anthropic/claude-opus-4",
        defaultIsFromSecret: true,
        allowList,
      }),
    ).toEqual({ model: "anthropic/claude-opus-4", source: "AGENT_MODEL_DEFAULT" });
    // hardcoded floor wins when no ticket, no secret
    expect(
      resolveModel({
        ticketModel: undefined,
        defaultModel: "anthropic/claude-opus-4",
        defaultIsFromSecret: false,
        allowList,
      }),
    ).toEqual({ model: "anthropic/claude-opus-4", source: "hardcoded-default" });
  });
});

// =============================================================================
// SLICE A — AI Gateway interposition + per-PR cost attribution (US-01, KPI-1).
// =============================================================================

describe("Slice A — AI Gateway cost visibility (US-01, journey S1)", () => {
  afterEach(cleanupTestState);

  // @real-io — pure constant-env builder; no external I/O. (Slice A surface.)
  // ANTHROPIC_BASE_URL is the CONSTANT channel (ContainerEnv), NOT the /start body.
  it("forwards the AI Gateway endpoint as the constant ANTHROPIC_BASE_URL into the container [@real-io US-01]", () => {
    const vars = buildContainerEnvVars({
      GITHUB_PAT: "pat",
      GITHUB_USER: "agent",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL:
        "https://gateway.ai.cloudflare.com/v1/acct/metriq-agent/anthropic",
    });
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/metriq-agent/anthropic",
    );
    // The existing credential constants are still forwarded unchanged.
    expect(vars.ANTHROPIC_API_KEY).toBe("key");
    expect(vars.GITHUB_PAT).toBe("pat");
  });

  // [ERROR/EDGE PATH] AI_GATEWAY_TOKEN set ⇒ forwarded; unset ⇒ omitted (no
  // broken/empty header). Membership of the key, not an empty string, is the
  // signal entrypoint.sh uses to add cf-aig-authorization.
  it("forwards AI_GATEWAY_TOKEN when set and omits it entirely when unset [@real-io US-01 error-path]", () => {
    const withToken = buildContainerEnvVars({
      GITHUB_PAT: "pat",
      GITHUB_USER: "agent",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      AI_GATEWAY_TOKEN: "tok-123",
    });
    expect(withToken.AI_GATEWAY_TOKEN).toBe("tok-123");

    const withoutToken = buildContainerEnvVars({
      GITHUB_PAT: "pat",
      GITHUB_USER: "agent",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
    });
    // Unset ⇒ the key is absent (not present-but-empty), so no broken header.
    expect("AI_GATEWAY_TOKEN" in withoutToken).toBe(false);
  });

  // Task 3 (open-source-readiness): TARGET_REPO / TARGET_BASE_BRANCH are
  // deploy-time constants forwarded into the container so the agent can clone +
  // open PRs against any repo. TARGET_REPO is required at the container boundary
  // (entrypoint.sh fails fast when empty); TARGET_BASE_BRANCH defaults to "main".
  it("forwards TARGET_REPO and TARGET_BASE_BRANCH when set [@real-io]", () => {
    const vars = buildContainerEnvVars({
      GITHUB_PAT: "p",
      GITHUB_USER: "u",
      ANTHROPIC_API_KEY: "k",
      TARGET_REPO: "acme/widgets",
      TARGET_BASE_BRANCH: "main",
    });
    expect(vars.TARGET_REPO).toBe("acme/widgets");
    expect(vars.TARGET_BASE_BRANCH).toBe("main");
  });

  // @kpi (US-01, KPI-1) — every cost-tagged dispatch carries the attribution
  // tags populated from DO-minted / allow-listed values, so per-PR cost is
  // queryable. ADR-007 (Phase 2) EXTENDS the Phase-1 schema: it adds the
  // DO-minted `harness` + `fallback_of` dimensions and bumps `phase` 1→2. This
  // Phase-1 assertion is updated to the evolved schema (ADR-007 "Phase-1 tests
  // update"). Also the ADR-004 injection guard: no external free text.
  it("emits cost-attribution tags with all DO-minted dimensions (incl. harness + fallback_of, phase 2) so per-PR cost is attributable [@kpi US-01 KPI-1]", () => {
    const tags = buildCostAttributionTags({
      dispatchId: "f3a9c2de-0000-0000-0000-000000000000",
      workItemId: "WI-3088",
      shortId: "f3a9c2de",
      resolved: { model: "anthropic/claude-opus-4", source: "ticket" },
      harness: "claude",
    });
    expect(tags).toEqual({
      dispatch_id: "f3a9c2de-0000-0000-0000-000000000000",
      work_item_id: "WI-3088",
      short_id: "f3a9c2de",
      model: "anthropic/claude-opus-4",
      source: "ticket",
      harness: "claude",
      fallback_of: null,
      phase: "2",
    });
  });

  // @kpi (US-01) [INJECTION GUARD] — no external free-text (ticket title/body)
  // can leak into the cost tags; every value is a DO-minted/allow-listed token.
  // ADR-007 (Phase 2): the schema is now eight fixed fields (still no title/body).
  it("never places external free-text in the cost tags (injection guard) [@kpi US-01 error-path]", () => {
    const tags = buildCostAttributionTags({
      dispatchId: "abc",
      workItemId: "WI-1",
      shortId: "abc",
      resolved: { model: "anthropic/claude-opus-4", source: "hardcoded-default" },
      harness: "claude",
    });
    // The tag schema has exactly the eight fixed fields — no title/description.
    expect(Object.keys(tags).sort()).toEqual(
      [
        "dispatch_id",
        "fallback_of",
        "harness",
        "model",
        "phase",
        "short_id",
        "source",
        "work_item_id",
      ].sort(),
    );
  });

  // @kpi (US-01) [EDGE] — a rescued/retried ticket yields two request rows that
  // roll up to ONE ticket via work_item_id (US-01 Domain Example 2). Proven at
  // the DO level: each dispatch mints its own dispatch_id/short_id, but the
  // work_item_id in cost_tags is the STABLE claimed item id — so two retried
  // dispatches (distinct dispatch_id) for the same ticket collapse onto one
  // work_item_id, and per-PR cost is not double-counted.
  it("rolls retried dispatches up to one ticket via work_item_id so per-PR cost is not double-counted [@kpi US-01 edge]", async () => {
    // A retried ticket yields TWO dispatches (e.g. the first was reclaimed by
    // the sweeper, a second DO picked it up) — distinct dispatch_id each, but
    // the SAME work_item_id. Model that with two independent DO instances, each
    // claiming the same ticket "wi-rollup" under its own dispatch id.
    const startBodyByDispatch: Record<string, string> = {};

    async function dispatchOnce(
      doName: string,
      dispatchId: string,
    ): Promise<void> {
      fetchMock.activate();
      fetchMock.disableNetConnect();
      const calls: CapturedCall[] = [];
      queueOk(calls, [
        ...preContainerQueue({
          dispatchId,
          workItemId: "wi-rollup",
          title: "Stabilize the flaky export job",
        }),
        { artifact_id: `a-${dispatchId}`, posted_at: "2026-05-28T09:00:00.000Z" },
        { error: null, blessingRequested: true },
      ]);
      const stub = agentStub(doName);
      await installContainerHooks(stub, {
        start: async (_d, body) => {
          startBodyByDispatch[dispatchId] = body;
          return { status: 202 };
        },
        status: async () => ({
          status: "done",
          stdoutTail: "https://github.com/example/target-repo/pull/9100\n",
        }),
      });
      await stub.fetch("http://do/wake", { method: "POST" });
      await drive(stub);
      fetchMock.deactivate();
    }

    await dispatchOnce("model-rollup-a", "d-first-attempt");
    await dispatchOnce("model-rollup-b", "d-second-attempt");

    // Two request rows (two dispatches), distinct dispatch ids and short ids…
    const first = JSON.parse(startBodyByDispatch["d-first-attempt"]!);
    const second = JSON.parse(startBodyByDispatch["d-second-attempt"]!);
    expect(first.cost_tags.dispatch_id).toBe("d-first-attempt");
    expect(second.cost_tags.dispatch_id).toBe("d-second-attempt");
    expect(first.cost_tags.short_id).not.toBe(second.cost_tags.short_id);
    // …but BOTH roll up to the one ticket via the stable work_item_id, so
    // per-PR cost queries group them onto a single ticket (no double-count).
    expect(first.cost_tags.work_item_id).toBe("wi-rollup");
    expect(second.cost_tags.work_item_id).toBe("wi-rollup");
    // Cleanup is unconditional in afterEach(cleanupTestState).
  });
});

// =============================================================================
// CONTRACT SMOKE (real external) — skipped by default. Strategy-B escape hatch.
// =============================================================================

describe("AI Gateway / Claude contract smoke [@requires_external]", () => {
  // Asserts the real `claude` honors ANTHROPIC_BASE_URL / --model. Requires real
  // gateway + Anthropic creds + the container image — out of scope for the
  // workers pool. Lives in deployed e2e; recorded here as the Strategy-B
  // real-I/O escape hatch for the costly `claude -p` path.
  it.skip("real claude honors ANTHROPIC_BASE_URL and --model [@requires_external]", () => {
    // Intentionally unimplemented in the workers pool. See distill/walking-skeleton.md.
    expect(true).toBe(true);
  });
});
