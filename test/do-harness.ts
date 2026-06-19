/**
 * Shared Durable-Object acceptance-test harness for the open-source-llm feature.
 *
 * Extracted (Phase 2) from test/model-selection.acceptance.test.ts so the
 * Phase-1 and Phase-2 acceptance suites share ONE copy of the alarm-clearing /
 * isolated-storage-safe driving logic — not two divergent copies.
 *
 * Why this exists (the CI isolation flake it fixes):
 *
 *   These scenarios drive the REAL DO, which persists storage + alarms in the
 *   shared workers-pool isolate. A walking skeleton / escalation scenario is RED
 *   by design, so any cleanup placed AFTER an assertion never runs once the
 *   assertion throws — leaving `currentDispatch` + a scheduled (re-armed,
 *   real-time) alarm behind, which corrupts the next test file's stacked isolated
 *   storage ("Isolated storage failed"). Likewise an unconsumed undici
 *   interceptor (a RED test stops driving early) leaks into the next file
 *   ("UND_MOCK_ERR_MOCK_NOT_MATCHED").
 *
 * The fix, shared here:
 *   - `drive()` deterministically clears the DO's re-armed real-time IDLE poll
 *     alarm in-test (the same discipline agent-loop.test.ts uses), so no test
 *     leaves a live alarm.
 *   - `cleanupTestState()` (run in afterEach) UNCONDITIONALLY wipes every touched
 *     DO's storage + alarm and deactivates the fetch mock — even when an
 *     assertion threw.
 *   - `agentStub()` / `installContainerHooks()` register every touched stub in
 *     `touchedStubs` so afterEach can find them.
 *
 * Any DO-driving acceptance test MUST end with NO live alarm. Reuse these
 * helpers; do not re-implement the alarm-clearing logic.
 */

import { expect, vi } from "vitest";
import {
  env,
  fetchMock,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { ContainerStatus } from "../src/agent-loop";

export type StartHook = (
  dispatchId: string,
  body: string,
) => Promise<{ status: number }>;
export type StatusHook = (dispatchId: string) => Promise<ContainerStatus>;

/** Stubs touched in the current test — wiped unconditionally in afterEach. */
export const touchedStubs = new Set<DurableObjectStub>();

/**
 * Stubs whose DO real-time alarm got ARMED during this test (any alarm fire
 * re-arms a follow-on poll, and /wake schedules one). A stub here that is NOT in
 * `clearedStubs` at test end is a LEAK — it left a live real-time poll alarm.
 */
const armedStubs = new Set<DurableObjectStub>();

/**
 * Stubs whose live alarm was DETERMINISTICALLY cleared in-test (via clearAlarm /
 * drive). Cleared inside the same isolated-storage layer that armed it — the
 * ONLY place the @cloudflare/vitest-pool-workers runtime lets us observe and
 * cancel the real-time timer (the per-test isolated-storage layer pops between
 * tests, so by afterEach `getAlarm()` always reads null even though miniflare's
 * runtime timer is still scheduled and WILL fire on slower CI — the flake).
 */
const clearedStubs = new Set<DurableObjectStub>();

/** Record that a DO's real-time alarm was (re-)armed. Called by fireAlarm/wake. */
export function noteAlarmArmed(stub: DurableObjectStub): void {
  touchedStubs.add(stub);
  armedStubs.add(stub);
}

/**
 * Deterministically clear a DO's re-armed real-time alarm IN-TEST and mark it
 * cleared. This is the body-end discipline that defuses the CI isolation flake:
 * the re-armed IDLE poll alarm (POLL_REARM_DELAY_MS = 1000ms), if left live,
 * fires ~1s later into a sibling test/file's isolated-storage pop → flaky
 * `UND_MOCK_ERR_MOCK_NOT_MATCHED` + "Isolated storage failed".
 */
export async function clearAlarm(stub: DurableObjectStub): Promise<void> {
  touchedStubs.add(stub);
  await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm());
  clearedStubs.add(stub);
}

/**
 * Fire a DO alarm and record that doing so (re-)armed a follow-on real-time
 * alarm. Use in place of the raw `runDurableObjectAlarm` in any test that drives
 * alarms directly, so the leftover-alarm guard can see the stub was armed.
 */
export async function fireAlarm(stub: DurableObjectStub): Promise<boolean> {
  noteAlarmArmed(stub);
  return runDurableObjectAlarm(stub);
}

/**
 * PERMANENT regression guard (CI isolation flake). FAILS the current test if any
 * stub whose alarm was armed during the test was NOT cleared in-test. This is the
 * deterministic local tripwire for the flake: "armed-but-not-cleared" is a pure
 * discipline check that does NOT depend on the runtime's alarm-teardown timing
 * (which makes an afterEach `getAlarm()` read useless — it always returns null
 * after the isolated-storage layer pops). Falsifiable: forget to clear a driven
 * DO's alarm and this throws, naming the test. Call from each suite's afterEach
 * BEFORE wiping state; it resets its own tracking sets.
 */
