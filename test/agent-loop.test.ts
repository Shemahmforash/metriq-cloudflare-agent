import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env, fetchMock, runInDurableObject } from "cloudflare:test";

import {
  asOk,
  type CapturedCall,
  jsonReply,
  queueOk,
  queueResponses,
} from "./mcp-test-helpers";
import { preContainerQueue } from "./mcp-fixtures";
import {
  assertNoLeftoverAlarm,
  clearAlarm,
  fireAlarm,
  noteAlarmArmed,
} from "./do-harness";
import type { ContainerStatus } from "../src/agent-loop";

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

// The dispatch now spans two alarm fires: an IDLE fire that starts the
// container (POST /start → 202) and one or more MONITORING fires that poll
// GET /status until the job is done/failed. Tests inject both legs.
type StartHook = (
  dispatchId: string,
  body: string,
) => Promise<{ status: number }>;
type StatusHook = (dispatchId: string) => Promise<ContainerStatus>;

async function installContainerHooks(
  stub: DurableObjectStub,
  hooks: { start?: StartHook; status?: StatusHook },
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const i = instance as {
      testContainerStart?: StartHook;
      testContainerStatus?: StatusHook;
    };
    if (hooks.start) i.testContainerStart = hooks.start;
    if (hooks.status) i.testContainerStatus = hooks.status;
  });
}

// Convenience: container starts (202) and reports done with the given PR URL
// on its first status poll.
function okContainerHooks(prUrl = "https://example.com/fake-pr\n"): {
  start: StartHook;
  status: StatusHook;
} {
  return {
    start: async () => ({ status: 202 }),
    status: async () => ({ status: "done", stdoutTail: prUrl }),
  };
}

/**
 * Drive the alarm state machine to a resting state: fire the IDLE alarm (which
 * may start a dispatch), then keep firing the re-armed MONITORING alarm until
 * `currentDispatch` clears. Mirrors how the runtime re-fires the re-armed alarm
 * in production, minus the wall-clock delay.
 *
 * NOTE: this intentionally does NOT clear the re-armed alarm — several tests
 * assert that the alarm IS re-armed after a terminal failure (sweeper-reclaim
 * proof). The live alarm is instead cleared UNCONDITIONALLY in afterEach (see
 * sweepLeftoverAlarms) so no DO-driving test leaves a real-time alarm that fires
 * ~1s later into the next test/file — the CI UND_MOCK_ERR / "Isolated storage
 * failed" flake. Every stub a test creates is recorded in `seenStubs`.
 */
async function drive(stub: DurableObjectStub, maxFires = 12): Promise<void> {
  await fireAlarm(stub);
  for (let i = 0; i < maxFires; i++) {
    const monitoring = await runInDurableObject(
      stub,
      async (_i, state) =>
        (await state.storage.get("currentDispatch")) !== undefined,
    );
    if (!monitoring) return;
    await fireAlarm(stub);
  }
}

async function disarm(stub: DurableObjectStub): Promise<void> {
  await clearAlarm(stub);
}

/**
 * Every DO stub a test materializes. afterEach(sweepLeftoverAlarms) clears any
 * live alarm on each so a re-armed real-time poll alarm cannot fire into the
 * next test/file (the isolation flake). Assertions on alarm state already ran by
 * then (afterEach is post-test), so this does not affect any test's expectations.
 */
const seenStubs = new Set<DurableObjectStub>();

/** Unconditional post-test alarm sweep (the live-alarm-leak backstop). */
async function sweepLeftoverAlarms(): Promise<void> {
  for (const stub of seenStubs) {
    try {
      await runInDurableObject(stub, async (_i, state) => {
        await state.storage.deleteAlarm();
      });
    } catch {
      // best-effort: a stub that never materialized has nothing to clear.
    }
  }
  seenStubs.clear();
  // PERMANENT guard: trip deterministically if any driven DO left a live
  // real-time alarm (the CI isolation flake). Runs after the sweep above so the
  // wipe can't mask the discipline check (which is runtime-timing-independent).
  assertNoLeftoverAlarm();
}

// File-wide backstop: after EVERY test (any describe), clear leftover alarms on
// every stub the test materialized. Top-level afterEach runs post-assertions, so
// it never disturbs a test's alarm-state expectations — it only prevents a
// re-armed real-time poll alarm from firing into a sibling test/file.
afterEach(sweepLeftoverAlarms);

describe("MetriqAgentLoop cold start", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("calls register_agent_session once on first /wake and persists session_id", async () => {
    const calls: CapturedCall[] = [];
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ session_id: "sess-abc" }) },
              ],
            },
          }),
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
        };
      });

    const id = env.AGENT_LOOP.idFromName("singleton");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);

    const res = await stub.fetch("http://do/wake", { method: "POST" });
    expect(res.status).toBe(202);

    // Disarm BEFORE inspecting state to keep the runtime from auto-firing the
    // alarm scheduled for Date.now() and racing test teardown.
    await disarm(stub);

    // Inspect persisted state.
    await runInDurableObject(stub, async (_instance, state) => {
      const sessionId = await state.storage.get<string>("sessionId");
      expect(sessionId).toBe("sess-abc");
    });

    // Verify exactly one register call landed.
    const registerCalls = calls.filter((c) => c.body.includes("register_agent_session"));
    expect(registerCalls).toHaveLength(1);
  });
});

