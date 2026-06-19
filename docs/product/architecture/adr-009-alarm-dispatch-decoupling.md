# ADR-009: Decouple Dispatch Execution from the Alarm Invocation

## Status

Accepted. Supersedes the synchronous-dispatch model in the Durable Object alarm loop.

## Context

The agent loop originally ran an entire container dispatch *synchronously inside one
Durable Object alarm invocation*:

```
alarm() → runDispatch() → await invokeContainer() → await stub.fetch("/run")
```

`stub.fetch("/run")` was held open for the full duration of the agent's work
(clone → install → the model codes the ticket → commit → push → open PR), which can
exceed **15 minutes**.

A DO alarm handler has a hard **15-minute wall-clock ceiling**
([Cloudflare DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
A real dispatch blew through it:

- `wallTimeMs: ~899990` (~15 min), `cpuTimeMs: 7` → not CPU-bound; blocked awaiting
  the container, force-terminated at the ceiling. `outcome: exceededCpu` is the
  eviction label, not a CPU loop.
- The container's `POST /run` subrequest logged `outcome: canceled` — the in-flight
  fetch torn down with the parent alarm.

### Why it was fatal, not merely slow

1. **The safety timeout could never fire.** `CONTAINER_TIMEOUT_MS` defaulted to
   **30 min** — *above* the 15-min ceiling — so the `Promise.race`
   `[wall-clock expired]` branch was dead code in production.
2. **The loop died permanently.** A wall-clock kill is not a catchable exception;
   the isolate is torn down, so `finally { scheduleNextPoll() }` never ran. No alarm
   was rescheduled → the DO went dormant. Cloudflare auto-retries alarms only ~6× and
   only on completion failure, and each retry would re-run the same doomed >15-min
   job. Net: the loop stopped and could not self-heal.

The 15-min wall limit is **not configurable** (only CPU time is, to 5 min), so the fix
cannot be "give it more time." The job must be decoupled from the alarm.

## Decision

Model the alarm as a short-lived, two-phase state machine that polls a status endpoint
on a short cycle instead of awaiting the job.

The container is a real Firecracker VM, not a Worker — *its* process can run past 15
minutes. Only the DO invocation that awaits it dies. So the alarm stops awaiting the
job and instead polls.

### Container (`container/server.js`)

Split the single blocking `POST /run` into:

- **`POST /start`** — parse dispatch context, spawn `entrypoint.sh` as a child, stash
  job state in memory keyed by `dispatch_id`, and **return `202` immediately** (no
  `await` of child close).
- **`GET /status?dispatch_id=X`** — return the job's current state:
  - `{status:"running"}`
  - `{status:"done", stdoutTail}` (exit 0; last 4 KB of stdout for `parseLastUrl`)
  - `{status:"failed", code, bodyTail}` (non-zero exit; last 8 KB combined)
  - `{status:"unknown"}` (no job for that id — container restarted / lost memory)

`entrypoint.sh` is **untouched**: its contract (stdout = PR URL, non-zero exit =
failure) is preserved. The job-state logic is extracted into a pure, spawn-injected
module (`container/job-state.mjs`) so it is unit-testable with `node --test` outside
the workers pool.

### Durable Object (`src/agent-loop.ts`)

The presence of `currentDispatch` in storage selects the phase:

```
alarm():
  if paused: return
  if currentDispatch:  monitorDispatch()   // MONITORING
  else:                pollForWork()        // IDLE
```

- **IDLE** (`pollForWork`) — register → `wait_for_assignment(25s)` → on a hit: claim →
  get_item → daily-cap → move to `in_progress` → fire `POST /start`, await only its fast
  `202`, store `currentDispatch{startedAt}`, arm a monitor poll. A `/start` throw runs
  the existing boot-failure handler (alert issue + 60 s backoff); `currentDispatch` is
  not set.
- **MONITORING** (`monitorDispatch`) — always short:
  - `running` → watchdog: `now − startedAt > maxDispatchMs` ⇒ abandon + clear (sweeper
    reclaims); else re-arm a `MONITOR_POLL_MS` (~15 s) poll.
  - `done` → existing `report_artifact → move→done` logic incl. `rescueOrphanedDispatch`
    on `null`; clear `currentDispatch`.
  - `failed` / `unknown` → log excerpt, clear (sweeper reclaims).
  - status fetch **throws** (container re-booting / transport blip) → transient: keep
    monitoring (bounded by watchdog), retry next poll.

Invariant: **no invocation ever blocks on the job.** IDLE ≈ 25 s, MONITORING ≈ <1 s — the
15-min ceiling is unreachable, so `finally` always re-arms and the loop cannot die. The
~15 s monitor poll also resets the container's `sleepAfter` idle timer, keeping it awake
through the job.

### Config (`src/agent-config.ts`)

- `CONTAINER_TIMEOUT_MS` (default 30 min) is repurposed as the **watchdog** `maxDispatchMs`,
  enforced as `now − startedAt` across polls. It may now safely exceed 15 min because no
  single invocation is long.
- New `MONITOR_POLL_MS` (default 15 s) — monitor-phase re-arm cadence.
- `sleepAfter` stays `"10m"` (15 s polls keep the container alive; it only reaps after the
  DO stops polling).

## Consequences

### Robustness wins (fall out for free)

1. **Survives DO restarts.** `currentDispatch` lives in storage; an evicted DO re-fires the
   persisted alarm, sees `currentDispatch`, and resumes polling the still-running container.
   The old blocking model lost everything on a restart.
2. **Self-heals a stuck state.** An orphaned `currentDispatch` (a killed alarm that never
   deleted it) plus a dormant loop recovers after one `POST /wake`: an alarm fires → monitor
   polls `/status` for the dead dispatch → `unknown` → clears → idle. No manual storage surgery.

### Testing

- **`src/agent-loop.ts`** — full TDD in the workers pool. Each dispatch now spans two alarm
  fires (idle→start, monitor→done); a `drive()` helper fires the idle alarm then monitor
  alarms until `currentDispatch` clears. New tests: watchdog abandonment, `failed`/`unknown`
  status, transient-throw retry.
- **`container/job-state.mjs`** — `node --test` unit tests with an injected fake spawn:
  running→done, running→failed, unknown for absent id.
- CI (`.github/workflows/ci.yml`) and `lefthook.yml` gain the container test.

### Out of scope (YAGNI)

- `POST /cancel` to kill a runaway child early (`sleepAfter` reaps it within 10 min once
  polling stops).
- Parallel dispatches (loop stays serial: one `currentDispatch` at a time).
