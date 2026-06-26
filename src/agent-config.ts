/**
 * Centralized tuning knobs. Every env-string lookup with a numeric default
 * lives here so production defaults are one-line-changes and the call sites
 * don't have to keep parsing the same string. Test overrides remain on the
 * DO itself (they're a vitest hack, not config).
 */
export interface AgentConfigEnv {
  METRIQ_API_KEY: string;
  METRIQ_MCP_URL: string;
  GITHUB_PAT?: string;
  ALERT_GITHUB_REPO?: string;
  // Deploy-time constant: the repo the agent clones + opens PRs against
  // (owner/name). Used as the fallback alert target when ALERT_GITHUB_REPO is
  // unset. No hardcoded owner default — if BOTH are unset, alerts can't be
  // filed (alertGitHubRepo is undefined; the notify path skips filing).
  TARGET_REPO?: string;
  DAILY_CAP?: string;
  RETRY_DELAY_MS?: string;
  CONTAINER_TIMEOUT_MS?: string;
  CONTAINER_BOOT_BACKOFF_MS?: string;
  MONITOR_POLL_MS?: string;
  // ADR-002: fleet default model id.
  // Unset ⇒ the hardcoded Claude default (the precedence floor).
  AGENT_MODEL_DEFAULT?: string;
  /**
   * Operator kill-switch (`wrangler secret put AGENT_PAUSED=true`). When truthy
   * (string "true"/"1"/"yes", case-insensitive), `pollForWork` short-circuits
   * BEFORE the MCP call and re-arms a long alarm — the one-secret incident
   * pause. Distinct from the in-DO `/pause` storage flag (which is
   * operator-triggered via an HTTP endpoint, scoped to a single DO instance);
   * AGENT_PAUSED is the deploy-time, fleet-wide kill-switch.
   */
  AGENT_PAUSED?: string;
}

const DEFAULT_DAILY_CAP = 5;
const DEFAULT_RETRY_DELAY_MS = 5000;
// Re-arm cadence when AGENT_PAUSED is set. Long enough to keep the loop
// effectively dormant while still picking up a `wrangler secret put AGENT_PAUSED=false`
// within ~1 minute (no manual /resume needed for an env-driven pause).
const DEFAULT_PAUSED_REARM_DELAY_MS = 60 * 1000;
// Watchdog: max wall-clock a single dispatch may run before the monitor
// abandons it. Enforced across short status polls (now − startedAt), NOT as a
// blocking timeout — so it may safely exceed the 15-min DO alarm ceiling.
const DEFAULT_CONTAINER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_CONTAINER_BOOT_BACKOFF_MS = 60 * 1000; // 1 min
// Monitor-phase re-arm cadence. Must stay well under the container's
// `sleepAfter` (10 min) so each poll resets its idle timer and keeps it awake.
const DEFAULT_MONITOR_POLL_MS = 15 * 1000; // 15 s
// ADR-002, ADR-003: the hardcoded Claude default (precedence floor) and the
// model allow-list (cost + injection guard). Single named constants — no
// scattered magic strings. The SHAPE (a Claude floor + an allow-list
// containing it) is the contract.
//
// The allow-list admits Claude ids and, ADDITIVELY (ADR-006), operator-chosen
// OSS provider/model ids — each a fixed, shell-safe
// `provider/model` token (allow-list membership IS sanitization, ADR-003/006).
// An allow-listed non-anthropic id routes the dispatch to OpenCode
// (resolveHarness, ADR-005). The Claude floor + Claude ids are unchanged, so
// the fail-safe default remains Claude. resolveModel is UNCHANGED.
// "anthropic/opus" uses the CLI's always-latest shortcut shape: after the
// container's entrypoint strips the `anthropic/` provider prefix at the CLI
// boundary, the Anthropic `claude` CLI receives `opus` — a shortcut it
// guarantees to accept across CLI versions (alongside `haiku` and `sonnet`).
// The versioned `anthropic/claude-opus-4` form would yield `claude-opus-4`
// post-strip, which the CLI rejects when that specific id is not enrolled
// (the production-2026-05-31 dispatch failure mode).
const HARDCODED_CLAUDE_DEFAULT = "anthropic/opus";
const MODEL_ALLOW_LIST: readonly string[] = [
  // Claude — CLI always-latest shortcuts (haiku/sonnet/opus). After
  // entrypoint.sh strips the `anthropic/` prefix at the CLI boundary, these
  // become `haiku` / `sonnet` / `opus` — the shortcuts the Anthropic CLI
  // guarantees to accept across versions. `opus` is the default + fallback
  // floor (HARDCODED_CLAUDE_DEFAULT).
  "anthropic/haiku",
  "anthropic/sonnet",
  "anthropic/opus",
  // Claude — versioned ids (retained additively). May resolve
  // correctly for some CLI versions; the shortcuts above are the bulletproof
  // path. Kept so a deliberate operator choice of a pinned version still
  // passes allow-list membership.
  "anthropic/claude-opus-4",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-haiku-4",
  // OSS ids (ADR-006, additive) — route to OpenCode via the OSS
  // backend (LiteLLM by default). Operator-curated.
  "deepseek/deepseek-v3",
  "deepseek/deepseek-v3.2",
];