describe("MetriqAgentLoop alarm — long-poll loop", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    logSpy = vi.spyOn(console, "log");
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("/wake schedules an alarm and the first fire long-polls + re-arms", async () => {
    const calls: CapturedCall[] = [];

    // First request: register
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify({ session_id: "s-1" }) }],
            },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    // Second request: wait_for_assignment (null)
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              content: [{ type: "text", text: JSON.stringify({ dispatch_id: null }) }],
            },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const id = env.AGENT_LOOP.idFromName("singleton");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);

    await stub.fetch("http://do/wake", { method: "POST" });

    // After /wake, an alarm must be scheduled (returns a timestamp).
    let scheduledBefore: number | null = null;
    await runInDurableObject(stub, async (_i, state) => {
      scheduledBefore = await state.storage.getAlarm();
    });
    expect(scheduledBefore).not.toBeNull();

    // Fire the alarm synchronously (fireAlarm records the re-armed alarm so the
    // leftover-alarm guard can see it must be cleared in-test).
    const ran = await fireAlarm(stub);
    expect(ran).toBe(true);

    // The alarm body should have logged "polled, nothing." and re-armed.
    const messages = logSpy.mock.calls.map((c) => c[0]);
    expect(messages).toContain("polled, nothing.");

    let scheduledAfter: number | null = null;
    await runInDurableObject(stub, async (_i, state) => {
      scheduledAfter = await state.storage.getAlarm();
    });
    expect(scheduledAfter).not.toBeNull();
    // Cancel the re-armed alarm so it doesn't race teardown (marks cleared).
    await clearAlarm(stub);

    // wait_for_assignment was called with the persisted session_id.
    const waitCalls = calls.filter((c) => c.body.includes("wait_for_assignment"));
    expect(waitCalls).toHaveLength(1);
    const waitBody = JSON.parse(waitCalls[0]!.body);
    expect(waitBody.params.arguments).toEqual({
      timeout_seconds: 25,
      agent_session_id: "s-1",
    });
  });
});

describe("MetriqAgentLoop dispatch happy path (container)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("on a hit, starts the container, polls status, parses URL from done output, reports it, moves to done", async () => {
    const calls: CapturedCall[] = [];
    const startCalls: string[] = [];
    let statusPolls = 0;
    const queue: Array<{ name: string; payload: unknown }> = [
      { name: "register_agent_session", payload: { session_id: "s-1" } },
      {
        name: "wait_for_assignment",
        payload: {
          dispatch_id: "d-1",
          work_item_id: "wi-1",
          payload: { title: "Hello slice 3", description: "demo" },
        },
      },
      { name: "claim_assigned_task", payload: { ok: true, work_item_id: "wi-1" } },
      {
        name: "get_item",
        payload: { id: "wi-1", title: "Hello slice 3", currentState: "ready" },
      },
      { name: "move_item", payload: { error: null } },
      {
        name: "report_artifact",
        payload: { artifact_id: "art-1", posted_at: "2026-05-17T11:00:00.000Z" },
      },
      { name: "move_item", payload: { error: null, blessingRequested: true } },
    ];
    for (let i = 0; i < queue.length; i++) {
      const expected = queue[i]!;
      fetchMock
        .get("https://example.test")
        .intercept({ path: "/api/v1/mcp", method: "POST" })
        .reply((opts) => {
          calls.push({
            body: String(opts.body),
            headers:
              opts.headers instanceof Headers
                ? Object.fromEntries(opts.headers.entries())
                : (opts.headers as Record<string, string>),
          });
          return {
            statusCode: 200,
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: i + 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(expected.payload) }],
              },
            }),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        });
    }

    const id = env.AGENT_LOOP.idFromName("dispatch-happy");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async (_dispatchId, body) => {
        startCalls.push(body);
        return { status: 202 };
      },
      status: async () => {
        statusPolls += 1;
        return { status: "done", stdoutTail: "https://example.com/fake-pr\n" };
      },
    });
    await stub.fetch("http://do/wake", { method: "POST" });

    await drive(stub);

    // Container was started once with the dispatch context, then polled.
    expect(startCalls).toHaveLength(1);
    expect(statusPolls).toBeGreaterThanOrEqual(1);
    const ctxBody = JSON.parse(startCalls[0]!);
    expect(ctxBody).toMatchObject({
      work_item_id: "wi-1",
      dispatch_id: "d-1",
      title: "Hello slice 3",
      short_id: "d-1".slice(0, 8),
    });

    // Seven MCP calls across the two fires — IDLE: claim + get_item +
    // move(→in_progress); MONITORING: report + move(→done).
    expect(calls).toHaveLength(7);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
      "report_artifact",
      "move_item",
    ]);
    const firstMoveArgs = JSON.parse(calls[4]!.body).params.arguments;
    expect(firstMoveArgs).toEqual({
      itemId: "wi-1",
      fromState: "ready",
      toState: "in_progress",
    });
    const reportArgs = JSON.parse(calls[5]!.body).params.arguments;
    expect(reportArgs).toEqual({
      itemId: "wi-1",
      url: "https://example.com/fake-pr",
      kind: "pr",
      title: "Hello slice 3",
    });
    const finalMoveArgs = JSON.parse(calls[6]!.body).params.arguments;
    expect(finalMoveArgs).toEqual({
      itemId: "wi-1",
      fromState: "in_progress",
      toState: "done",
    });

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await clearAlarm(stub);
  });
});

