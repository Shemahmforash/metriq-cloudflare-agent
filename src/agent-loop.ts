import { DurableObject } from "cloudflare:workers";
import {
  AgentConfig,
  computeBackoffMs,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from "./agent-config";
import { McpClient, McpError } from "./mcp-client";
import {
  resolveModel,
  resolveHarness,
  buildCostAttributionTags,
  type ResolvedModel,
  type CostAttributionTags,
} from "./resolve-model";

export interface Env {
  AGENT_LOOP: DurableObjectNamespace;
  AGENT_CONTAINER: DurableObjectNamespace;
  METRIQ_API_KEY: string;
  METRIQ_MCP_URL: string;
  // Worker secrets forwarded to AgentContainer.envVars; see agent-container.ts.
  GITHUB_PAT: string;
  GITHUB_USER: string;
  ANTHROPIC_API_KEY: string;
  // Bearer token gating the control + debug routes on the public Worker.
  // Set via `wrangler secret put CONTROL_TOKEN`. /health stays open.
  CONTROL_TOKEN: string;
  RETRY_DELAY_MS?: string;
  CONTAINER_TIMEOUT_MS?: string;
  CONTAINER_BOOT_BACKOFF_MS?: string;
  MONITOR_POLL_MS?: string;
  // Where to file a GitHub Issue when a container fails to boot. Falls back to
  // TARGET_REPO (no hardcoded owner default); when both are unset, alerts are
  // skipped. Reuses GITHUB_PAT (already present) for auth.
  ALERT_GITHUB_REPO?: string;
  DAILY_CAP?: string;
  // Deploy-time constants forwarded into the container (buildContainerEnvVars):
  // which repo the agent clones + opens PRs against. TARGET_REPO is REQUIRED at
  // the container boundary (entrypoint.sh fails fast when unset); also the
  // ALERT_GITHUB_REPO fallback target.
  TARGET_REPO?: string;
  TARGET_BASE_BRANCH?: string;
}

/**
 * Result of polling the container's `GET /status` endpoint. `unknown` means the
 * container has no record of the dispatch — it was never started there, or the
 * instance restarted and lost its in-memory job; the DO treats it as a terminal
 * failure (sweeper reclaims). Mirrors the shape returned by job-state.mjs.
 */
export type ContainerStatus =
  | { status: "running" }
  | { status: "done"; stdoutTail: string }
  | { status: "failed"; code: number | null; bodyTail: string }
  | { status: "unknown" };

type ContainerStarter = (
  dispatchId: string,
  body: string,
) => Promise<{ status: number }>;
type ContainerStatusPoller = (dispatchId: string) => Promise<ContainerStatus>;

/**
 * What `startDispatch` asks the IDLE poll to do for the next alarm:
 *  - "monitor": container started; arm a short status-poll alarm.
 *  - "poll": nothing in flight (drop / cap / bad start); arm the normal idle poll.
 *  - "none": a back-off alarm was already armed (boot failure); leave it.
 */
type RearmDirective = "monitor" | "poll" | "none";

const CLIENT_ID = "cloudflare-agent";
const POLL_REARM_DELAY_MS = 1000;
/**
 * DO-storage key for the consecutive-MCP-failure counter that drives the
 * Retry-After-aware exponential backoff (see `attemptWithBackoff` below).
 * Persisted so the schedule survives DO restarts — a crash-loop must not reset
 * the counter and re-engage 1 req/s against an unhealthy MCP. Bumped on ANY
 * MCP-call failure from any DO method; cleared on ANY MCP-call success.
 */
const MCP_FAILURE_COUNT_KEY = "mcpFailureCount";

/**
 * Result of an `attemptWithBackoff`-wrapped MCP call. Callers MUST inspect
 * `ok` and bail out of their iteration when `ok === false` — the wrapper has
 * already armed the backoff alarm; continuing would make a second MCP call
 * the operator didn't ask for.
 */
type McpAttempt<T> = { ok: true; value: T } | { ok: false };

// Display + log-truncation lengths. Named so a change is one-line.
const ERROR_TITLE_CHARS = 80;       // suffix of error message used in GH issue titles
const ERROR_TAIL_CHARS = 200;       // tail of HTTP error bodies kept in logs
const CONTAINER_LOG_BYTES = 8000;   // last N chars of container output kept in the DO error log
const SHORT_ID_CHARS = 8;           // first N chars of a UUID treated as a human-readable short id
const FINGERPRINT_HASH_CHARS = 12;  // hex chars of the SHA-256 used as a fingerprint
const FINGERPRINT_INPUT_CHARS = 100; // first N chars of the normalized error line that feed the hash

interface CurrentDispatch {
  dispatchId: string;
  workItemId: string;
  startedAt: number;
  title: string;
  // open-source-llm Phase 2 / Slice D+E (ADR-005/008): which harness ran this
  // dispatch. monitorDispatch records an escalation intent only when a FAILED
  // dispatch's harness was "opencode" (ADR-008 §3). Optional for back-compat
  // with any in-flight Phase-1 currentDispatch records (treated as "claude").
  harness?: "claude" | "opencode";
  // The resolved OSS model id this dispatch ran (ADR-008): carried so a recorded
  // escalation intent can store the FAILED OSS model for KPI-6 cost analytics
  // (ADR-007). Optional for back-compat with in-flight Phase-1 records.
  model?: string;
  // The DO-minted cost-attribution tags for this dispatch (ADR-004/007). Carried
  // on the record so recordEscalationIntent can recover the authoritative
  // resolved model id (costTags.model) if `model` above is somehow absent —
  // KPI-6 joins on a NON-empty failedModel (review D4). Optional for back-compat.
  costTags?: CostAttributionTags;
}

/**
 * open-source-llm Phase 2 / Slice E (ADR-008): the work_item_id-keyed escalation
 * intent persisted in DO storage when an OSS dispatch fails. It survives the gap
 * to the ticket's NEXT, separate delivery (currentDispatch is deleted on
 * failure), where startDispatch consumes it to coerce the model to Claude.
 */
export interface EscalationIntent {
  failedDispatchId: string;
  failedModel: string;
  failedHarness: "opencode";
  recordedAt: number;
}

/** DO-storage key for a work item's escalation intent (ADR-008 §2). */
function escalationKey(workItemId: string): string {
  return `escalation:${workItemId}`;
}

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Container stdout is captured wholesale; container code may log intermediate
 * URLs (clone source, MCP endpoint, etc.) before the final PR URL. Take the
 * LAST match to avoid surfacing those as the artifact.
 */
export function parseLastUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  return matches?.[matches.length - 1] ?? null;
}