export function assertNoLeftoverAlarm(): void {
  const leaked: DurableObjectStub[] = [];
  for (const stub of armedStubs) {
    if (!clearedStubs.has(stub)) leaked.push(stub);
  }
  const armedCount = armedStubs.size;
  armedStubs.clear();
  clearedStubs.clear();
  if (leaked.length === 0) return;
  const testName = expect.getState().currentTestName ?? "<unknown test>";
  throw new Error(
    `Leftover DO alarm after test "${testName}": ${leaked.length} of ` +
      `${armedCount} driven Durable Object(s) left a re-armed real-time poll ` +
      `alarm live (never cleared in-test). On slower CI that alarm fires ~1s ` +
      `later into a sibling test/file's isolated-storage pop → ` +
      `UND_MOCK_ERR_MOCK_NOT_MATCHED + "Isolated storage failed". Clear it ` +
      `deterministically before the test ends: await clearAlarm(stub) (or let ` +
      `the shared drive() helper do it).`,
  );
}

/** Resolve a DO stub by name AND register it for unconditional teardown. */
export function agentStub(name: string): DurableObjectStub {
  const stub = env.AGENT_LOOP.get(env.AGENT_LOOP.idFromName(name));
  touchedStubs.add(stub);
  return stub;
}

export async function installContainerHooks(
  stub: DurableObjectStub,
  hooks: { start?: StartHook; status?: StatusHook },
): Promise<void> {
  touchedStubs.add(stub);
  await runInDurableObject(stub, async (instance) => {
    const i = instance as {
      testContainerStart?: StartHook;
      testContainerStatus?: StatusHook;
    };
    if (hooks.start) i.testContainerStart = hooks.start;
    if (hooks.status) i.testContainerStatus = hooks.status;
  });
}

/**
 * Unconditional per-test teardown. Runs even when an assertion threw (RED WS /
 * RED escalation scenario), so nothing leaks into the next file's isolate.
 *  - wipe every touched DO's storage + alarm,
 *  - restore any console spies,
 *  - reset the fetch mock so unconsumed interceptors cannot survive.
 */
export async function cleanupTestState(): Promise<void> {
  for (const stub of touchedStubs) {
    try {
      await runInDurableObject(stub, async (_i, state) => {
        await state.storage.deleteAll();
        await state.storage.deleteAlarm();
      });
    } catch {
      // best-effort: a stub that never materialized has nothing to wipe.
    }
  }
  touchedStubs.clear();
  vi.restoreAllMocks();
  // Drops any interceptor registered but not consumed by a RED test's early
  // exit; the next test's beforeEach re-activates a clean mock.
  fetchMock.deactivate();
  // PERMANENT guard: trip deterministically if any driven DO left a live
  // real-time alarm (the CI isolation flake). Runs LAST so the wipe above can't
  // mask the discipline check (which is runtime-timing-independent).
  assertNoLeftoverAlarm();
}

/** Drive the DO alarm state machine to rest (IDLE start → MONITORING → done). */
export async function drive(
  stub: DurableObjectStub,
  maxFires = 12,
): Promise<void> {
  await fireAlarm(stub);
  for (let i = 0; i < maxFires; i++) {
    const monitoring = await runInDurableObject(
      stub,
      async (_i, state) =>
        (await state.storage.get("currentDispatch")) !== undefined,
    );
    if (!monitoring) break;
    await fireAlarm(stub);
  }
  // After a dispatch finishes, the DO re-arms a REAL-TIME IDLE poll alarm
  // (POLL_REARM_DELAY_MS = 1000ms). Left live, that alarm fires ~1s later —
  // during isolated-storage teardown or a subsequent test — running pollForWork
  // against a fetchMock that no longer matches: flaky `UND_MOCK_ERR_MOCK_NOT_MATCHED`
  // + "Isolated storage failed" that only surfaces under CI's slower timing (local
  // always wins the 1s race). Clear it DETERMINISTICALLY here, in-test — the same
  // discipline agent-loop.test.ts uses (getAlarm/deleteAlarm inside the test body).
  // clearAlarm also marks the stub cleared so assertNoLeftoverAlarm passes.
  await clearAlarm(stub);
}

/**
 * Read a DO storage key from inside the instance (for asserting durable state
 * such as the escalation intent, Slice E / ADR-008). Registers the stub for
 * teardown so the read alone never leaks state.
 */
export async function readStorage<T>(
  stub: DurableObjectStub,
  key: string,
): Promise<T | undefined> {
  touchedStubs.add(stub);
  return await runInDurableObject(stub, async (_i, state) =>
    state.storage.get<T>(key),
  );
}

/**
 * Seed a DO storage key from inside the instance (for arranging durable state
 * such as a pre-existing escalation intent, Slice E / ADR-008). Registers the
 * stub for teardown.
 */
export async function seedStorage(
  stub: DurableObjectStub,
  key: string,
  value: unknown,
): Promise<void> {
  touchedStubs.add(stub);
  await runInDurableObject(stub, async (_i, state) => {
    await state.storage.put(key, value);
  });
}