describe("MetriqAgentLoop dispatch drop + retry", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it.each(["lost_race", "superseded"] as const)(
    "drops the dispatch on claim %s and re-arms without report/move",
    async (reason) => {
      const calls: CapturedCall[] = [];
      queueResponses(
        calls,
        asOk(
          preContainerQueue({
            title: "t",
            through: "claimed",
            claim: { ok: false, reason },
          }),
        ),
      );

      const id = env.AGENT_LOOP.idFromName(`drop-${reason}`);
      const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
      // Container hooks installed defensively; drop tests should never hit them.
      await installContainerHooks(stub, okContainerHooks());
      await stub.fetch("http://do/wake", { method: "POST" });
      await drive(stub);

      // Exactly 3 calls: register + wait + claim. No report/move.
      expect(calls).toHaveLength(3);
      const names = calls.map((c) => JSON.parse(c.body).params.name);
      expect(names).toEqual([
        "register_agent_session",
        "wait_for_assignment",
        "claim_assigned_task",
      ]);

      await runInDurableObject(stub, async (_i, state) => {
        expect(await state.storage.get("currentDispatch")).toBeUndefined();
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
      await clearAlarm(stub);
    },
  );

  it("retries report_artifact once on transient failure, then continues to move", async () => {
    const calls: CapturedCall[] = [];
    queueResponses(calls, [
      ...asOk(preContainerQueue({ title: "retry-test" })),
      { kind: "http", statusCode: 503, body: "service unavailable" },
      ...asOk([
        { artifact_id: "art-1", posted_at: "2026-05-17T11:00:00.000Z" },
        { error: null, blessingRequested: true },
      ]),
    ]);

    const id = env.AGENT_LOOP.idFromName("retry-once");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, okContainerHooks());
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // 8 calls: register, wait, claim, get_item, move(→in_progress), report (503), report (ok), move(→done)
    expect(calls).toHaveLength(8);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
      "report_artifact",
      "report_artifact",
      "move_item",
    ]);

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
    });
    await clearAlarm(stub);
  });

  it("bails on second report_artifact failure: rescue path fires (comment + GH issue), currentDispatch cleared, alarm re-armed", async () => {
    const calls: CapturedCall[] = [];
    queueResponses(calls, [
      ...asOk(preContainerQueue({ title: "double-fail" })),
      { kind: "http", statusCode: 503, body: "fail-1" },
      { kind: "http", statusCode: 503, body: "fail-2" },
      // 8th MCP call: the rescue path's post_agent_comment fallback.
      ...asOk([{ ok: true }]),
    ]);

    // Rescue also files a GitHub Issue — mock search + create.
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: (p) => p.startsWith("/search/issues"), method: "GET" })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({ total_count: 0, items: [] }),
        responseOptions: { headers: { "content-type": "application/json" } },
      }));
    fetchMock
      .get("https://api.github.com")
      .intercept({
        path: "/repos/TestOwner/test-repo/issues",
        method: "POST",
      })
      .reply(() => ({
        statusCode: 201,
        data: JSON.stringify({
          html_url: "https://github.com/TestOwner/test-repo/issues/77",
        }),
        responseOptions: { headers: { "content-type": "application/json" } },
      }));

    const id = env.AGENT_LOOP.idFromName("retry-bail");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, okContainerHooks());
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // 8 MCP calls: register, wait, claim, get_item, move(→in_progress),
    // report (fail), report (fail), post_agent_comment (rescue fallback).
    expect(calls).toHaveLength(8);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
      "report_artifact",
      "report_artifact",
      "post_agent_comment",
    ]);
    // Rescue comment references the PR URL.
    const commentArgs = JSON.parse(calls[7]!.body).params.arguments;
    expect(commentArgs.itemId).toBe("wi-1");
    expect(commentArgs.note).toContain("https://example.com/fake-pr");

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await clearAlarm(stub);
  });
});

