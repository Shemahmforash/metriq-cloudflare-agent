/**
 * Pure model-resolution helper (ADR-002) + per-dispatch cost-attribution tag
 * builder (ADR-004) for the open-source-llm feature (Phase 1).
 *
 * Both functions are pure (no I/O); the DO calls them when minting a dispatch.
 * The resolved model travels in the per-dispatch POST /start body (DESIGN
 * upstream-changes UC-1), NOT in ContainerEnv.
 */

/** Provenance of the resolved model — logged as `source=<source>`. */
export type ModelSource = "ticket" | "AGENT_MODEL_DEFAULT" | "hardcoded-default";

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

/**
 * Decide the model + its provenance for one dispatch (pure; no I/O).
 * Precedence (ADR-002): ticket > AGENT_MODEL_DEFAULT > hardcoded Claude floor.
 *
 * - `ticketModel` present, non-blank, AND on `allowList` → { model: ticketModel, source: "ticket" }
 * - `ticketModel` present but NOT on the allow-list (unknown/garbage, ADR-003) → fall back to default
 * - `ticketModel` absent/blank/whitespace → use `defaultModel`
 * - `defaultModel` is AgentConfig.agentModelDefault (= env.AGENT_MODEL_DEFAULT ?? hardcodedDefault);
 *   source is "AGENT_MODEL_DEFAULT" when the secret was set, "hardcoded-default" otherwise.
 *
 * NEVER throws for any `string | undefined` ticketModel (ADR-003 fail-safe).
 */
export function resolveModel(args: {
  ticketModel: string | undefined;
  defaultModel: string;
  /** Whether `defaultModel` came from the AGENT_MODEL_DEFAULT secret (vs the hardcoded floor). */
  defaultIsFromSecret: boolean;
  allowList: readonly string[];
}): ResolvedModel {
  const requested = args.ticketModel?.trim() ?? "";
  if (requested !== "" && args.allowList.includes(requested)) {
    return { model: requested, source: "ticket" };
  }
  return {
    model: args.defaultModel,
    source: args.defaultIsFromSecret ? "AGENT_MODEL_DEFAULT" : "hardcoded-default",
  };
}

/** Which agentic harness runs a dispatch (ADR-005). */
export type Harness = "claude" | "opencode";

/**
 * Pure harness selection by model-prefix routing (ADR-005 Part A).
 *
 * `anthropic/*` → "claude" (the default + fallback floor); any other id
 * (OSS-shaped `provider/model`, malformed, or blank) → "opencode". The harness
 * is DERIVED from the resolved model — there is no operator flag (UC-2).
 * Deterministic and TOTAL: NEVER throws for any string (mirrors resolveModel's
 * fail-safe discipline). The escalation path (ADR-008) coerces the resolved
 * model to the Claude floor, so a rescue dispatch resolves to "claude" here.
 */
export function resolveHarness(model: string): Harness {
  return model.startsWith("anthropic/") ? "claude" : "opencode";
}

/**
 * cf-aig-metadata / LiteLLM-native cost-attribution tag object (ADR-004 +
 * ADR-007). All fields are DO-minted / allow-list-validated — no external
 * free-text enters the JSON (injection guard). Phase 2 (ADR-007) adds two
 * DO-minted dimensions and bumps `phase`:
 *  - `harness`     — which harness produced the request (resolveHarness output).
 *  - `fallback_of` — on a Claude rescue of a failed OSS attempt, the failed OSS
 *                    dispatch_id; `null` on a normal dispatch.
 *
 * The same object rides BOTH cost sources (Decision B): exported as
 * `cf-aig-metadata` on the Claude/CF-gateway path, and as `x-litellm-metadata`
 * on the OSS/LiteLLM path. Schema identical; destination differs by path.
 */
export interface CostAttributionTags {
  dispatch_id: string;
  work_item_id: string;
  short_id: string;
  model: string;
  source: ModelSource;
  harness: Harness;
  fallback_of: string | null;
  phase: string;
}

/**
 * Build the per-dispatch cost-attribution tag object that rides the /start body
 * (ADR-004 + ADR-007). Pure.
 *
 * The object shape is fixed to DO-minted / allow-listed fields — ticket
 * title/description never spread in (injection guard). Phase 2 adds the
 * DO-minted `harness` + `fallback_of` dimensions and bumps `phase` to "2".
 */
export function buildCostAttributionTags(args: {
  dispatchId: string;
  workItemId: string;
  shortId: string;
  resolved: ResolvedModel;
  harness: Harness;
  fallbackOf?: string | null;
}): CostAttributionTags {
  return {
    dispatch_id: args.dispatchId,
    work_item_id: args.workItemId,
    short_id: args.shortId,
    model: args.resolved.model,
    source: args.resolved.source,
    harness: args.harness,
    fallback_of: args.fallbackOf ?? null,
    phase: "2",
  };
}