/**
 * Stable short identifier for an error's "kind" — used to group repeat
 * fail-to-boot events onto the same GitHub Issue instead of filing a fresh
 * one each time. Two errors with the same first-line shape collapse to the
 * same fp; different errors hash to different fps.
 *
 * 12 hex chars (48 bits) = ~3 × 10^14 fingerprints — collisions vanishingly
 * rare for the small error space we expect.
 */
export async function fingerprintError(errorMessage: string): Promise<string> {
  const firstLine = errorMessage.split("\n")[0] ?? "";
  const normalized = firstLine
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FINGERPRINT_INPUT_CHARS);
  const buf = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, FINGERPRINT_HASH_CHARS);
}

export class MetriqAgentLoop extends DurableObject<Env> {
  /**
   * Test-only hooks. When set (via runInDurableObject in vitest-pool-workers),
   * the dispatch flow uses these instead of `env.AGENT_CONTAINER`. Miniflare
   * can't boot real containers under the test runtime, so unit tests inject the
   * `/start` and `/status` responses directly here. Production never sets them.
   */
  testContainerStart?: ContainerStarter;
  testContainerStatus?: ContainerStatusPoller;
  /** Test-only override for the per-dispatch watchdog (max wall-clock). */
  testContainerTimeoutMs?: number;
  /** Test-only override for the container-fail-to-boot back-off. */
  testContainerBootBackoffMs?: number;
  /** Test-only override for the monitor-poll re-arm cadence. */
  testMonitorPollMs?: number;
  /** Test-only override for the daily-dispatch cap. */
  testDailyCap?: number;
  /**
   * Test-only override for the operator-configured fleet default model
   * (open-source-llm Slice B). Production sets the default via the
   * AGENT_MODEL_DEFAULT secret (AgentConfig.agentModelDefault), never this
   * field; tests use it to exercise the AGENT_MODEL_DEFAULT precedence branch.
   */
  testAgentModelDefault?: string;
  /**
   * Test-only override for the AGENT_PAUSED operator kill-switch. Production
   * resolves it from AgentConfig.agentPaused (env secret); tests flip this
   * directly to exercise the short-circuit branch without re-binding env vars.
   */
  testAgentPaused?: boolean;
  /** Test-only override for the AGENT_PAUSED re-arm cadence. */
  testPausedRearmDelayMs?: number;
  /**
   * Test-only deterministic jitter source for `attemptWithBackoff`'s
   * `computeBackoffMs` call. Defaults to `Math.random`. Tests inject e.g.
   * `() => 0` to pin the equal-jitter floor (`delay/2`) and assert exact
   * scheduled-alarm deltas. Mirrors the `rng` option in Metriq's reference
   * runtime so the agent and the server can be tested with the same rng shape.
   */
  testJitterRng?: () => number;
  /**
   * Test-only override for the exponential-backoff CAP (`maxMs` in
   * `computeBackoffMs`). Defaults to DEFAULT_MAX_BACKOFF_MS (30s). Tests pass a
   * small value (e.g. 1000) so a Retry-After-cap assertion can use a tight
   * window without depending on a 30s real-time bound.
   */
  testMaxBackoffMs?: number;
  /**
   * Test-only override for the exponential-backoff BASE (`baseMs` in
   * `computeBackoffMs`). Defaults to DEFAULT_BASE_BACKOFF_MS (1s). Tests rarely
   * need to override this — kept for parity with the reference's tunable shape.
   */
  testBaseBackoffMs?: number;