describe("MetriqAgentLoop container failure modes", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("container reports failed status → no report, no move, currentDispatch cleared, alarm re-armed (sweeper reclaims)", async () => {
    const calls: CapturedCall[] = [];
    queueOk(calls, preContainerQueue({ title: "failed-status" }));

    const id = env.AGENT_LOOP.idFromName("container-failed");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({
        status: "failed",
        code: 1,
        bodyTail: "internal error\n",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    expect(calls).toHaveLength(5);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
    ]);

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await clearAlarm(stub);
  });

  it("watchdog: dispatch exceeds max wall-clock while still running → abandoned, no report/move, sweeper reclaims", async () => {
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-wc",
        workItemId: "wi-wc",
        title: "wall-clock",
      }),
    );

    const id = env.AGENT_LOOP.idFromName("container-wallclock");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    // Container starts fine but never finishes — status stays "running".
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({ status: "running" }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });

    // IDLE fire: claim → move → start; currentDispatch stored with startedAt=now.
    await fireAlarm(stub);
    // Backdate startedAt so the next monitor poll trips the watchdog.
    await runInDurableObject(stub, async (_i, state) => {
      const cur = await state.storage.get<{ startedAt: number }>(
        "currentDispatch",
      );
      expect(cur).not.toBeUndefined();
      cur!.startedAt = 0;
      await state.storage.put("currentDispatch", cur);
    });
    // MONITORING fire: status still running, but now − startedAt > max → abandon.
    await fireAlarm(stub);

    // 5 calls before the watchdog abandons: reg, wait, claim, get_item, move(→in_progress).
    expect(calls).toHaveLength(5);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await clearAlarm(stub);
  });

  it("container fail-to-boot (hook throws) → no report/move, alarm re-armed with boot back-off (not normal POLL delay), and a GitHub Issue is filed", async () => {
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-boot",
        workItemId: "wi-boot",
        title: "boot-fail",
      }),
    );

    // Intercept BOTH the search call AND the issue-create call notifyFailure
    // makes. Search returns 0 hits → notifyFailure falls through to create.
    const githubCalls: CapturedCall[] = [];
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: (p) => p.startsWith("/search/issues"), method: "GET" })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({ total_count: 0, items: [] }),
        responseOptions: { headers: { "content-type": "application/json" } },
      }));
    fetchMock
      .get("https://api.github.com")
      .intercept({
        path: "/repos/TestOwner/test-repo/issues",
        method: "POST",
      })
      .reply((opts) => {
        githubCalls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 201,
          data: JSON.stringify({
            html_url: "https://github.com/TestOwner/test-repo/issues/42",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const id = env.AGENT_LOOP.idFromName("container-boot-fail");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => {
        throw new Error("boot failed: ENOSPC");
      },
    });
    await runInDurableObject(stub, async (instance) => {
      (
        instance as { testContainerBootBackoffMs?: number }
      ).testContainerBootBackoffMs = 200;
    });
    await stub.fetch("http://do/wake", { method: "POST" });

    const before = Date.now();
    await fireAlarm(stub);

    expect(calls).toHaveLength(5); // reg, wait, claim, get_item, move(→in_progress), then container throws

    // notifyFailure fired exactly one issue-create call (search returned 0).
    expect(githubCalls).toHaveLength(1);
    const issueBody = JSON.parse(githubCalls[0]!.body);
    expect(issueBody.title).toMatch(/container fail-to-boot/);
    // Title must embed the fingerprint so future repeats find this issue.
    expect(issueBody.title).toMatch(/\[fp:[0-9a-f]{12}\]/);
    expect(issueBody.body).toContain("d-boot");
    expect(issueBody.body).toContain("ENOSPC");
    expect(issueBody.labels).toContain("container-fail");
    expect(githubCalls[0]!.headers.authorization).toBe(
      "Bearer test-github-pat",
    );

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      // Boot back-off (200ms) is distinct from normal POLL_REARM_DELAY_MS (1000ms).
      // Alarm must be ~200ms ahead — much less than the normal 1s re-arm.
      expect(alarm! - before).toBeGreaterThanOrEqual(100);
      expect(alarm! - before).toBeLessThan(800);
    });
    await clearAlarm(stub);
  });

  it("repeat container fail-to-boot → comments on existing issue instead of filing a new one", async () => {
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-repeat",
        workItemId: "wi-repeat",
        title: "repeat-boot-fail",
      }),
    );

    // Search returns 1 hit — notifyFailure must comment on it, not file new.
    const commentCalls: CapturedCall[] = [];
    const createCalls: CapturedCall[] = [];
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: (p) => p.startsWith("/search/issues"), method: "GET" })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({
          total_count: 1,
          items: [{ number: 99 }],
        }),
        responseOptions: { headers: { "content-type": "application/json" } },
      }));
    fetchMock
      .get("https://api.github.com")
      .intercept({
        path: "/repos/TestOwner/test-repo/issues/99/comments",
        method: "POST",
      })
      .reply((opts) => {
        commentCalls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 201,
          data: JSON.stringify({
            html_url:
              "https://github.com/TestOwner/test-repo/issues/99#issuecomment-1",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });
    // No defensive interceptor for POST /issues — if the code wrongly tries
    // to create instead of comment, the unmocked request fails fast and
    // notifyFailure catches it; createCalls stays empty either way.

    const id = env.AGENT_LOOP.idFromName("container-boot-fail-repeat");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => {
        throw new Error("boot failed: ENOSPC");
      },
    });
    await runInDurableObject(stub, async (instance) => {
      (
        instance as { testContainerBootBackoffMs?: number }
      ).testContainerBootBackoffMs = 200;
    });
    await stub.fetch("http://do/wake", { method: "POST" });

    await fireAlarm(stub);

    expect(createCalls).toHaveLength(0); // must NOT file a new issue
    expect(commentCalls).toHaveLength(1); // must comment on existing
    const commentBody = JSON.parse(commentCalls[0]!.body);
    expect(commentBody.body).toMatch(/Repeat container fail-to-boot/);
    expect(commentBody.body).toContain("d-repeat");
    expect(commentBody.body).toContain("ENOSPC");
    // fp is rendered with surrounding backticks in the comment markdown.
    expect(commentBody.body).toMatch(/fp:`?[0-9a-f]{12}`?/);

    await clearAlarm(stub);
  });

  it("container returns 200 with no URL in body → no report, no move, sweeper reclaims", async () => {
    const calls: CapturedCall[] = [];
    queueOk(
      calls,
      preContainerQueue({
        dispatchId: "d-2",
        workItemId: "wi-2",
        title: "no-url",
      }),
    );

    const id = env.AGENT_LOOP.idFromName("container-no-url");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({
        status: "done",
        stdoutTail: "did some work but printed nothing useful",
      }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    expect(calls).toHaveLength(5);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
    });
    await clearAlarm(stub);
  });

  it("container status unknown (restarted / lost its job) → abandoned, no report/move, sweeper reclaims", async () => {
    const calls: CapturedCall[] = [];
    queueOk(calls, preContainerQueue({ title: "unknown-status" }));

    const id = env.AGENT_LOOP.idFromName("container-unknown");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => ({ status: "unknown" }),
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // 5 calls: reg, wait, claim, get_item, move(→in_progress). No report/move.
    expect(calls).toHaveLength(5);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await clearAlarm(stub);
  });

  it("transient status-poll failure → keeps monitoring, retries, completes on a later poll", async () => {
    const calls: CapturedCall[] = [];
    queueOk(calls, [
      ...preContainerQueue({ title: "transient" }),
      { artifact_id: "a-1", posted_at: "2026-05-25T11:00:00Z" },
      { error: null, blessingRequested: false },
    ]);

    const id = env.AGENT_LOOP.idFromName("container-transient");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    let statusPolls = 0;
    await installContainerHooks(stub, {
      start: async () => ({ status: 202 }),
      status: async () => {
        statusPolls += 1;
        // First poll throws (container re-booting); second reports done.
        if (statusPolls === 1) throw new Error("container not listening");
        return { status: "done", stdoutTail: "https://example.com/fake-pr\n" };
      },
    });
    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // The transient throw must NOT abandon: the dispatch still completes
    // (report + move). 7 MCP calls total.
    expect(statusPolls).toBe(2);
    expect(calls).toHaveLength(7);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
      "report_artifact",
      "move_item",
    ]);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
    });
    await clearAlarm(stub);
  });

  it("resumes monitoring an in-flight dispatch already in storage (survives DO restart mid-job)", async () => {
    // Only report + move are expected: the IDLE leg (register/wait/claim/move)
    // already ran before the simulated restart, leaving currentDispatch behind.
    const calls: CapturedCall[] = [];
    queueOk(calls, [
      { artifact_id: "a-1", posted_at: "2026-05-25T11:00:00Z" },
      { error: null, blessingRequested: true },
    ]);

    const id = env.AGENT_LOOP.idFromName("resume-after-restart");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      status: async () => ({ status: "done", stdoutTail: "https://example.com/fake-pr\n" }),
    });
    // Simulate the post-restart state: a live session + an in-flight dispatch.
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-1");
      await state.storage.put("currentDispatch", {
        dispatchId: "d-resume",
        workItemId: "wi-resume",
        startedAt: Date.now(),
        title: "resumed",
      });
      await state.storage.setAlarm(Date.now() + 1);
    });

    await drive(stub);

    // The MONITORING leg finalized the dispatch: report + move(→done).
    expect(calls).toHaveLength(2);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual(["report_artifact", "move_item"]);
    const reportArgs = JSON.parse(calls[0]!.body).params.arguments;
    expect(reportArgs).toMatchObject({
      itemId: "wi-resume",
      url: "https://example.com/fake-pr",
      kind: "pr",
      title: "resumed",
    });
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
    });
    await clearAlarm(stub);
  });
});

