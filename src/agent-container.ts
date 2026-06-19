import { Container } from "@cloudflare/containers";

interface ContainerEnv {
  GITHUB_PAT: string;
  GITHUB_USER: string;
  ANTHROPIC_API_KEY: string;
  // open-source-llm Slice A / ADR-001: per-DO-instance CONSTANTS.
  // ANTHROPIC_BASE_URL points Claude Code at the AI Gateway Anthropic endpoint;
  // AI_GATEWAY_TOKEN (optional) becomes cf-aig-authorization. These belong in
  // ContainerEnv (constant lifetime) — NOT the per-dispatch /start body (UC-1).
  // The Claude path uses these (CF gateway). The OSS path does NOT (Decision B).
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  // open-source-llm Phase 2 / Slice D / ADR-006: per-DO-instance CONSTANTS for
  // the OSS path (provider-agnostic OpenAI-compatible endpoint, LiteLLM by
  // default). OpenCode dials OSS_MODEL_BASE_URL with OSS_MODEL_API_KEY (written
  // into the dispatch-time opencode.json, ADR-005). OSS_MODEL_API_KEY is
  // forwarded ONLY-WHEN-SET (like AI_GATEWAY_TOKEN) so the OpenCode branch fails
  // fast → escalates when the key is absent (ADR-006/008). The OSS path carries
  // NO cf-aig headers and never the GITHUB_PAT (Decision B / ADR-006 §6).
  OSS_MODEL_BASE_URL?: string;
  OSS_MODEL_API_KEY?: string;
  // Deploy-time constants: which repo the agent clones + opens PRs against.
  // TARGET_REPO is "owner/name" (e.g. "acme/widgets") and is REQUIRED
  // (entrypoint.sh fails fast when unset/empty). TARGET_BASE_BRANCH is the PR
  // base; it defaults to "main" in entrypoint.sh.
  TARGET_REPO?: string;
  TARGET_BASE_BRANCH?: string;
}

/**
 * Pure builder for the container constant-env forwarding map (Slice A, ADR-001).
 *
 * Worker secrets are NOT inherited by the container automatically — they must be
 * explicitly forwarded to AgentContainer.envVars. This forwards:
 *  - the three credential constants entrypoint.sh requires (GITHUB_PAT,
 *    GITHUB_USER, ANTHROPIC_API_KEY),
 *  - ANTHROPIC_BASE_URL when present (claude reads it to route via the AI
 *    Gateway Anthropic endpoint),
 *  - AI_GATEWAY_TOKEN ONLY when set. When unset the KEY is entirely ABSENT
 *    (not present-but-empty) so entrypoint.sh never assembles a broken
 *    `cf-aig-authorization: Bearer ` header.
 *
 * Per-dispatch values (model, cost_tags) do NOT belong here — they ride the
 * POST /start body (UC-1).
 */
export function buildContainerEnvVars(
  env: ContainerEnv,
): Record<string, string> {
  const vars: Record<string, string> = {
    GITHUB_PAT: env.GITHUB_PAT ?? "",
    GITHUB_USER: env.GITHUB_USER ?? "",
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? "",
    // open-source-llm Phase 2 / ADR-006: the OSS endpoint base URL is a constant
    // (empty default, like ANTHROPIC_BASE_URL). The OpenCode branch reads it to
    // build opencode.json's provider.options.baseURL.
    OSS_MODEL_BASE_URL: env.OSS_MODEL_BASE_URL ?? "",
    // Empty-string defaults so the shell always sees defined vars. TARGET_REPO
    // has NO owner fallback — entrypoint.sh treats empty as unset and fails fast
    // (TARGET_REPO is required). TARGET_BASE_BRANCH defaults to "main" there.
    TARGET_REPO: env.TARGET_REPO ?? "",
    TARGET_BASE_BRANCH: env.TARGET_BASE_BRANCH ?? "",
  };
  // Only attach AI_GATEWAY_TOKEN when actually set: membership of the key (not
  // an empty string) is the signal entrypoint.sh uses to add cf-aig-authorization.
  if (env.AI_GATEWAY_TOKEN) {
    vars.AI_GATEWAY_TOKEN = env.AI_GATEWAY_TOKEN;
  }
  // open-source-llm Phase 2 / ADR-006: forward OSS_MODEL_API_KEY ONLY-WHEN-SET.
  // Key-absent is the fail-fast signal the OpenCode branch uses (no key ⇒ exit
  // non-zero ⇒ escalate). Never present-but-empty.
  if (env.OSS_MODEL_API_KEY) {
    vars.OSS_MODEL_API_KEY = env.OSS_MODEL_API_KEY;
  }
  return vars;
}

export class AgentContainer extends Container<ContainerEnv> {
  override defaultPort = 8080;
  // The DO drives the container with POST /start then a ~15s GET /status poll
  // (see agent-loop.ts MONITORING phase). Each poll resets this idle timer, so
  // the container stays awake for the whole dispatch as long as the DO keeps
  // polling; sleepAfter only needs enough margin to survive a few missed polls
  // (and to reap the container shortly after the DO stops polling on
  // completion/abandonment). 10m is comfortably above the 15s poll cadence.
  override sleepAfter = "10m";

  constructor(
    ...args: ConstructorParameters<typeof Container<ContainerEnv>>
  ) {
    super(...args);
    // Worker secrets must be explicitly forwarded to the container; they are
    // NOT inherited automatically. entrypoint.sh requires the credentials plus
    // the AI Gateway constants (ANTHROPIC_BASE_URL, optional AI_GATEWAY_TOKEN).
    this.envVars = buildContainerEnvVars(args[1]);
  }
}