  private readonly config = new AgentConfig(this.env);

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/wake" && req.method === "POST") {
      await this.ensureRegistered();
      await this.ensureAlarmScheduled();
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      await this.stop();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/debug" && req.method === "GET") {
      const all = await this.ctx.storage.list();
      const dump: Record<string, unknown> = {};
      for (const [k, v] of all) dump[k] = v;
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({
        storage: dump,
        scheduledAlarmAt: alarm,
        scheduledInMs: alarm === null ? null : alarm - Date.now(),
      });
    }
    if (url.pathname === "/pause" && req.method === "POST") {
      await this.ctx.storage.put("paused", true);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/resume" && req.method === "POST") {
      await this.ctx.storage.put("paused", false);
      // /resume re-arms ~immediately. Use the standard poll delay so the
      // runtime doesn't auto-fire-and-clear before observers can see the
      // scheduled alarm.
      await this.ctx.storage.setAlarm(Date.now() + POLL_REARM_DELAY_MS);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Two-phase state machine. The presence of `currentDispatch` selects the
   * phase: MONITORING (poll the in-flight container's status) vs IDLE (long-poll
   * Metriq for the next assignment). Each invocation is short — IDLE ≈ 25s,
   * MONITORING ≈ <1s — so neither approaches the 15-min DO alarm wall-clock
   * ceiling, and the re-arm at the end of each phase always runs.
   */
  override async alarm(): Promise<void> {
    const paused = await this.ctx.storage.get<boolean>("paused");
    if (paused) {
      // Kill switch active — return silently without rescheduling so the loop
      // goes dormant. /resume re-arms the alarm explicitly via setAlarm.
      return;
    }
    const current =
      await this.ctx.storage.get<CurrentDispatch>("currentDispatch");
    if (current) {
      await this.monitorDispatch(current);
      return;
    }
    await this.pollForWork();
  }

  /** IDLE phase: register if needed, long-poll for an assignment, start it. */
  private async pollForWork(): Promise<void> {
    // AGENT_PAUSED kill-switch (operator-set via `wrangler secret put
    // AGENT_PAUSED=true`). Short-circuit BEFORE any MCP call so a degraded
    // Metriq endpoint sees ZERO traffic from this agent — the whole point of
    // the incident pause. Re-arm at the long pause cadence so the next
    // `wrangler secret put AGENT_PAUSED=false` propagates within ~1 minute.
    // The MCP-failure counter is NOT mutated while paused (no MCP call was
    // even attempted).
    if (this.testAgentPaused ?? this.config.agentPaused) {
      console.warn("AGENT_PAUSED is set — skipping MCP poll");
      await this.schedulePausedRearm();
      return;
    }

    // Every MCP call below threads through `attemptWithBackoff`, which on
    // any failure: bumps the persisted MCP failure counter, ARMS the next
    // alarm at `computeBackoffMs(...)` (Retry-After-aware), and returns
    // `{ok:false}`. The caller must BAIL on `ok:false` — the alarm is
    // already armed, continuing the iteration would make a second MCP call
    // the operator didn't ask for.

    // Session bootstrap: when a sessionId is already cached, NO MCP call is
    // made — short-circuit OUTSIDE attemptWithBackoff so the cached-session
    // path doesn't falsely reset the failure counter (a non-MCP-event must
    // never affect the streak). The actual register_agent_session call only
    // runs on cold-start and IS wrapped (its failure bumps + backs off, its
    // success resets).
    let sessionId = await this.ctx.storage.get<string>("sessionId");
    if (!sessionId) {
      const reg = await this.attemptWithBackoff(
        () =>
          this.mcpClient().registerAgentSession({ clientId: CLIENT_ID }),
        "register_agent_session",
      );
      if (!reg.ok) return;
      sessionId = reg.value.sessionId;
      await this.ctx.storage.put("sessionId", sessionId);
    }

    const wait = await this.attemptWithBackoff(
      () =>
        this.mcpClient().waitForAssignment({
          sessionId,
          timeoutSeconds: 25,
        }),
      "wait_for_assignment",
    );
    if (!wait.ok) return;

    const r = wait.value;
    if (r.dispatchId === null) {
      console.log("polled, nothing.");
      await this.scheduleNextPoll();
      return;
    }

    const directive = await this.startDispatch(sessionId, {
      dispatchId: r.dispatchId,
      title: r.payload?.title ?? r.dispatchId,
      description: r.payload?.description ?? "",
      ticketModel: r.payload?.model,
    });
    if (directive === "monitor") await this.scheduleMonitorPoll();
    else if (directive === "poll") await this.scheduleNextPoll();
    // "none": handleContainerBootFailure or attemptWithBackoff already armed
    // the back-off alarm; leave it.
  }

  /**
   * `attemptWithBackoff` — mirrors the upstream Metriq agent reference
   * runtime (function of the same name) in shape and semantics,
   * extended for the DO context. Differences from the reference:
   *
   *   - State (`consecutiveFailures`) is persisted in DO storage (key
   *     `MCP_FAILURE_COUNT_KEY`) instead of in-process memory. The reference
   *     assumes a long-running daemon; the DO restarts between alarms, so the
   *     streak must survive.
   *   - On `ok:false`, the wrapper ARMS the next alarm at the computed (or
   *     Retry-After-overridden) delay — the DO equivalent of the reference's
   *     `await sleep(backoffMs)`. The CALLER then `return`s; the wrapper has
   *     already scheduled the next iteration.
   *   - Retry-After honoring: when the thrown error is an `McpError` carrying
   *     `retryAfterMs`, use `min(maxMs, retryAfterMs)` instead of the computed
   *     exponential — a misbehaving server cannot bias us out for hours.
   *
   * On success: persists `consecutiveFailures = 0` and returns `{ok:true,
   * value}`. The caller proceeds normally. NEVER rethrows — that's the whole
   * point of the wrapper (the previous loop's missing error boundary).
   *
   * When `armAlarmOnFailure` is false (the `/stop` shutdown path), the wrapper
   * still bumps + logs + returns `{ok:false}`, but does NOT arm an alarm —
   * a stop should not re-enter the loop.
   */
  private async attemptWithBackoff<T>(
    fn: () => Promise<T>,
    label: string,
    opts: { armAlarmOnFailure?: boolean } = {},
  ): Promise<McpAttempt<T>> {
    const armOnFailure = opts.armAlarmOnFailure ?? true;
    try {
      const value = await fn();
      await this.resetMcpFailureCount();
      return { ok: true, value };
    } catch (error) {
      const newCount = await this.bumpMcpFailureCount();
      const retryAfterMs =
        error instanceof McpError ? error.retryAfterMs : undefined;
      const maxMs = this.testMaxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
      const baseMs = this.testBaseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
      const rng = this.testJitterRng ?? Math.random;
      const computed = computeBackoffMs(newCount, { baseMs, maxMs, rng });
      // Retry-After honoring: when the server hinted (HTTP `Retry-After` OR
      // JSON-RPC `error.data.retry_after`), use min(maxMs, hint). Cap protects
      // against a runaway `Retry-After: 86400` from a misbehaving upstream.
      const effective =
        retryAfterMs !== undefined
          ? Math.min(maxMs, Math.floor(retryAfterMs))
          : computed;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `${label} failed (attempt ${newCount}): ${reason} — backing off ${effective}ms`,
      );
      if (armOnFailure) {
        await this.ctx.storage.setAlarm(Date.now() + effective);
      }
      return { ok: false };
    }
  }

  /** Bump the persisted MCP-failure counter and return the new value. */
  private async bumpMcpFailureCount(): Promise<number> {
    const prior =
      (await this.ctx.storage.get<number>(MCP_FAILURE_COUNT_KEY)) ?? 0;
    const next = prior + 1;
    await this.ctx.storage.put(MCP_FAILURE_COUNT_KEY, next);
    return next;
  }

  /** Clear the persisted MCP-failure counter (called on every MCP-call success). */
  private async resetMcpFailureCount(): Promise<void> {
    await this.ctx.storage.delete(MCP_FAILURE_COUNT_KEY);
  }

  /** Re-arm at the long AGENT_PAUSED cadence (no MCP traffic while paused). */
  private async schedulePausedRearm(): Promise<void> {
    const delay = this.testPausedRearmDelayMs ?? this.config.pausedRearmDelayMs;
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * Claim a dispatch, move it to in_progress, and fire `POST /start` (awaiting
   * only the fast 202). Stores `currentDispatch` so the next alarm enters the
   * MONITORING phase. Does NOT await the agent's work.
   */
  private async startDispatch(
    sessionId: string,
    args: {
      dispatchId: string;
      title: string;
      description: string;
      ticketModel?: string;
    },
  ): Promise<RearmDirective> {
    const { dispatchId, title, description, ticketModel } = args;
    const client = this.mcpClient();
    const claimAttempt = await this.attemptWithBackoff(
      () => client.claimAssignedTask({ dispatchId, sessionId }),
      "claim_assigned_task",
    );
    if (!claimAttempt.ok) return "none"; // backoff alarm already armed
    const claim = claimAttempt.value;
    if (!claim.ok) {
      console.log(`dispatch ${dispatchId} dropped: claim ${claim.reason}`);
      return "poll";
    }
    const itemId = claim.workItemId;

    // Discover the work item's current state. Metriq's dispatcher delivers
    // the ticket without auto-moving it out of backlog/ready, so the agent
    // must move it to in_progress itself (and use the correct fromState for
    // any cap-hit move back to backlog).
    const itemAttempt = await this.attemptWithBackoff(
      () => client.getItem({ itemId }),
      "get_item",
    );
    if (!itemAttempt.ok) return "none";
    const item = itemAttempt.value;
    const fromState = item.currentState;

    // Daily cap check — UTC midnight rollover resets the counter.
    const today = new Date().toISOString().slice(0, 10);
    const storedDate = await this.ctx.storage.get<string>(
      "dispatches_today_date",
    );
    let counter =
      storedDate === today
        ? ((await this.ctx.storage.get<number>("dispatches_today")) ?? 0)
        : 0;
    const cap = this.testDailyCap ?? this.config.dailyCap;
    if (counter >= cap) {
      console.warn(
        `dispatch ${dispatchId} rate-limited (cap=${cap}); current=${fromState}`,
      );
      // Cap-cleanup MCP calls also flow through attemptWithBackoff so a
      // Metriq blip during cleanup contributes to the same streak. Failures
      // here are non-fatal for the cap path (the ticket is just left where it
      // was; sweeper will reclaim) — log and continue, preserving the existing
      // behavior that swallowed cleanup errors.
      const cmt = await this.attemptWithBackoff(
        () =>
          client.postAgentComment({
            itemId,
            note: "rate-limited; retry tomorrow",
          }),
        "post_agent_comment (rate-limit)",
        { armAlarmOnFailure: false },
      );
      if (cmt.ok && fromState !== "backlog") {
        await this.attemptWithBackoff(
          () =>
            client.moveItem({ itemId, fromState, toState: "backlog" }),
          "move_item (rate-limit cleanup)",
          { armAlarmOnFailure: false },
        );
      }
      return "poll";
    }
    await this.ctx.storage.put("dispatches_today", counter + 1);
    await this.ctx.storage.put("dispatches_today_date", today);

    // Ensure ticket is in in_progress before container boot.
    if (fromState !== "in_progress") {
      const moveAttempt = await this.attemptWithBackoff(
        () =>
          client.moveItem({
            itemId,
            fromState,
            toState: "in_progress",
          }),
        "move_item (→ in_progress)",
      );
      if (!moveAttempt.ok) return "none";
    }

    // Fire the container WITHOUT awaiting the job: POST /start spawns the
    // entrypoint child and returns 202 immediately. The agent's work then runs
    // independently in the container; the MONITORING phase polls /status for
    // its outcome. This decoupling keeps every alarm invocation well short of
    // the 15-min DO wall-clock ceiling.
    // Resolve the per-dispatch model + provenance (ADR-002). The resolved value
    // rides the POST /start BODY — the per-dispatch command channel (UC-1) — not
    // ContainerEnv. ticketModel is the per-ticket override (precedence level 1);
    // resolveModel falls through to the operator/hardcoded default when it's
    // absent/blank/unknown (ADR-003 fail-safe; never throws).
    const defaultModel = this.testAgentModelDefault ?? this.config.agentModelDefault;
    const defaultIsFromSecret =
      this.testAgentModelDefault !== undefined ||
      this.config.agentModelDefaultIsFromSecret;
    let resolved = resolveModel({
      ticketModel,
      defaultModel,
      defaultIsFromSecret,
      allowList: this.config.modelAllowList,
    });
    // Fail-safe logging (ADR-003): a ticket asked for a model the allow-list
    // rejected. resolveModel already returned the safe default (so `resolved.model`
    // — never the raw value — rides the /start body); surface the rejection so an
    // operator can see it. Keep resolveModel pure: the warn lives at the call site.
    if (ticketModel?.trim() && resolved.source !== "ticket") {
      console.warn(
        `dispatch ${dispatchId}: unknown model "${ticketModel}" not on allow-list; fell back to ${resolved.model} (source=${resolved.source})`,
      );
    }

    // Escalate-once consume (Phase 2 / Slice E / ADR-008 §3-4). If a prior OSS
    // dispatch of THIS work item failed, an escalation intent was recorded
    // (monitorDispatch). On this (later, separate) delivery, coerce the resolved
    // model to the Claude floor — so resolveHarness derives "claude" — set
    // fallbackOf for the cost back-link (ADR-007/KPI-6), and CONSUME (delete) the
    // intent so a Claude-rescue failure does NOT re-escalate (escalate-once, no
    // loop). When no intent exists this is a no-op and the resolved value rides
    // unchanged — the no-strand dispatch path is untouched.
    let fallbackOf: string | null = null;
    const esc = await this.consumeEscalationIntent(itemId);
    if (esc) {
      resolved = {
        model: this.config.agentModelDefault,
        source: "hardcoded-default",
      } satisfies ResolvedModel;
      fallbackOf = esc.failedDispatchId;
    }

    // Harness selection (Phase 2 / Slice D / ADR-005). Derive the harness from
    // the resolved model id (anthropic/* → claude, else opencode). Carried in
    // the /start body so entrypoint.sh branches on it. resolveHarness is pure +
    // total (never throws) — mirrors resolveModel's fail-safe discipline.
    const harness = resolveHarness(resolved.model);

    // Mint the per-dispatch cost-attribution tags (ADR-004 + ADR-007, KPI-1/6).
    // Every value is DO-minted / allow-list-validated — no external free-text
    // (injection guard). Phase 2 adds the harness + fallback_of dimensions
    // (ADR-007).
    const shortId = dispatchId.slice(0, SHORT_ID_CHARS);
    const costTags = buildCostAttributionTags({
      dispatchId,
      workItemId: itemId,
      shortId,
      resolved,
      harness,
      fallbackOf,
    });
    const containerBody = JSON.stringify({
      work_item_id: itemId,
      dispatch_id: dispatchId,
      title,
      description,
      short_id: shortId,
      model: resolved.model,
      source: resolved.source,
      harness,
      cost_tags: costTags,
    });
    try {
      const res = await this.startContainer(dispatchId, containerBody);
      if (res.status !== 202) {
        console.error(
          `dispatch ${dispatchId} /start returned ${res.status}; sweeper will reclaim`,
        );
        return "poll";
      }
    } catch (err) {
      // Container fail-to-boot. Per design § 169: back off 60s, alert, re-arm.
      await this.handleContainerBootFailure(dispatchId, err);
      return "none";
    }

    // Only now record the in-flight dispatch — a boot failure above must not
    // leave a phantom MONITORING state behind. The harness rides the record so
    // monitorDispatch can decide whether a failure escalates (ADR-008 §3).
    const dispatch: CurrentDispatch = {
      dispatchId,
      workItemId: itemId,
      startedAt: Date.now(),
      title,
      harness,
      model: resolved.model,
      costTags,
    };
    await this.ctx.storage.put("currentDispatch", dispatch);
    return "monitor";
  }

  /**
   * MONITORING phase: poll the in-flight container's `/status` and act on the
   * outcome. Always short-lived — re-arms a fast status poll while the job runs
   * and only finalizes (or abandons) when the container is done/failed/unknown
   * or the watchdog trips.
   */
  private async monitorDispatch(current: CurrentDispatch): Promise<void> {
    const { dispatchId, startedAt } = current;
    const maxMs = this.testContainerTimeoutMs ?? this.config.containerTimeoutMs;
    let keepMonitoring = false;
    try {
      const status = await this.pollContainerStatus(dispatchId);
      switch (status.status) {
        case "running":
          if (Date.now() - startedAt > maxMs) {
            console.error(
              `dispatch ${dispatchId} exceeded max wall-clock (${maxMs}ms); abandoning; sweeper will reclaim`,
            );
            // Watchdog: OpenCode hung/overran — an OSS failure (ADR-008 §1).
            await this.maybeEscalate(current);
            await this.ctx.storage.delete("currentDispatch");
          } else {
            keepMonitoring = true;
          }
          break;
        case "done":
          await this.finalizeDispatch(current, status.stdoutTail);
          await this.ctx.storage.delete("currentDispatch");
          break;
        case "failed": {
          const bodyExcerpt = status.bodyTail.slice(0, CONTAINER_LOG_BYTES);
          console.error(
            `dispatch ${dispatchId} container failed: code=${status.code}; sweeper will reclaim; body=${bodyExcerpt}`,
          );
          // OSS failure (non-zero exit — incl. a missing OSS key or LiteLLM
          // being down, ADR-006/008 §1): record the escalation intent before
          // releasing the ticket so the next delivery runs Claude.
          await this.maybeEscalate(current);
          await this.ctx.storage.delete("currentDispatch");
          break;
        }
        case "unknown":
          // The container has no record of this dispatch — it restarted and
          // lost its in-memory job. Treat as terminal; sweeper reclaims.
          console.error(
            `dispatch ${dispatchId} container status unknown (restarted/lost job); sweeper will reclaim`,
          );
          await this.maybeEscalate(current);
          await this.ctx.storage.delete("currentDispatch");
          break;
      }
    } catch (err) {
      // Transient: container re-booting or a transport blip. Keep monitoring
      // and retry next poll — unless we've blown past the watchdog.
      console.warn(
        `dispatch ${dispatchId} status poll failed (will retry): ${err instanceof Error ? err.message : err}`,
      );
      if (Date.now() - startedAt > maxMs) {
        console.error(
          `dispatch ${dispatchId} exceeded max wall-clock during status failures; abandoning`,
        );
        await this.maybeEscalate(current);
        await this.ctx.storage.delete("currentDispatch");
      } else {
        keepMonitoring = true;
      }
    } finally {
      if (keepMonitoring) await this.scheduleMonitorPoll();
      else await this.scheduleNextPoll();
    }
  }

  /**
   * Production seam (Phase 2 / Slice E / ADR-008 §3): on a terminal OSS-dispatch
   * failure, record an escalation intent so the ticket's NEXT delivery runs
   * Claude. Purely additive bookkeeping beside the existing
   * `delete("currentDispatch")` — it NEVER short-circuits the no-strand path.
   *
   * Only an OpenCode failure escalates (ADR-008 §3 OSS-only guard). A Claude
   * failure (incl. a Claude rescue that also fails) falls through to today's
   * terminal handling — no escalation, no loop.
   */
  private async maybeEscalate(current: CurrentDispatch): Promise<void> {
    if (current.harness !== "opencode") return;
    await this.recordEscalationIntent(current);
  }

  /**
   * Persist a work_item_id-keyed escalation intent in DO storage (ADR-008 §2).
   * Idempotent: a second terminal failure of the same work item (e.g. multiple
   * monitor branches firing across re-deliveries) does NOT overwrite an existing
   * intent — the FIRST failed OSS dispatch_id is the canonical fallback_of link
   * (ADR-007). The intent survives to the ticket's next, separate delivery, where
   * consumeEscalationIntent applies it. Caller (maybeEscalate) has already
   * enforced harness===opencode, so failedHarness is statically "opencode".
   */
  private async recordEscalationIntent(current: CurrentDispatch): Promise<void> {
    const key = escalationKey(current.workItemId);
    const existing = await this.ctx.storage.get<EscalationIntent>(key);
    if (existing) return;
    const intent: EscalationIntent = {
      failedDispatchId: current.dispatchId,
      // Review D4: KPI-6's bake-off joins on failedModel, so it must be the REAL
      // OSS model id — never "". Derive from the authoritative source: the
      // dispatch's resolved model, falling back to the model carried in the
      // DO-minted cost tags (set at startDispatch for every OSS dispatch). The
      // empty string can only surface if BOTH are absent — an impossible state
      // for an opencode dispatch (maybeEscalate already gated harness===opencode,
      // which is derived from a non-empty, non-anthropic model id).
      failedModel: this.failedModelOf(current),
      failedHarness: "opencode",
      recordedAt: Date.now(),
    };
    await this.ctx.storage.put(key, intent);
  }

  /**
   * Resolve the failed OSS model id for an escalation intent (review D4).
   * Authoritative order: the dispatch's resolved `model`, then the model carried
   * in the DO-minted cost tags. Both are set at startDispatch for OSS dispatches;
   * the `""` floor is unreachable for an opencode dispatch (harness is derived
   * from a non-empty model id) and exists only to keep the function total.
   */
  private failedModelOf(current: CurrentDispatch): string {
    return current.model ?? current.costTags?.model ?? "";
  }

  /**
   * Read AND consume (delete) the escalation intent for a work item — the
   * escalate-once guard (ADR-008 §3-4). Returns the intent when present (so
   * startDispatch coerces the model to the Claude floor + sets fallback_of),
   * else undefined. Consume-on-apply: once deleted, a later Claude-rescue
   * failure finds no intent and does not re-escalate (no loop).
   */
  private async consumeEscalationIntent(
    workItemId: string,
  ): Promise<EscalationIntent | undefined> {
    const key = escalationKey(workItemId);
    const esc = await this.ctx.storage.get<EscalationIntent>(key);
    if (esc) await this.ctx.storage.delete(key);
    return esc;
  }

  /**
   * Report the PR produced by a completed container and move the ticket to
   * done. Falls back to rescueOrphanedDispatch when Metriq can't accept the
   * report/move (claim superseded mid-work).
   */
  private async finalizeDispatch(
    current: CurrentDispatch,
    stdoutTail: string,
  ): Promise<void> {
    const { dispatchId, workItemId: itemId, title } = current;
    const client = this.mcpClient();
    const parsedUrl = parseLastUrl(stdoutTail);
    if (!parsedUrl) {
      // entrypoint exited 0 but printed no URL — shouldn't happen (set -e +
      // explicit PR echo), but treat as a failure so the sweeper reclaims.
      // For OpenCode this is the "empty PR / no edits" failure (US-04/05 Domain
      // Example 3) — an OSS failure that must escalate to Claude (ADR-008 §1).
      const bodyExcerpt = stdoutTail.slice(0, CONTAINER_LOG_BYTES);
      console.error(
        `dispatch ${dispatchId} container done but no URL in output; sweeper will reclaim; body=${bodyExcerpt}`,
      );
      await this.maybeEscalate(current);
      return;
    }

    const report = await this.withRetry("report_artifact", () =>
      client.reportArtifact({ itemId, url: parsedUrl, kind: "pr", title }),
    );
    if (report === null) {
      // Likely the claim was superseded mid-work (human reassigned the ticket,
      // sweeper reclaimed, another session jumped in). The PR exists; Metriq
      // just can't accept the report against this dispatch. Recover by posting
      // the URL as an agent_comment + filing a GitHub Issue.
      await this.rescueOrphanedDispatch({
        dispatchId,
        itemId,
        prUrl: parsedUrl,
        failureReason: "report-failed",
      });
      return;
    }

    const move = await this.withRetry("move_item", () =>
      client.moveItem({ itemId, fromState: "in_progress", toState: "done" }),
    );
    if (move === null) {
      // report_artifact succeeded so the PR is already attached to the ticket.
      // File a GitHub Issue so a human knows the ticket is stuck in in_progress.
      await this.rescueOrphanedDispatch({
        dispatchId,
        itemId,
        prUrl: parsedUrl,
        failureReason: "move-failed",
      });
      return;
    }

    console.log(
      `dispatch ${dispatchId} → done; blessingRequested=${move.blessingRequested ?? false}`,
    );
  }

  private async handleContainerBootFailure(
    dispatchId: string,
    err: unknown,
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`dispatch ${dispatchId} container fail-to-boot: ${msg}`);
    // Fire-and-log the GH-Issue notification; notifyViaGitHubIssue swallows
    // its own errors so the back-off path is never disturbed.
    const titleSuffix = msg
      .slice(0, ERROR_TITLE_CHARS)
      .replace(/\s+/g, " ")
      .trim();
    const ts = new Date().toISOString();
    await this.notifyViaGitHubIssue({
      logLabel: "issue creation",
      category: "container-fail",
      fingerprintInput: msg,
      build: (fp) => ({
        title: `container fail-to-boot: ${titleSuffix}`,
        createBody: [
          `Container failed to boot for dispatch \`${dispatchId}\`.`,
          ``,
          `**Error:** ${msg}`,
          ``,
          `**Timestamp:** ${ts}`,
          ``,
          `Auto-filed by \`handleContainerBootFailure\` in agent-loop.ts. The dispatch is back in Metriq's queue; the DO has rescheduled its alarm to retry on the next cycle.`,
          ``,
          `Future repeat occurrences will be added as comments on this issue (fingerprint match).`,
        ].join("\n"),
        commentBody: [
          `Repeat container fail-to-boot (fp:\`${fp}\`).`,
          ``,
          `- Dispatch: \`${dispatchId}\``,
          `- Timestamp: ${ts}`,
          `- Error: ${msg}`,
        ].join("\n"),
      }),
    });
    const backoffMs =
      this.testContainerBootBackoffMs ?? this.config.containerBootBackoffMs;
    await this.ctx.storage.setAlarm(Date.now() + backoffMs);
  }

  /**
   * Called when a dispatch's container produced a PR but `report_artifact`
   * or `move_item` failed (likely because the claim was superseded by a
   * manual reassign, sweeper reclaim, etc.). The PR exists on GitHub; we
   * just couldn't tell Metriq about it cleanly. Recovery:
   *
   * 1. If `report_artifact` failed: post the PR URL as an `agent_comment`
   *    on the work item. agent_comment is identity-scoped (not dispatch-
   *    scoped), so it works even when the claim is invalid.
   * 2. Always: file/comment on a GitHub Issue so a human sees the orphan.
   */
  private async rescueOrphanedDispatch(opts: {
    dispatchId: string;
    itemId: string;
    prUrl: string;
    failureReason: "report-failed" | "move-failed";
  }): Promise<void> {
    const { dispatchId, itemId, prUrl, failureReason } = opts;
    console.warn(
      `[rescue] dispatch ${dispatchId} produced ${prUrl} but ${failureReason}; posting comment + filing GH issue`,
    );

    if (failureReason === "report-failed") {
      try {
        const v = await this.mcpClient().postAgentComment({
          itemId,
          note: `Agent completed but report_artifact failed (likely superseded claim). PR: ${prUrl}`,
        });
        await this.resetMcpFailureCount();
        void v;
      } catch (err) {
        // Counter bump but no alarm-arming — rescue is a best-effort
        // recovery path; the GH issue below still files so a human can act.
        await this.bumpMcpFailureCount();
        console.error(
          `[rescue] post_agent_comment fallback failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const ts = new Date().toISOString();
    await this.notifyViaGitHubIssue({
      logLabel: "orphan issue",
      category: "orphaned-dispatch",
      // Fingerprint on the failure stage so report-failed and move-failed
      // group into separate issues (they need different operator actions).
      fingerprintInput: `orphaned ${failureReason} for item ${itemId}`,
      build: (fp) => ({
        title: `orphaned dispatch: ${failureReason} (${itemId.slice(0, SHORT_ID_CHARS)})`,
        createBody: [
          `Dispatch \`${dispatchId}\` produced a PR but Metriq couldn't finalize.`,
          ``,
          `**Work item:** \`${itemId}\``,
          `**PR:** ${prUrl}`,
          `**Failure stage:** \`${failureReason}\``,
          `**Timestamp:** ${ts}`,
          ``,
          `Likely cause: the agent's claim on this dispatch was superseded mid-work (manual reassign, sweeper reclaim, etc.). The PR exists; only the Metriq-side bookkeeping is incomplete.`,
          ``,
          `**Recovery:** open the PR, verify it looks correct, then attach the artifact + move the ticket to done in Metriq manually. The agent posted a comment with the PR URL on the work item itself (\`report-failed\` case only).`,
          ``,
          `Future repeat orphans for the same failure stage will be added as comments here.`,
        ].join("\n"),
        commentBody: [
          `Repeat orphaned dispatch (fp:\`${fp}\`).`,
          ``,
          `- Dispatch: \`${dispatchId}\``,
          `- Work item: \`${itemId}\``,
          `- PR: ${prUrl}`,
          `- Failure stage: \`${failureReason}\``,
          `- Timestamp: ${ts}`,
        ].join("\n"),
      }),
    });
  }

  /**
   * Common shape for GH-Issue notifications: resolve PAT, default the
   * repo, fingerprint, then file/comment via the dedupe helper. Each
   * caller supplies a `build(fp)` callback so it can interpolate the
   * fingerprint into its own title/body strings.
   */
  private async notifyViaGitHubIssue(opts: {
    logLabel: string;
    category: string;
    fingerprintInput: string;
    build: (fp: string) => {
      title: string;
      createBody: string;
      commentBody: string;
    };
  }): Promise<void> {
    const pat = this.config.githubPat;
    if (!pat) {
      console.warn(`[notify] no GITHUB_PAT — skipping ${opts.logLabel}`);
      return;
    }
    const repo = this.config.alertGitHubRepo;
    if (!repo) {
      console.warn(
        `[notify] no ALERT_GITHUB_REPO / TARGET_REPO — skipping ${opts.logLabel}`,
      );
      return;
    }
    const fp = await fingerprintError(opts.fingerprintInput);
    const { title, createBody, commentBody } = opts.build(fp);
    await this.fileOrCommentGitHubIssue({
      pat,
      repo,
      category: opts.category,
      fingerprint: fp,
      title,
      createBody,
      commentBody,
    });
  }

  /**
   * Shared "file new issue OR comment on existing if fingerprint matches"
   * helper. GitHub search has up to ~60s eventual consistency, so two
   * near-simultaneous failures may both miss the search and file duplicates.
   * Acceptable — manual dedupe later beats engineering a strict locking
   * primitive.
   */
  private async fileOrCommentGitHubIssue(opts: {
    pat: string;
    repo: string;
    category: string;
    fingerprint: string;
    title: string;
    createBody: string;
    commentBody: string;
  }): Promise<void> {
    const {
      pat,
      repo,
      category,
      fingerprint: fp,
      title,
      createBody,
      commentBody,
    } = opts;

    const headers = {
      authorization: `Bearer ${pat}`,
      accept: "application/vnd.github+json",
      "user-agent": "metriq-cloudflare-agent",
    };

    try {
      const query = `repo:${repo} is:issue is:open label:${category} [fp:${fp}]`;
      const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`;
      const searchRes = await fetch(searchUrl, { headers });

      let existingNumber: number | null = null;
      if (searchRes.ok) {
        const json = (await searchRes.json()) as {
          items?: Array<{ number: number }>;
        };
        existingNumber =
          json.items && json.items.length > 0 ? json.items[0]!.number : null;
      } else {
        const tail = await searchRes.text().catch(() => "");
        console.warn(
          `[notify] search failed (${searchRes.status}); will create new: ${tail.slice(0, ERROR_TAIL_CHARS)}`,
        );
      }

      if (existingNumber !== null) {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/issues/${existingNumber}/comments`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ body: commentBody }),
          },
        );
        if (!res.ok) {
          const tail = await res.text().catch(() => "");
          console.error(
            `[notify] comment failed: ${res.status} ${tail.slice(0, ERROR_TAIL_CHARS)}`,
          );
        }
      } else {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/issues`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              title: `${title} [fp:${fp}]`,
              body: createBody,
              labels: ["auto-filed", category],
            }),
          },
        );
        if (!res.ok) {
          const tail = await res.text().catch(() => "");
          console.error(
            `[notify] issue create failed: ${res.status} ${tail.slice(0, ERROR_TAIL_CHARS)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[notify] GitHub call threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private containerStub(dispatchId: string): DurableObjectStub {
    return this.env.AGENT_CONTAINER.get(
      this.env.AGENT_CONTAINER.idFromName(dispatchId),
    );
  }

  /**
   * Fire `POST /start` and return only its (fast) HTTP status. A throw here is
   * a container fail-to-boot (the stub couldn't be reached / started); the
   * caller routes it to handleContainerBootFailure.
   */
  private async startContainer(
    dispatchId: string,
    body: string,
  ): Promise<{ status: number }> {
    if (this.testContainerStart) {
      // Awaiting here keeps any rejection inside this async function frame so
      // it's caught by the caller's try/catch, not surfaced as unhandled.
      return await this.testContainerStart(dispatchId, body);
    }
    const res = await this.containerStub(dispatchId).fetch(
      "http://container/start",
      { method: "POST", body },
    );
    return { status: res.status };
  }

  /**
   * Poll `GET /status`. A non-2xx from the status endpoint itself (as opposed
   * to a job-level `failed`) is treated as transient and thrown, so the monitor
   * retries on the next poll rather than abandoning the dispatch.
   */
  private async pollContainerStatus(
    dispatchId: string,
  ): Promise<ContainerStatus> {
    if (this.testContainerStatus) {
      return await this.testContainerStatus(dispatchId);
    }
    const res = await this.containerStub(dispatchId).fetch(
      `http://container/status?dispatch_id=${encodeURIComponent(dispatchId)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`status endpoint returned ${res.status}`);
    }
    return (await res.json()) as ContainerStatus;
  }

  /**
   * Two-attempt retry with a fixed delay between, used by finalizeDispatch for
   * its terminal report_artifact / move_item calls (a transient blip here must
   * not strand the PR; if both attempts fail, the caller falls through to the
   * rescue path which posts a comment + files a GH issue).
   *
   * Threading the MCP-failure counter: every catch BUMPS, every success RESETS
   * — same discipline as `attemptWithBackoff` so a Metriq blip during finalize
   * still contributes to the streak for the next IDLE poll. The retry itself
   * stays in-iteration (not via an alarm) because finalize is a single
   * dispatch's tail; the dispatch's container is gone, there's no other work
   * the alarm could do while waiting.
   */
  private async withRetry<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const delayMs = this.config.retryDelayMs;
    try {
      const v = await fn();
      await this.resetMcpFailureCount();
      return v;
    } catch (err1) {
      await this.bumpMcpFailureCount();
      console.warn(
        `${label} failed (will retry in ${delayMs}ms): ${err1 instanceof Error ? err1.message : err1}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const v = await fn();
        await this.resetMcpFailureCount();
        return v;
      } catch (err2) {
        await this.bumpMcpFailureCount();
        console.error(
          `${label} failed second time, bailing: ${err2 instanceof Error ? err2.message : err2}`,
        );
        return null;
      }
    }
  }

  private async stop(): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>("sessionId");
    if (sessionId) {
      // Wrap in attemptWithBackoff for streak bookkeeping (a stop racing a
      // server outage should still tick the counter and contribute to the
      // next iteration's backoff if the user reopens). DON'T arm an alarm on
      // failure — `/stop` is a shutdown; re-entering the loop defeats it.
      await this.attemptWithBackoff(
        () => this.mcpClient().endAgentSession({ sessionId }),
        "end_agent_session",
        { armAlarmOnFailure: false },
      );
      await this.ctx.storage.delete("sessionId");
    }
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Used by the /wake fetch endpoint (NOT the alarm loop — the alarm loop's
   * pollForWork has its own session bootstrap that threads through
   * attemptWithBackoff). Threads the MCP-failure counter so a register call
   * triggered by /wake also contributes to / clears the streak.
   */
  private async ensureRegistered(): Promise<string> {
    const existing = await this.ctx.storage.get<string>("sessionId");
    if (existing) return existing;
    const client = this.mcpClient();
    try {
      const { sessionId } = await client.registerAgentSession({
        clientId: CLIENT_ID,
      });
      await this.resetMcpFailureCount();
      await this.ctx.storage.put("sessionId", sessionId);
      return sessionId;
    } catch (err) {
      await this.bumpMcpFailureCount();
      throw err;
    }
  }

  private async ensureAlarmScheduled(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.scheduleNextPoll();
    }
  }

  /**
   * Schedule the next alarm fire. We add a small fixed offset rather than
   * `Date.now()` because workerd auto-fires alarms by wall clock, and
   * `Date.now()` becomes an unkillable tight loop in tests where
   * `wait_for_assignment` is mocked to return immediately — the alarm body
   * keeps re-arming itself faster than the test runner can pop isolated
   * storage. In production the server-side long poll (up to 25s) supplies
   * the real cadence; the offset is invisible by comparison.
   */
  private async scheduleNextPoll(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + POLL_REARM_DELAY_MS);
  }

  /**
   * Re-arm the MONITORING-phase status poll. Cadence stays well under the
   * container's `sleepAfter` so each poll resets its idle timer and keeps the
   * in-flight job's container awake.
   */
  private async scheduleMonitorPoll(): Promise<void> {
    const delay = this.testMonitorPollMs ?? this.config.monitorPollMs;
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private mcpClient(): McpClient {
    return new McpClient({
      mcpUrl: this.config.mcpUrl,
      apiKey: this.config.mcpApiKey,
    });
  }
}