describe("MetriqAgentLoop daily cap", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("at-cap dispatch → post_agent_comment 'rate-limited' + move_item to backlog; container NOT booted", async () => {
    const calls: CapturedCall[] = [];
    let startHits = 0;
    queueOk(calls, [
      // Pre-container sequence stops at get_item (no move-to-in_progress —
      // ticket already in backlog) so we only take the first 4 messages, then
      // append the post_agent_comment reply the cap path makes.
      ...preContainerQueue({
        dispatchId: "d-cap",
        workItemId: "wi-cap",
        title: "cap-test",
        currentState: "backlog",
        through: "got-item",
      }),
      { ok: true }, // post_agent_comment
    ]);

    const id = env.AGENT_LOOP.idFromName("daily-cap-hit");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => {
        startHits += 1;
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://example.com/fake-pr\n",
      }),
    });

    const todayUtc = new Date().toISOString().slice(0, 10);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("dispatches_today", 5);
      await state.storage.put("dispatches_today_date", todayUtc);
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    expect(startHits).toBe(0);
    // 5 calls: reg, wait, claim, get_item (ticket already in backlog → no move),
    // post_agent_comment. No second move_item because ticket is already in backlog.
    expect(calls).toHaveLength(5);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "post_agent_comment",
    ]);
    const commentArgs = JSON.parse(calls[4]!.body).params.arguments;
    expect(commentArgs.itemId).toBe("wi-cap");
    expect(commentArgs.note).toMatch(/rate-limited/i);

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("currentDispatch")).toBeUndefined();
    });
    await clearAlarm(stub);
  });

  it("UTC midnight rollover resets the counter; under-cap dispatch proceeds normally", async () => {
    const calls: CapturedCall[] = [];
    let startHits = 0;
    queueOk(calls, [
      ...preContainerQueue({
        dispatchId: "d-roll",
        workItemId: "wi-roll",
        title: "rollover",
      }),
      { artifact_id: "a-1", posted_at: "2026-05-17T11:00:00Z" },
      { error: null, blessingRequested: true }, // move in_progress → done
    ]);

    const id = env.AGENT_LOOP.idFromName("daily-cap-rollover");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installContainerHooks(stub, {
      start: async () => {
        startHits += 1;
        return { status: 202 };
      },
      status: async () => ({
        status: "done",
        stdoutTail: "https://example.com/fake-pr\n",
      }),
    });

    // Pre-populate with YESTERDAY's date at cap; today should be reset.
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("dispatches_today", 5);
      await state.storage.put("dispatches_today_date", "1999-01-01");
    });

    await stub.fetch("http://do/wake", { method: "POST" });
    await drive(stub);

    // Container was started (rollover reset counter to 0, so under cap).
    // 7 calls: reg, wait, claim, get_item, move(ready→in_progress), report, move(in_progress→done).
    expect(startHits).toBe(1);
    const names = calls.map((c) => JSON.parse(c.body).params.name);
    expect(names).toEqual([
      "register_agent_session",
      "wait_for_assignment",
      "claim_assigned_task",
      "get_item",
      "move_item",
      "report_artifact",
      "move_item",
    ]);

    await runInDurableObject(stub, async (_i, state) => {
      const counter = await state.storage.get<number>("dispatches_today");
      const date = await state.storage.get<string>("dispatches_today_date");
      const today = new Date().toISOString().slice(0, 10);
      expect(counter).toBe(1);
      expect(date).toBe(today);
    });
    await clearAlarm(stub);
  });
});

describe("MetriqAgentLoop /pause + /resume", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("alarm short-circuits while paused (no wait_for_assignment call) and goes dormant until /resume", async () => {
    const calls: CapturedCall[] = [];
    // Only register is expected (cold-start path); wait should NOT happen while paused.
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return jsonReply({ session_id: "s-1" }, 1);
      });

    const id = env.AGENT_LOOP.idFromName("pause-shortcircuit");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await stub.fetch("http://do/wake", { method: "POST" });
    const pauseRes = await stub.fetch("http://do/pause", { method: "POST" });
    expect(pauseRes.status).toBe(204);

    await fireAlarm(stub);

    // Only register fired. wait_for_assignment was skipped because paused.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body).params.name).toBe(
      "register_agent_session",
    );

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get<boolean>("paused")).toBe(true);
      // After firing, the paused alarm must NOT have re-armed itself —
      // otherwise we'd busy-loop one alarm/second while paused.
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // Mark cleared for the leftover-alarm guard: the paused fire deliberately
    // left NO alarm (asserted above), so there is nothing to leak.
    await clearAlarm(stub);
  });

  it("/resume clears paused flag and re-arms alarm immediately", async () => {
    const id = env.AGENT_LOOP.idFromName("pause-resume");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);

    // Pre-seed paused state.
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("paused", true);
      await state.storage.deleteAlarm();
    });

    const before = Date.now();
    const res = await stub.fetch("http://do/resume", { method: "POST" });
    expect(res.status).toBe(204);
    // /resume armed a real-time alarm — record it so the leftover-alarm guard
    // verifies this test clears it in-test.
    noteAlarmArmed(stub);

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get<boolean>("paused")).toBe(false);
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      // /resume re-arms at the standard poll cadence (~1s), much sooner than
      // boot back-off (60s) — the meaningful guard against drift.
      expect(alarm! - before).toBeLessThan(2000);
    });
    await clearAlarm(stub);
  });
});

