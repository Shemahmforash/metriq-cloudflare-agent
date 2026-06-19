import { describe, expect, it } from "vitest";
import { AgentConfig, computeBackoffMs } from "../src/agent-config";

describe("AgentConfig", () => {
  // Required bindings every test needs; varying fields are layered on top.
  const REQUIRED = {
    METRIQ_API_KEY: "k",
    METRIQ_MCP_URL: "https://example.test/api/v1/mcp",
    GITHUB_PAT: "ghp_x",
  } as const;

  it("uses defaults when no overrides are set", () => {
    const cfg = new AgentConfig({ ...REQUIRED });
    expect(cfg.dailyCap).toBe(5);
    expect(cfg.retryDelayMs).toBe(5000);
    expect(cfg.containerTimeoutMs).toBe(1800000);
    expect(cfg.containerBootBackoffMs).toBe(60000);
    expect(cfg.monitorPollMs).toBe(15000);
    // No hardcoded owner default: with neither ALERT_GITHUB_REPO nor TARGET_REPO
    // set, the alert repo is undefined (alerts can't be filed — acceptable).
    expect(cfg.alertGitHubRepo).toBeUndefined();
  });

  it("derives the alert repo from TARGET_REPO when ALERT_GITHUB_REPO is unset", () => {
    const cfg = new AgentConfig({ ...REQUIRED, TARGET_REPO: "example/agent" });
    expect(cfg.alertGitHubRepo).toBe("example/agent");
  });

  it("prefers ALERT_GITHUB_REPO over TARGET_REPO when both are set", () => {
    const cfg = new AgentConfig({
      ...REQUIRED,
      ALERT_GITHUB_REPO: "example/alerts",
      TARGET_REPO: "example/target-repo",
    });
    expect(cfg.alertGitHubRepo).toBe("example/alerts");
  });

  it("parses string env overrides as integers", () => {
    const cfg = new AgentConfig({
      ...REQUIRED,
      DAILY_CAP: "10",
      RETRY_DELAY_MS: "250",
      CONTAINER_TIMEOUT_MS: "120000",
      CONTAINER_BOOT_BACKOFF_MS: "30000",
      MONITOR_POLL_MS: "5000",
    });
    expect(cfg.dailyCap).toBe(10);
    expect(cfg.retryDelayMs).toBe(250);
    expect(cfg.containerTimeoutMs).toBe(120000);
    expect(cfg.containerBootBackoffMs).toBe(30000);
    expect(cfg.monitorPollMs).toBe(5000);
  });

  it("falls back to the default when a numeric env value is non-numeric", () => {
    const cfg = new AgentConfig({
      ...REQUIRED,
      DAILY_CAP: "not-a-number",
    });
    expect(cfg.dailyCap).toBe(5);
  });

  it("uses ALERT_GITHUB_REPO override when present", () => {
    const cfg = new AgentConfig({
      ...REQUIRED,
      ALERT_GITHUB_REPO: "acme/observability",
    });
    expect(cfg.alertGitHubRepo).toBe("acme/observability");
  });

  it("passes through MCP credentials and GitHub PAT verbatim", () => {
    const cfg = new AgentConfig({
      ...REQUIRED,
      METRIQ_API_KEY: "secret-abc",
      METRIQ_MCP_URL: "https://other.test/mcp",
      GITHUB_PAT: "ghp_other",
    });
    expect(cfg.mcpApiKey).toBe("secret-abc");
    expect(cfg.mcpUrl).toBe("https://other.test/mcp");
    expect(cfg.githubPat).toBe("ghp_other");
  });

  it("exposes githubPat as undefined when env doesn't set it", () => {
    const cfg = new AgentConfig({
      METRIQ_API_KEY: "k",
      METRIQ_MCP_URL: "u",
    });
    expect(cfg.githubPat).toBeUndefined();
  });

  it("defaults agentPaused to false; parses truthy AGENT_PAUSED values", () => {
    expect(new AgentConfig({ ...REQUIRED }).agentPaused).toBe(false);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "true" }).agentPaused,
    ).toBe(true);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "TRUE" }).agentPaused,
    ).toBe(true);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "1" }).agentPaused,
    ).toBe(true);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "yes" }).agentPaused,
    ).toBe(true);
    // Falsy / typo-safe — only the explicit truthy set above paused the fleet.
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "false" }).agentPaused,
    ).toBe(false);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "" }).agentPaused,
    ).toBe(false);
    expect(
      new AgentConfig({ ...REQUIRED, AGENT_PAUSED: "no" }).agentPaused,
    ).toBe(false);
  });
});