export class AgentConfig {
  readonly dailyCap: number;
  readonly retryDelayMs: number;
  readonly containerTimeoutMs: number;
  readonly containerBootBackoffMs: number;
  readonly monitorPollMs: number;
  /**
   * Repo to file failure alerts against. Derived as
   * `ALERT_GITHUB_REPO ?? TARGET_REPO` — no hardcoded owner default. When BOTH
   * are unset this is undefined and the notify path skips filing (acceptable).
   */
  readonly alertGitHubRepo: string | undefined;
  readonly githubPat: string | undefined;
  readonly mcpUrl: string;
  readonly mcpApiKey: string;
  /** Operator kill-switch: when true, pollForWork short-circuits before any MCP call. */
  readonly agentPaused: boolean;
  /** Re-arm delay used when AGENT_PAUSED is active. */
  readonly pausedRearmDelayMs: number;
  // Resolved model-selection config.
  /** Fleet default model id. env.AGENT_MODEL_DEFAULT ?? hardcoded Claude floor. */
  readonly agentModelDefault: string;
  /** True when AGENT_MODEL_DEFAULT was set (distinguishes the two non-ticket sources). */
  readonly agentModelDefaultIsFromSecret: boolean;
  /** The hardcoded Claude default (the precedence floor). */
  readonly hardcodedClaudeDefault: string;
  /** Allow-list of accepted model ids (cost + injection guard, ADR-003). */
  readonly modelAllowList: readonly string[];

  constructor(env: AgentConfigEnv) {
    this.dailyCap = parseIntOr(env.DAILY_CAP, DEFAULT_DAILY_CAP);
    this.retryDelayMs = parseIntOr(env.RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS);
    this.containerTimeoutMs = parseIntOr(
      env.CONTAINER_TIMEOUT_MS,
      DEFAULT_CONTAINER_TIMEOUT_MS,
    );
    this.containerBootBackoffMs = parseIntOr(
      env.CONTAINER_BOOT_BACKOFF_MS,
      DEFAULT_CONTAINER_BOOT_BACKOFF_MS,
    );
    this.monitorPollMs = parseIntOr(
      env.MONITOR_POLL_MS,
      DEFAULT_MONITOR_POLL_MS,
    );
    this.alertGitHubRepo = env.ALERT_GITHUB_REPO ?? env.TARGET_REPO;
    this.githubPat = env.GITHUB_PAT;
    this.mcpUrl = env.METRIQ_MCP_URL;
    this.mcpApiKey = env.METRIQ_API_KEY;
    this.agentPaused = parseBool(env.AGENT_PAUSED);
    this.pausedRearmDelayMs = DEFAULT_PAUSED_REARM_DELAY_MS;
    // ADR-002: typed-default pattern.
    this.hardcodedClaudeDefault = HARDCODED_CLAUDE_DEFAULT;
    this.modelAllowList = MODEL_ALLOW_LIST;
    this.agentModelDefaultIsFromSecret = env.AGENT_MODEL_DEFAULT !== undefined;
    this.agentModelDefault =
      env.AGENT_MODEL_DEFAULT ?? HARDCODED_CLAUDE_DEFAULT;
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Permissive truthy parser for boolean-shaped secrets. Accepts "true"/"1"/"yes"
 * (case-insensitive); everything else (incl. undefined, "", "false", "0") is
 * false. Operator-friendly: `wrangler secret put AGENT_PAUSED=true` works, and
 * a typo can never accidentally pause the fleet.
 */
function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Bounded exponential backoff with equal jitter.
 *
 * MIRROR (verbatim shape) of the upstream Metriq agent reference runtime.
 * Same signature, same semantics: the agent and the server speak
 * the same backoff vocabulary.
 *
 *   delay = clamp(baseMs * 2^(failureCount-1), <= maxMs)
 *   return floor(delay/2 + rng() * delay/2)   // [delay/2, delay) — always > 0
 *
 * `failureCount` is 1-indexed: 1 for the first consecutive failure. Equal
 * jitter (half fixed + half random) keeps a guaranteed minimum wait so the
 * floor can never decay to an instant re-poll, while the random half
 * de-synchronizes a fleet of agents recovering from the same outage. `rng`
 * is injectable for tests (default `Math.random`).
 *
 * Retry-After honoring is the AGENT-SIDE extension and lives at the call site
 * (`attemptWithBackoff` in agent-loop.ts), NOT here — keeping this helper
 * byte-equivalent to the Metriq reference.
 */
export function computeBackoffMs(
  failureCount: number,
  opts: { baseMs?: number; maxMs?: number; rng?: () => number } = {},
): number {
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 30_000;
  const rng = opts.rng ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** (failureCount - 1));
  const half = exponential / 2;
  return Math.floor(half + rng() * half);
}

/** Default cap for any backoff (server-hinted or computed). Mirrors the reference. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Default base for the exponential backoff. Mirrors the reference. */
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