// =============================================================================
// MCP failure backoff — the production incident: persistent MCP 5xx previously
// re-armed at POLL_REARM_DELAY_MS (1s) regardless of failure, pinning the
// agent at ~1 req/s against an unhealthy Metriq. The fix: EVERY MCP call site
// is wrapped in `attemptWithBackoff` which on any throw bumps a persisted
// counter (`mcpFailureCount`), arms the next alarm at
// `computeBackoffMs(failureCount)` (Retry-After-aware), and never rethrows.
// `computeBackoffMs` mirrors Metriq's reference-runtime.ts @ 9fa1e236 verbatim
// in shape and semantics; the agent-side extends it with DO-storage state +
// HTTP/JSON-RPC Retry-After honoring. Every test below pins jitter to the
// equal-jitter FLOOR (rng=()=>0) via the testJitterRng override and asserts
// exact alarm deltas — deterministic on CI.
// =============================================================================
describe("MetriqAgentLoop MCP failure backoff (attemptWithBackoff)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  /**
   * Force the next alarm fire deterministically. `runDurableObjectAlarm` fires
   * whatever alarm is scheduled, immediately, regardless of its wall-clock
   * time (per @cloudflare/vitest-pool-workers types). The TRAP is using a
   * NEAR-future delay (e.g., Date.now()+1ms): the workerd runtime can
   * auto-fire it in the seam between setAlarm() and runDurableObjectAlarm(),
   * leaving the alarm consumed (fireAlarm then returns false → silent no-op
   * → flaky test). Using a FAR-future delay (1 hour) sidesteps the race —
   * the runtime won't auto-fire it in the millisecond between operations,
   * and runDurableObjectAlarm force-fires it on demand.
   */
  async function forceFireAlarm(stub: DurableObjectStub): Promise<void> {
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.setAlarm(Date.now() + 60 * 60 * 1000); // 1 hour
    });
    await fireAlarm(stub);
  }

  /**
   * Install the deterministic-jitter override (rng=()=>0 → equal-jitter floor
   * = delay/2 exactly) AND a small test cap so the assertion windows are tight
   * and runtime-independent. With maxMs=1000, the tier delays are:
   *   tier 1: min(1000, 1000) = 1000 → floor = 500
   *   tier 2: min(1000, 2000) = 1000 → floor = 500 (capped from tier 1 already)
   * For a more discriminating sequence use the default maxMs (30s) and rng=0:
   *   tier 1: 1000 → 500;  tier 2: 2000 → 1000;  tier 3: 4000 → 2000.
   * Helper for both shapes.
   */
  async function installBackoffOverrides(
    stub: DurableObjectStub,
    opts: { maxMs?: number } = {},
  ): Promise<void> {
    await runInDurableObject(stub, async (instance) => {
      (instance as { testJitterRng?: () => number }).testJitterRng = () => 0;
      if (opts.maxMs !== undefined) {
        (instance as { testMaxBackoffMs?: number }).testMaxBackoffMs =
          opts.maxMs;
      }
    });
  }

  it("persistent MCP failures → consecutive alarms re-arm at computeBackoffMs(failureCount) tiers (NOT POLL_REARM_DELAY_MS)", async () => {
    // Three consecutive 500s — one per forced alarm fire. Fully consumed so
    // no unconsumed interceptors leak into a sibling test (undici's
    // `fetchMock.deactivate()` does NOT clear pendings).
    const calls: CapturedCall[] = [];
    queueResponses(calls, [
      { kind: "http", statusCode: 500, body: "boom-1" },
      { kind: "http", statusCode: 500, body: "boom-2" },
      { kind: "http", statusCode: 500, body: "boom-3" },
    ]);

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-escalates");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installBackoffOverrides(stub);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
    });

    try {
      // Fire 1: counter 0 → 1; tier-1 delay = min(30000, 1000*2^0) = 1000;
      // equal-jitter floor (rng=0) = 500ms.
      const t0 = Date.now();
      await forceFireAlarm(stub);
      let alarm1: number | null = null;
      let counter1: number | undefined;
      await runInDurableObject(stub, async (_i, state) => {
        alarm1 = await state.storage.getAlarm();
        counter1 = await state.storage.get<number>("mcpFailureCount");
      });
      expect(alarm1).not.toBeNull();
      expect(counter1).toBe(1);
      // The delta tolerates the forceFireAlarm re-arm (+1ms) drift.
      expect(alarm1! - t0).toBeGreaterThanOrEqual(490);
      expect(alarm1! - t0).toBeLessThan(700);

      // Fire 2: counter 1 → 2; tier-2 delay = 2000; floor = 1000ms.
      const t1 = Date.now();
      await forceFireAlarm(stub);
      let alarm2: number | null = null;
      let counter2: number | undefined;
      await runInDurableObject(stub, async (_i, state) => {
        alarm2 = await state.storage.getAlarm();
        counter2 = await state.storage.get<number>("mcpFailureCount");
      });
      expect(alarm2).not.toBeNull();
      expect(counter2).toBe(2);
      expect(alarm2! - t1).toBeGreaterThanOrEqual(990);
      expect(alarm2! - t1).toBeLessThan(1300);

      // Fire 3: counter 2 → 3; tier-3 delay = 4000; floor = 2000ms.
      const t2 = Date.now();
      await forceFireAlarm(stub);
      let alarm3: number | null = null;
      let counter3: number | undefined;
      await runInDurableObject(stub, async (_i, state) => {
        alarm3 = await state.storage.getAlarm();
        counter3 = await state.storage.get<number>("mcpFailureCount");
      });
      expect(alarm3).not.toBeNull();
      expect(counter3).toBe(3);
      expect(alarm3! - t2).toBeGreaterThanOrEqual(1990);
      expect(alarm3! - t2).toBeLessThan(2300);

      // All 3 failures landed an MCP call — they don't suppress the call,
      // they only escalate the NEXT re-arm. Full drain (no leak).
      expect(calls).toHaveLength(3);
      expect(
        calls.every((c) => c.body.includes("wait_for_assignment")),
      ).toBe(true);
    } finally {
      await clearAlarm(stub);
    }
  });

  it("first successful MCP call clears the persisted counter; re-arm at POLL_REARM_DELAY_MS (1s)", async () => {
    // Seed counter directly at 3 (no failure fires needed) — isolates the
    // RESET-ON-SUCCESS behavior from the escalation behavior (covered in the
    // sibling test). One queued ok response, one forced fire, full drain.
    const calls: CapturedCall[] = [];
    queueResponses(calls, [{ kind: "ok", payload: { dispatch_id: null } }]);

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-resets");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installBackoffOverrides(stub);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
      await state.storage.put("mcpFailureCount", 3);
    });

    try {
      const tBefore = Date.now();
      await forceFireAlarm(stub);

      let alarmAfter: number | null = null;
      let counterAfter: number | undefined;
      await runInDurableObject(stub, async (_i, state) => {
        alarmAfter = await state.storage.getAlarm();
        counterAfter = await state.storage.get<number>("mcpFailureCount");
      });
      expect(alarmAfter).not.toBeNull();
      // Counter is deleted on success.
      expect(counterAfter).toBeUndefined();
      // Re-arm at POLL_REARM_DELAY_MS (1s) — the standard fast-poll cadence,
      // NOT the backoff-tier path (which at counter=4 would be 4000ms floor =
      // 2000ms — and would be inconsistent with the reset claim).
      expect(alarmAfter! - tBefore).toBeGreaterThan(500);
      expect(alarmAfter! - tBefore).toBeLessThan(1500);

      // Only one MCP call landed (the queued success). Full drain.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toContain("wait_for_assignment");
    } finally {
      await clearAlarm(stub);
    }
  });

  it("HTTP 503 Retry-After: 7 → next alarm at +~7000ms (server hint overrides computed backoff)", async () => {
    // ONE 503 with Retry-After header.
    const calls: CapturedCall[] = [];
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 503,
          data: "overloaded",
          responseOptions: {
            headers: { "content-type": "text/plain", "Retry-After": "7" },
          },
        };
      });

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-retry-after-header");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    // testMaxBackoffMs left at default 30s — 7s hint is below cap.
    await installBackoffOverrides(stub);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
    });

    try {
      const tBefore = Date.now();
      await forceFireAlarm(stub);
      let alarmAfter: number | null = null;
      await runInDurableObject(stub, async (_i, state) => {
        alarmAfter = await state.storage.getAlarm();
      });
      expect(alarmAfter).not.toBeNull();
      // Re-arm at ~7000ms (the server's hint), NOT the tier-1 computed
      // ~500ms (rng=0 floor of 1000ms tier). Discriminating signal.
      expect(alarmAfter! - tBefore).toBeGreaterThanOrEqual(6_900);
      expect(alarmAfter! - tBefore).toBeLessThan(7_500);
      expect(calls).toHaveLength(1);
    } finally {
      await clearAlarm(stub);
    }
  });

  it("JSON-RPC error.data.retry_after: 12 (no HTTP header) → next alarm at +~12000ms", async () => {
    // ONE 200 OK with a JSON-RPC error envelope carrying retry_after=12 seconds.
    const calls: CapturedCall[] = [];
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32000,
              message: "db is recovering",
              data: { retry_after: 12 },
            },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-retry-after-jsonrpc");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installBackoffOverrides(stub, { maxMs: 30_000 });
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
    });

    try {
      const tBefore = Date.now();
      await forceFireAlarm(stub);
      let alarmAfter: number | null = null;
      await runInDurableObject(stub, async (_i, state) => {
        alarmAfter = await state.storage.getAlarm();
      });
      expect(alarmAfter).not.toBeNull();
      expect(alarmAfter! - tBefore).toBeGreaterThanOrEqual(11_900);
      expect(alarmAfter! - tBefore).toBeLessThan(12_500);
      expect(calls).toHaveLength(1);
    } finally {
      await clearAlarm(stub);
    }
  });

  it("Retry-After hint > maxMs is capped at maxMs (a runaway server hint cannot strand the agent)", async () => {
    // 503 with Retry-After: 600 (10 minutes) — must be capped at maxMs=1000.
    const calls: CapturedCall[] = [];
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 503,
          data: "overloaded",
          responseOptions: {
            headers: {
              "content-type": "text/plain",
              "Retry-After": "600", // 10 minutes — pathological
            },
          },
        };
      });

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-retry-after-capped");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installBackoffOverrides(stub, { maxMs: 1_000 });
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
    });

    try {
      const tBefore = Date.now();
      await forceFireAlarm(stub);
      let alarmAfter: number | null = null;
      await runInDurableObject(stub, async (_i, state) => {
        alarmAfter = await state.storage.getAlarm();
      });
      expect(alarmAfter).not.toBeNull();
      // Capped at maxMs=1000ms, NOT 600000ms (10 min).
      expect(alarmAfter! - tBefore).toBeGreaterThanOrEqual(990);
      expect(alarmAfter! - tBefore).toBeLessThan(1_500);
    } finally {
      await clearAlarm(stub);
    }
  });

  it("failure inside startDispatch (claim_assigned_task) backs off + bails, no immediate re-poll", async () => {
    // Pre-container queue stops at the wait_for_assignment (with a real dispatch_id),
    // then the claim call gets a 503 — failure inside startDispatch.
    const calls: CapturedCall[] = [];
    queueResponses(calls, [
      // wait_for_assignment returns a real dispatch (no register — session seeded).
      {
        kind: "ok",
        payload: {
          dispatch_id: "d-mid-fail",
          work_item_id: "wi-mid-fail",
          payload: { title: "mid-fail", description: "x" },
        },
      },
      // claim_assigned_task FAILS with 503.
      { kind: "http", statusCode: 503, body: "claim 503" },
    ]);

    const id = env.AGENT_LOOP.idFromName("mcp-backoff-mid-dispatch");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await installBackoffOverrides(stub);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("sessionId", "s-seed");
    });

    try {
      const tBefore = Date.now();
      await forceFireAlarm(stub);
      let alarmAfter: number | null = null;
      let counterAfter: number | undefined;
      let currentDispatch: unknown;
      await runInDurableObject(stub, async (_i, state) => {
        alarmAfter = await state.storage.getAlarm();
        counterAfter = await state.storage.get<number>("mcpFailureCount");
        currentDispatch = await state.storage.get("currentDispatch");
      });
      // 2 MCP calls: the successful wait + the failing claim. No further
      // calls (get_item, move_item) — the chain bailed cleanly.
      expect(calls).toHaveLength(2);
      const names = calls.map((c) => JSON.parse(c.body).params.name);
      expect(names).toEqual(["wait_for_assignment", "claim_assigned_task"]);
      // No phantom MONITORING state — the dispatch was never recorded.
      expect(currentDispatch).toBeUndefined();
      // Counter reflects the claim failure (1 — wait succeeded and reset to
      // 0, then claim failed and bumped to 1).
      expect(counterAfter).toBe(1);
      // Alarm armed at the backoff tier-1 floor (500ms), NOT at the standard
      // 1s poll. The DISCRIMINATING signal: a buggy impl that propagated the
      // claim error to the alarm boundary would have re-armed at 1s.
      expect(alarmAfter! - tBefore).toBeGreaterThanOrEqual(490);
      expect(alarmAfter! - tBefore).toBeLessThan(700);
    } finally {
      await clearAlarm(stub);
    }
  });

  it("AGENT_PAUSED=true → poll short-circuits (no MCP call), alarm re-armed at the long pause cadence, counter unchanged", async () => {
    const id = env.AGENT_LOOP.idFromName("agent-paused-shortcircuit");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    // Install the AGENT_PAUSED override + seed counter, session, alarm in
    // the SAME runInDurableObject call so no seam exists where the runtime
    // could auto-fire an un-paused poll. testPausedRearmDelayMs=200 keeps the
    // assertion window tight (no 60s real-time bound on CI).
    await runInDurableObject(stub, async (instance, state) => {
      (instance as { testAgentPaused?: boolean }).testAgentPaused = true;
      (instance as { testPausedRearmDelayMs?: number }).testPausedRearmDelayMs =
        200;
      await state.storage.put("sessionId", "s-seed");
      // Pre-seed counter — the paused branch must NOT touch it (no MCP call
      // attempted; the streak is unchanged).
      await state.storage.put("mcpFailureCount", 5);
      // Far-future scheduled time avoids the auto-fire race (see
      // forceFireAlarm comment).
      await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });

    try {
      const tBefore = Date.now();
      await fireAlarm(stub);

      // No MCP fetch was attempted. Falsifiability: if the short-circuit is
      // broken, fetchMock would have either matched an interceptor (this
      // test queues NONE) or thrown via disableNetConnect.
      expect(fetchMock.pendingInterceptors().length).toBe(0);

      let alarmPaused: number | null = null;
      let counterAfter: number | undefined;
      await runInDurableObject(stub, async (_i, state) => {
        alarmPaused = await state.storage.getAlarm();
        counterAfter = await state.storage.get<number>("mcpFailureCount");
      });
      expect(alarmPaused).not.toBeNull();
      // Re-armed at the injected pause cadence (~200ms), NOT the standard
      // 1s poll re-arm and NOT a backoff tier.
      expect(alarmPaused! - tBefore).toBeGreaterThanOrEqual(190);
      expect(alarmPaused! - tBefore).toBeLessThan(800);
      // Counter UNCHANGED — paused-branch did not bump (no MCP attempted) nor
      // reset (no MCP success either). The streak is preserved across pauses
      // so the loop resumes at the same backoff tier the operator paused at.
      expect(counterAfter).toBe(5);
    } finally {
      await clearAlarm(stub);
    }
  });
});

describe("MetriqAgentLoop /stop", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("calls end_agent_session, clears session_id, deletes the alarm", async () => {
    const calls: CapturedCall[] = [];

    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify({ session_id: "s-stop" }) }],
            },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const id = env.AGENT_LOOP.idFromName("singleton");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    await stub.fetch("http://do/wake", { method: "POST" });

    const stop = await stub.fetch("http://do/stop", { method: "POST" });
    expect(stop.status).toBe(204);

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.get("sessionId")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    const endCalls = calls.filter((c) => c.body.includes("end_agent_session"));
    expect(endCalls).toHaveLength(1);
  });

  it("/stop with no active session is a no-op", async () => {
    const id = env.AGENT_LOOP.idFromName("singleton-noop");
    const stub = env.AGENT_LOOP.get(id);
    seenStubs.add(stub);
    const stop = await stub.fetch("http://do/stop", { method: "POST" });
    expect(stop.status).toBe(204);
    // No outbound MCP fetches landed (no session to end).
    expect(fetchMock.pendingInterceptors().length).toBe(0);
  });
});