// =============================================================================
// computeBackoffMs — mirrors the reference-runtime.ts @ 9fa1e236
// (the upstream reference runtime, function of the same name). Bounded exponential
// backoff with equal jitter:
//   delay = clamp(baseMs * 2^(failureCount-1), <= maxMs)
//   return floor(delay/2 + rng() * delay/2)   // [delay/2, delay)
// rng is injected for determinism.
// =============================================================================
describe("computeBackoffMs", () => {
  // rng=0 returns the FLOOR (delay/2 exactly) — the deterministic minimum.
  const RNG_FLOOR = () => 0;
  // rng≈1 returns ~delay-1 — the deterministic ceiling (just under delay).
  const RNG_CEILING = () => 0.9999999;

  it("at rng=0 returns the equal-jitter floor (delay/2) for each failureCount tier", () => {
    // Tier 1: delay = 1000, floor = 500.
    expect(computeBackoffMs(1, { rng: RNG_FLOOR })).toBe(500);
    // Tier 2: delay = 2000, floor = 1000.
    expect(computeBackoffMs(2, { rng: RNG_FLOOR })).toBe(1000);
    // Tier 3: delay = 4000, floor = 2000.
    expect(computeBackoffMs(3, { rng: RNG_FLOOR })).toBe(2000);
    // Tier 4: delay = 8000, floor = 4000.
    expect(computeBackoffMs(4, { rng: RNG_FLOOR })).toBe(4000);
    // Tier 5: delay = 16000, floor = 8000.
    expect(computeBackoffMs(5, { rng: RNG_FLOOR })).toBe(8000);
    // Tier 6: delay = 30000 (CAPPED — would be 32000), floor = 15000.
    expect(computeBackoffMs(6, { rng: RNG_FLOOR })).toBe(15000);
  });

  it("at rng=ceiling returns just under the full delay (equal-jitter ceiling)", () => {
    // Tier 1: delay = 1000. floor + 0.9999 * floor ≈ 999.
    expect(computeBackoffMs(1, { rng: RNG_CEILING })).toBe(999);
    // Tier 3: delay = 4000. floor + 0.9999 * floor ≈ 3999.
    expect(computeBackoffMs(3, { rng: RNG_CEILING })).toBe(3999);
    // Tier 6: delay = 30000 (cap). floor + 0.9999 * floor ≈ 29999.
    expect(computeBackoffMs(6, { rng: RNG_CEILING })).toBe(29999);
  });

  it("caps at the configured maxMs regardless of how many failures stack", () => {
    expect(computeBackoffMs(100, { rng: RNG_FLOOR })).toBe(15000); // floor of 30s cap
    expect(computeBackoffMs(10_000, { rng: RNG_FLOOR })).toBe(15000);
  });

  it("honors a custom maxMs/baseMs (the agent-side test override path)", () => {
    expect(
      computeBackoffMs(5, { baseMs: 100, maxMs: 1000, rng: RNG_FLOOR }),
    ).toBe(500); // floor of 1000ms cap
    expect(
      computeBackoffMs(1, { baseMs: 200, maxMs: 1000, rng: RNG_FLOOR }),
    ).toBe(100); // floor of 200ms tier
  });

  it("is deterministic when rng is fixed (proven across consecutive calls)", () => {
    const a = computeBackoffMs(3, { rng: RNG_FLOOR });
    const b = computeBackoffMs(3, { rng: RNG_FLOOR });
    expect(a).toBe(b);
    expect(a).toBe(2000);
  });
});
