# Research: Feasibility of an Open-Source LLM as the Agent Model in metriq-cloudflare-agent

**Date**: 2026-05-27 | **Researcher**: (internal research pass) | **Confidence**: High (architecture/feasibility) / Medium (specific model figures, time-sensitive) | **Sources**: 13

> NOTE ON TIME-SENSITIVITY: Model capabilities, benchmark scores, and pricing in this document are accurate as of access date (2026-05-27) and change rapidly. Re-verify pricing/benchmarks before acting.

## Executive Summary

**Using an open-source LLM to drive this agent is feasible.** The swap point is narrow and well-isolated: the orchestration layer (the `MetriqAgentLoop` Durable Object and `AgentContainer`) is model-agnostic and never calls an LLM itself — the actual model call is a single `claude -p ...` line in `container/entrypoint.sh`, authenticated by a forwarded `ANTHROPIC_API_KEY`. Changing "the agent's model" therefore touches only `entrypoint.sh`, the container `Dockerfile`, and the Worker→container env-forwarding surface (`ContainerEnv` / `AgentConfig`).

On **capability**, the gap has narrowed sharply through 2025-2026. On the Aider polyglot diff-editing benchmark the strongest open-weight models (DeepSeek-V3.2, DeepSeek-R1) now match or exceed Claude Opus 4. On SWE-bench Verified — the better proxy for this system's autonomous "resolve a real issue and open a PR" loop — the best open-weight models (DeepSeek V4 ~80.6%, Kimi K2 ~80.2%, GLM-5, large Qwen3-Coder) sit roughly 7-9 points behind the proprietary frontier (GPT-5.5 ~88.7%, Claude Opus 4.7 ~87.6%). The honest read: top OSS is *competitive but not at parity* for autonomous PR quality, and that capability lives only in very large MoE models that must be reached through a **hosted inference provider**, not self-hosted in the 4 GiB one-shot Cloudflare Container.

On **the path**, the single most important constraint is that **Anthropic does not officially support driving Claude Code with non-Claude models** — its `ANTHROPIC_BASE_URL`/gateway support (Bedrock, Vertex, Foundry, LiteLLM) is built to route to *Claude*, and its model-discovery only surfaces models whose IDs start with `claude`/`anthropic`. Pointing Claude Code at an OSS model (via claude-code-router/LiteLLM) is a community-only pattern that inserts a third-party proxy into a path carrying real Git credentials — Anthropic explicitly disclaims LiteLLM and flags a recent credential-stealing CVE. The cleaner route is to swap the harness: **OpenCode** is a mature, MIT-licensed, provider-agnostic coding agent whose headless `opencode run --model provider/model --dangerously-skip-permissions "<task>"` is a near-drop-in replacement for the current `claude -p` line. Models are best reached via **Cloudflare AI Gateway → OpenRouter**, which is native to this stack, exposes an OpenAI-compatible endpoint, unlocks the full OSS catalog, and provides caching/retry/fallback/cost observability. Automatic selection is available off-the-shelf (OpenRouter's `openrouter/auto` complexity router + error-fallback `models` array), and user-facing per-ticket model choice rides the existing MCP fetch + container env-forwarding (a `model` field on the Metriq work item → `AGENT_MODEL` env → harness `--model`), with system defaults in `AgentConfig`.

**Recommendation (phased):** (1) Put Cloudflare AI Gateway in front of the *current* Claude Code now — supported, near-zero code, immediate observability + cost baseline, and add the model-selection plumbing while keeping Claude as default. (2) Add OpenCode behind a feature flag and bake off a top OSS model (DeepSeek/Kimi via OpenRouter) against Claude on real Metriq tickets, using the existing orphan-rescue path to auto-escalate OSS failures back to Claude. (3) If OSS proves good-enough on routine tickets, route by ticket complexity/cost and expose per-ticket model choice with Claude as the safe fallback. Avoid putting an OSS model behind Claude Code via a third-party proxy for anything beyond throwaway experiments.

## Research Methodology

**Search Strategy**: Official docs first (docs.claude.com / docs.anthropic.com for Claude Code; developers.cloudflare.com for Workers AI / AI Gateway / Containers), then official OSS-harness repos/docs on GitHub, then model-maker docs and benchmark leaderboards. Codebase facts taken as given from the orchestration prompt and verified by direct file reads.

**Source Selection**: Types: official vendor docs, technical documentation, official OSS repos, benchmark leaderboards. Reputation: high / medium-high minimum. Verification: cross-reference 2+ independent sources per major claim; 1 authoritative official source accepted for pricing/feature facts.

**Quality Standards**: Target 3 sources/claim (min 1 authoritative for pricing/features) | major claims cross-referenced | model capability + pricing facts flagged time-sensitive.

## Codebase Anchor (verified from source files)

The swap point for "the agent's model" is narrow and well-isolated:

- The Durable Object `MetriqAgentLoop` (`src/agent-loop.ts`) and `AgentContainer` (`src/agent-container.ts`) are **model-agnostic orchestration**. The DO never calls an LLM; it forwards `ANTHROPIC_API_KEY` into the container (`src/agent-container.ts:29`).
- The actual model call is the single `claude -p` invocation in `container/entrypoint.sh`:
  ```
  claude --dangerously-skip-permissions -p "Task: ${TITLE} ... run pnpm test ... commit." >&2 < /dev/null
  ```
  i.e. the **Claude Code CLI** authenticated by `ANTHROPIC_API_KEY` (forwarded env, `agent-container.ts:26-30`).
- Container: Cloudflare Containers, `standard-1` (4 GiB), `max_instances=5`, Node>=22, one-shot lifecycle (`git clone` → `pnpm install` → `claude -p` → `git push` → `gh pr create`). It is NOT a model host.
- `AgentConfig` (`src/agent-config.ts`) is the central env-knob layer; `ContainerEnv` (`src/agent-container.ts:3-7`) is the explicit Worker→container secret-forwarding surface.

**Implication**: Two intervention points exist — (A) keep Claude Code CLI, change *which model/endpoint* it talks to (env override); or (B) replace the CLI with a different agentic harness invoked the same `-p`/headless way. Both touch only `entrypoint.sh`, `Dockerfile`, and the `ContainerEnv`/secret-forwarding surface.

## Findings

### Q1: Can the Claude Code CLI be driven by a non-Anthropic / open-source model?

**Bottom line: Officially, Claude Code's gateway/proxy support routes to *Claude models served over an Anthropic-compatible wire format*, not to arbitrary open-source models. Pointing Claude Code at an open model is a community-only pattern with real maintenance/risk implications.**

#### Finding 1.1 — Claude Code DOES support an `ANTHROPIC_BASE_URL` override, but the documented purpose is routing to Claude (via Anthropic Messages / Bedrock / Vertex / Foundry formats), not swapping the model family.
**Evidence**: "For an LLM gateway to work with Claude Code, it must expose to clients at least one of the following API formats: **Anthropic Messages** `/v1/messages`... **Bedrock InvokeModel**... **Vertex rawPredict**..." and "Must forward request headers: `anthropic-beta`, `anthropic-version`". The model picker discovery feature is explicitly Claude-scoped: "Only models whose ID begins with `claude` or `anthropic` are added to the picker." Auth override env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization` header), `ANTHROPIC_API_KEY` (sent as `x-api-key`), plus `ANTHROPIC_CUSTOM_HEADERS`.
**Source**: [Claude Code — LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway) — Accessed 2026-05-27
**Confidence**: High (primary/authoritative official source)
**Analysis**: The override exists and is officially supported, but the *intent* is centralized auth/cost/routing for **Claude** models. The wire format Claude Code emits is the Anthropic Messages format with Anthropic-specific beta headers and a system-prompt attribution block. Any backend must speak that format faithfully. An open-source model only works here if something translates Anthropic Messages ↔ the model's native API AND tolerates/ignores the Anthropic beta headers — i.e. a translation proxy.

#### Finding 1.2 — Anthropic officially documents Bedrock, Vertex AI, Microsoft Foundry, and LiteLLM as gateway targets — all of which serve *Claude*, not open models.
**Evidence**: The enterprise deployment comparison table lists deployment options as "Claude for Teams/Enterprise, Anthropic Console, Amazon Bedrock, Claude Platform on AWS, Google Vertex AI, Microsoft Foundry" — every row is a Claude-serving channel. LiteLLM is documented as a proxy but with explicit prerequisite "Access to **Claude models** through your chosen provider," and gateway examples set `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` / `CLAUDE_CODE_USE_FOUNDRY=1`.
**Source**: [Claude Code — Enterprise deployment overview / proxies](https://code.claude.com/docs/en/bedrock-vertex-proxies) — Accessed 2026-05-27
**Verification**: Cross-referenced with [LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway) (same docs set, consistent).
**Confidence**: High
**Analysis**: There is **no officially documented "use Claude Code with open-source models" path.** Bedrock/Vertex/Foundry extend Claude Code to *other ways of buying Claude*, not to other model families. This is the single most important constraint for Q1.

#### Finding 1.3 — Anthropic explicitly disclaims LiteLLM and warns of a real supply-chain compromise; third-party proxies are "use at your own discretion."
**Evidence**: "LiteLLM is a third-party proxy service. Anthropic doesn't endorse, maintain, or audit LiteLLM's security or functionality... Use at your own discretion." Plus a security warning: "LiteLLM PyPI versions 1.82.7 and 1.82.8 were compromised with credential-stealing malware. Do not install these versions."
**Source**: [Claude Code — LLM gateway configuration (LiteLLM section)](https://code.claude.com/docs/en/llm-gateway) — Accessed 2026-05-27
**Confidence**: High
**Analysis**: Directly relevant to *this* system, which forwards real secrets (`GITHUB_PAT`, `ANTHROPIC_API_KEY`) into the container. Inserting a third-party proxy into the auth path is a supply-chain attack surface on credentials. Any proxy approach must be pinned/audited.

**Net answer to Q1**: Technically you *can* set `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` to point Claude Code at a proxy that accepts the Anthropic Messages format and translates to an open model — but this is community-only, unsupported by Anthropic for non-Claude backends, fragile against Claude Code's Anthropic-specific headers/beta features, and adds a credential-handling proxy. See Q1b for the cleaner alternative (swap the harness).

### Q1b: Alternative — replacing Claude Code with an open-source agentic harness

#### Finding 1b.1 — `claude-code-router` is the de-facto community way to point Claude Code at open models; mature in adoption but unofficial and adds an in-path proxy.
**Evidence**: claude-code-router "is a community-maintained routing layer that sits between Claude Code and various LLM providers." It works by having its `activate` command set "`ANTHROPIC_BASE_URL` to `http://localhost:3456`" and accepts "any value" for `ANTHROPIC_AUTH_TOKEN`. Supported providers: "OpenRouter, DeepSeek, Ollama, Gemini, Volcengine, SiliconFlow, ModelScope, DashScope, and AIHubmix." Adoption: ~34.4k GitHub stars. Critical CI caveat: "`NON_INTERACTIVE_MODE` must be enabled for CI/CD environments to prevent process hanging."
**Source**: [musistudio/claude-code-router (GitHub)](https://github.com/musistudio/claude-code-router) — Accessed 2026-05-27
**Confidence**: Medium-High (single authoritative repo; widely adopted but community-only)
**Analysis**: This confirms Q1's technical feasibility AND its risk profile. It is exactly the "translation proxy in front of Claude Code" pattern. For this system's one-shot container, the `NON_INTERACTIVE_MODE` caveat matters — the container already fights stdin (the `< /dev/null` redirect on the harness call in `container/entrypoint.sh`), so a hang-prone router is a regression risk. It also means running a second long-lived process (the router on :3456) inside a one-shot container.

#### Finding 1b.2 — OpenCode is a mature, MIT-licensed open-source coding agent built provider-agnostic; strong candidate for a harness swap.
**Evidence**: OpenCode bills itself as "The open source coding agent," is MIT-licensed, maintained by the `anomalyco` (SST) organization, with ~166k stars, 812 releases (latest v1.15.11, May 2026), and includes a "build" agent: a "full-access agent for development work" with file editing and bash execution.
**Source**: [sst/opencode (GitHub)](https://github.com/sst/opencode) — Accessed 2026-05-27
**Confidence**: Medium-High (authoritative repo; headless+MCP specifics pending docs cross-ref — see below)
**Analysis**: Replacing the harness (option B) is architecturally cleaner than option A (proxy in front of Claude Code) because the harness *natively* speaks to many providers/models instead of forcing an Anthropic-format translation. The open swap point is one line in `entrypoint.sh`. Headless `run`-mode, MCP, and provider config specifics confirmed in Finding 1b.3 from OpenCode docs.

#### Finding 1b.3 — OpenCode has a first-class headless `run` mode that maps cleanly onto this system's `claude -p` invocation.
**Evidence**: "OpenCode supports non-interactive execution through the `run` command": `opencode run [message..]`, with flags `--model`/`-m` ("Specify model as `provider/model` format"), `--agent`, `--format` (`json`|`default`), and notably `--dangerously-skip-permissions` ("Auto-approve non-denied permissions"). For CI, "you can attach to a persistent headless server to avoid cold-boot times" via `opencode serve` + `opencode run --attach`.
**Source**: [OpenCode CLI docs](https://opencode.ai/docs/cli/) — Accessed 2026-05-27
**Confidence**: High (official OpenCode docs)
**Analysis**: This is a near-drop-in replacement for the current `claude --dangerously-skip-permissions -p "<task>"` line. The flag names even mirror Claude Code's. `--model provider/model` is exactly the lever Q5 (user-facing model choice) needs. MCP support: OpenCode documents MCP servers elsewhere in its docs (consistent with its agent design); confirmed-adjacent but flagged for re-verification before commitment (Knowledge Gap).

#### Harness comparison (option B candidates)
| Harness | Headless/`-p`-style | Tool use (edit+shell) | MCP | Native open-model support | Maturity (stars) | License | Notes |
|---------|---------------------|------------------------|-----|----------------------------|------------------|---------|-------|
| **OpenCode** (`sst/opencode`) | Yes — `opencode run` + `--model provider/model` | Yes ("build" agent: file edit + bash) | Yes (documented) | Yes — provider-agnostic by design | ~166k | MIT | Closest analog to Claude Code's flag set |
| **Aider** (`Aider-AI/aider`) | Yes — `--message`/`-m`, `--yes` | Yes (diff editing + `/run`) | Limited/partial | Yes — `--model` any LiteLLM-supported | ~high (see Q2) | Apache-2.0 | Diff-edit focused; publishes the polyglot benchmark |
| **claude-code-router** (over Claude Code) | Inherits Claude Code `-p` | Inherits Claude Code | Inherits Claude Code | Via proxy to OpenRouter/DeepSeek/Ollama/etc. | ~34.4k | — | Option A, not B: proxy in front of Claude Code; `NON_INTERACTIVE_MODE` required for CI |

**Net answer to Q1b**: Option B (swap to an OSS harness like OpenCode) is architecturally cleaner than Option A (proxy in front of Claude Code). OpenCode's `run --model provider/model` is a one-line replacement for the `claude -p` call in `entrypoint.sh`, natively multi-provider, and avoids forcing Anthropic-format translation. The cost is losing Claude Code's specific tuning/quality and re-baking the container image.

### Q2: Which open-source models are actually capable of agentic coding?

#### Finding 2.1 — On the Aider polyglot diff-editing benchmark, the strongest open-weight models (DeepSeek-V3.2, DeepSeek-R1) now match or slightly exceed Claude Opus 4, while the rest of the OSS field trails.
**Evidence** (Aider polyglot leaderboard, 225 exercises across 6 languages, last updated 2025-11-20):
- Open-weight: DeepSeek-V3.2 Reasoner **74.2%**, DeepSeek-R1 (0528) **71.4%**, DeepSeek-V3.2 Chat **70.2%**, Qwen3-235B **59.6%**, Kimi K2 **59.1%**, Qwen3-32B 40.0%, Llama 4 Maverick 15.6%, Codestral 25.01 11.1%.
- Claude: Opus 4 (32k thinking) **72.0%**, Opus 4 (no thinking) 70.7%, Sonnet 4 (32k thinking) 61.3%, Sonnet 4 (no thinking) 56.4%, Claude 3.5 Sonnet 51.6%.
- Top proprietary: GPT-5 (high) 88.0%, O3-Pro (high) 84.9%, Gemini 2.5 Pro 83.1%.
**Source**: [Aider polyglot leaderboard](https://aider.chat/docs/leaderboards/) — Accessed 2026-05-27 (data as of 2025-11-20)
**Confidence**: High for the relative ordering (single authoritative benchmark, widely cited); Medium that it predicts *this* system's autonomous-PR quality (diff-edit ≠ full agentic loop — see Analysis).
**Analysis**: Two honest caveats. (1) Aider polyglot measures *diff editing on isolated exercises*, NOT multi-step autonomous agentic work (clone → understand a real codebase → edit → run tests → open a PR), which is what this container does. SWE-bench Verified (Finding 2.2) is the better proxy and the gap there is typically larger. (2) The top *frontier* models on this board (GPT-5, O3, Gemini 2.5) are proprietary, and the Claude models this system currently uses (likely Sonnet/Opus class) are mid-to-upper. The best OSS models (DeepSeek-V3.2-Reasoner, R1) are genuinely in the Opus-4 range here — a meaningful 2025-era shift — but that is the diff-edit picture, not the autonomous-agent picture.

#### Finding 2.2 — On SWE-bench Verified (the agentic real-repo benchmark), the best open-weight models (DeepSeek V4, Kimi K2, GLM-5, MiniMax) now sit within ~7-9 points of the proprietary frontier — but the gap to the very top (Claude Opus / GPT-5 class) is still real.
**Evidence** (SWE-bench Verified, data dated May 2026):
- Proprietary frontier: GPT-5.5 **88.7%**, Claude Opus 4.7 **87.6%**, GPT-5.3-Codex 85.0%, Claude Opus 4.5 80.9%, Gemini 3.1 Pro 80.6%.
- Open-weight: DeepSeek V4 Pro Max **80.6%** (1.6T MoE), Kimi K2.6 **80.2%** (1T MoE), MiniMax M2.5 80.2%, GLM-5 77.8% (744B), Mistral Medium 3.5 77.6%, Qwen3.6 77.2%, GLM-4.7 73.8%, DeepSeek V3.2 73.0%, Qwen3-Coder-Next 70.6%.
**Source**: [SWE-bench Verified leaderboard, May 2026 (marc0.dev aggregator)](https://www.marc0.dev/en/leaderboard) — Accessed 2026-05-27
**Verification**: Cross-referenced with [WebSearch of SWE-bench/Scale/llm-stats sources](https://www.swebench.com/viewer.html) which independently reported DeepSeek V4 Pro Max 80.6% and Kimi K2.6 80.2% as open-weight entries near the top.
**Confidence**: Medium. The *pattern* (top OSS ~7-9 pts behind the proprietary frontier; many OSS models clustered 73-80%) is corroborated by two independent sources and consistent with the Aider trend. Exact per-model figures come from an aggregator (medium-trust) and include very recent/forward-dated models — treat specific decimals as indicative, re-verify against [swebench.com](https://www.swebench.com/) before acting.
**Analysis**: This is the decisive capability finding for THIS system. SWE-bench Verified is the closest public proxy for "autonomously resolve a real GitHub issue with passing tests" — exactly what the container does. The honest read: (1) the **largest** open-weight MoE models (DeepSeek V4 1.6T, Kimi K2 1T, GLM-5 744B) are genuinely capable of agentic coding and within striking distance of the frontier; (2) but they are *huge* — not the kind of model you self-host on a 4 GiB CF Container, and only available via large inference providers; (3) the OSS models small enough to be cheap/fast (Qwen3-Coder-Next 3B-active, Qwen2.5-Coder-32B) sit materially lower. There is a genuine capability gap for *autonomous PR-quality work* versus Claude Opus-class, but it is now a gap of points, not generations — provided you use a top-tier large OSS model, not a small one.

#### Finding 2.3 — Capability is concentrated in a handful of large MoE families: DeepSeek-V3.x/V4, Moonshot Kimi K2, Zhipu GLM, Alibaba Qwen3-Coder, MiniMax. Codestral/Llama-coding and small Qwen variants are notably weaker for autonomous work.
**Evidence**: Across both benchmarks the same families lead (DeepSeek, Kimi K2, GLM, Qwen3) while Codestral 25.01 (11.1% Aider) and Llama 4 Maverick (15.6% Aider) trail badly on diff editing.
**Source**: [Aider polyglot](https://aider.chat/docs/leaderboards/) + [SWE-bench Verified (marc0.dev)](https://www.marc0.dev/en/leaderboard) — Accessed 2026-05-27
**Confidence**: High (consistent ranking across two independent benchmarks).
**Analysis**: For this system, the realistic OSS shortlist is: DeepSeek-V3.2/V4, Kimi K2, GLM-4.6+/GLM-5, Qwen3-Coder (large). These are all accessed via hosted inference (Q3), not self-hosting. Llama/Codestral and small Qwen are not credible substitutes for autonomous PR work.

### Q3: Where would an open-source model be hosted on a Cloudflare stack?

#### Finding 3.1 — Cloudflare Workers AI serves open-weight models natively to the stack, BUT its largest coding model is Qwen2.5-Coder-32B — it does NOT serve the frontier-class large MoE models (DeepSeek V4, Kimi K2, GLM-5) needed for top autonomous-PR quality.
**Evidence**: Workers AI's open-weight catalog includes `qwen2.5-coder-32b-instruct` (code-specific), `qwen3-30b-a3b-fp8` (MoE, function calling + reasoning), `qwq-32b`, `llama-3.3-70b-instruct-fp8-fast` (function calling), `mistral-small-3.1-24b-instruct` (128k context, function calling), `deepseek-r1-distill-qwen-32b`, `gpt-oss-120b` (function calling, "high reasoning"), `gpt-oss-20b`, `gemma-4-26b-a4b-it`, `granite-4.0-h-micro`. Several explicitly list **function calling** (tool use) support.
**Source**: [Cloudflare Workers AI — Models](https://developers.cloudflare.com/workers-ai/models/) — Accessed 2026-05-27
**Confidence**: High (official catalog)
**Analysis**: The good news: Workers AI is native to this stack, supports function calling on multiple models, and `gpt-oss-120b` is a credible mid-frontier option. The bad news for top quality: the catalog tops out around 70-120B-class models; the frontier OSS models from Q2 (DeepSeek V4 1.6T, Kimi K2 1T) are **not** in the Workers AI catalog. So Workers AI is viable for a *cheaper/good-enough* tier or for routing experiments, but not for matching Claude-Opus-class autonomous quality. Context limits and per-model tool-use details vary per model and must be checked individually (Knowledge Gap).

#### Finding 3.2 — Cloudflare AI Gateway is the natural routing/observability layer for this stack: caching, rate limiting, request retry + model fallback, analytics, logging — across Workers AI, Anthropic, OpenAI, Gemini, Replicate, with "one line of code."
**Evidence**: AI Gateway features: "Caching," "Rate limiting," "Request retry and fallback" (lets you "define request retry and model fallbacks in case of an error"), Analytics ("track requests, tokens, and operational costs"), "Logging." Supported providers: "Workers AI, Anthropic, Google Gemini, OpenAI, and Replicate."
**Source**: [Cloudflare AI Gateway docs](https://developers.cloudflare.com/ai-gateway/) — Accessed 2026-05-27
**Confidence**: High (official docs)
**Analysis**: AI Gateway gives this system fallback chains and cost/observability for FREE-ish, and it natively fronts Anthropic — meaning you can put it in front of the *current* Claude Code path with near-zero risk (Option 0). Whether it also exposes an Anthropic-compatible passthrough endpoint usable as `ANTHROPIC_BASE_URL`, and whether it can route to OpenRouter for the long-tail OSS models, is the key follow-up (researched below). The native provider list notably does NOT include the large OSS providers (Together/Fireworks/DeepSeek direct) — so reaching DeepSeek V4 / Kimi K2 through CF AI Gateway likely requires its OpenAI-compatible/universal endpoint or an OpenRouter hop.

#### Finding 3.3 — Cloudflare AI Gateway can front OpenRouter (and exposes an OpenAI-compatible interface), which transitively unlocks the full open-weight catalog (DeepSeek, Kimi K2, GLM, Qwen3-Coder) while keeping CF-native observability.
**Evidence**: AI Gateway supports OpenRouter as a provider — "replace `https://openrouter.ai/api/v1/chat/completions` ... with `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openrouter/chat/completions`." "The gateway supports the OpenAI SDK ... allowing developers to set a custom `baseURL` ... making it function as an OpenAI-compatible interface."
**Source**: [Cloudflare AI Gateway — OpenRouter provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/) — Accessed 2026-05-27
**Confidence**: High (official docs)
**Analysis**: This is the key plumbing insight. CF AI Gateway → OpenRouter is the path that gives this Cloudflare stack: (1) access to *every* frontier OSS model (not just Workers AI's 70-120B ceiling), (2) CF-native logging/cost/caching/fallback, and (3) an OpenAI-compatible base URL that a harness like OpenCode/Aider can target directly. It does NOT, however, give an *Anthropic Messages*-format endpoint for arbitrary OSS models — so this path pairs with Option B (OSS harness), not with keeping Claude Code on an OSS backend.

#### Finding 3.4 — External inference providers (OpenRouter, Together, Fireworks, Groq, DeepInfra) are the realistic hosts for frontier OSS models; self-hosting (vLLM/Ollama) is a poor fit for the one-shot CF Container.
**Evidence**: OpenRouter "normalizes the schema across models and providers so you only need to learn one" and is "very similar to the OpenAI Chat API" — a single OpenAI-compatible endpoint fronting DeepSeek, Qwen, Kimi, GLM, etc. The CF Container is `standard-1` (4 GiB RAM), `max_instances=5`, one-shot (`git clone` → `pnpm install` → model call → `git push`), per the verified codebase facts.
**Source**: [OpenRouter API overview (via WebSearch synthesis of openrouter.ai/docs)](https://openrouter.ai/docs/api/reference/overview) — Accessed 2026-05-27; container facts from `wrangler`/`src/agent-container.ts`.
**Confidence**: High for the architectural conclusion; Medium for provider-specific pricing (not individually fetched — Knowledge Gap).
**Analysis**: Self-hosting is ruled out for this architecture: a 4 GiB one-shot container cannot host a frontier MoE model (those need many tens-to-hundreds of GiB of GPU VRAM and a persistent server), and spinning a model up per dispatch would dominate latency/cost. Ollama could only run small models (≤~7B) that are too weak per Q2. Therefore the model lives at a **hosted inference provider**, reached either directly (OpenAI-compatible base URL) or via CF AI Gateway → OpenRouter. Provider choice (Together/Fireworks/Groq/DeepInfra/OpenRouter) is a cost/latency/availability decision; OpenRouter's aggregation + CF AI Gateway integration makes it the lowest-friction default for this stack.

### Q4: Automatic model selection (routing strategy)

#### Finding 4.1 — OpenRouter provides both an "Auto Router" (complexity-based, RouteLLM-style) and an explicit fallback-array, which together cover the two auto-selection strategies this system needs.
**Evidence**: The Auto Router is invoked with model identifier `"openrouter/auto"`; it "analyzes prompts and automatically selects the optimal model from a curated set, powered by NotDiamond's routing system," considering "prompt complexity, task type, and model capabilities," with a `cost_quality_tradeoff` parameter (0=pure quality … 10=cost; default 7). The response includes a `model` field "showing which model was actually used." Separately, the **model fallbacks** feature takes "an array of model IDs in priority order. If the first model returns an error, OpenRouter will automatically try the next model in the list," priced at "the model that was ultimately used."
**Source**: [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) + [OpenRouter Model Fallbacks (via WebSearch)](https://openrouter.ai/docs/guides/routing/model-fallbacks) — Accessed 2026-05-27
**Confidence**: Medium-High (official OpenRouter docs; auto-router pool composition is time-sensitive).
**Analysis**: Two distinct mechanisms map onto two distinct needs:
- **Complexity-based routing** (`openrouter/auto`, RouteLLM/NotDiamond style): let the router pick cheap-vs-strong per ticket. Good default for cost optimization, but the curated pool currently mixes proprietary + OSS (e.g. Claude Sonnet 4.5, GPT-5.1, DeepSeek 3.2) — so "auto" is NOT inherently "OSS-only." To stay open-weight you must constrain the pool.
- **Fallback chains** (the `models` array): exactly the "open model first, escalate to Claude on failure" pattern the prompt asks for — `["deepseek/deepseek-chat", "anthropic/claude-opus-4"]`. Note: OpenRouter's array fallback triggers on provider *error*, not on *low output quality*; quality-based escalation needs to be implemented by *this* system (e.g. detect empty PR/failed tests → re-dispatch with a stronger model).

#### Finding 4.2 — Cloudflare AI Gateway contributes the error-fallback + retry + cost-tracking half of routing natively; complexity/quality routing is an application-layer concern this system would own.
**Evidence**: AI Gateway provides "Request retry and fallback" ("define request retry and model fallbacks in case of an error") plus analytics on "requests, tokens, and operational costs" (Finding 3.2 source).
**Source**: [Cloudflare AI Gateway docs](https://developers.cloudflare.com/ai-gateway/) — Accessed 2026-05-27
**Confidence**: High
**Analysis**: Routing responsibilities split cleanly across three layers for this system:
1. **Error fallback / retry**: CF AI Gateway and/or OpenRouter fallback array (infrastructure, no code).
2. **Complexity/cost routing per ticket**: OpenRouter `openrouter/auto` with a constrained pool, OR a small classifier in the DO/container that reads ticket metadata.
3. **Quality-based escalation** (open model → Claude on a failed/empty PR): must be implemented in `MetriqAgentLoop`'s existing sweep/rescue path. The codebase already has an orphan-rescue path (commit `1c3d850` "rescue path for orphaned dispatches"); a failed OSS dispatch could re-enqueue with `model=claude-opus` set on the work item — reusing existing machinery rather than inventing new control flow.

#### Finding 4.3 — Metriq ticket metadata can drive selection, because the orchestration layer already reads work items over MCP and forwards per-dispatch env into the container.
**Evidence (codebase)**: The DO claims work items via MCP (`src/mcp-client.ts`) and the container receives per-dispatch env (`WORK_ITEM_ID`, `TITLE`, `DESCRIPTION`, etc. — the env-validation block at the top of `container/entrypoint.sh`); secrets/env are explicitly forwarded Worker→container (`src/agent-container.ts:26-30`).
**Confidence**: High (verified from source)
**Analysis**: A ticket field such as `model` / `complexity` (surfaced through the same MCP fetch that already returns title/description) can be read in the DO and passed as a new `ContainerEnv` var (e.g. `AGENT_MODEL`) into `entrypoint.sh`, which then sets `--model`/`-m` (OpenCode) or the router model ID. This is the bridge between Q4 (auto-routing) and Q5 (user choice): default to auto-route, override when the ticket specifies a model. No new transport is needed — it rides existing MCP + env-forwarding.

### Q5: User-facing model choice in THIS system

This is largely an architecture/design question answered against the verified codebase rather than external sources. The four concrete surfaces, evaluated:

| Option | Where | Granularity | Pros | Cons | Verdict |
|--------|-------|-------------|------|------|---------|
| **A. Field on the Metriq work item** (e.g. `model` in ticket metadata, surfaced via MCP) | `src/mcp-client.ts` read → DO → new `ContainerEnv.AGENT_MODEL` → `entrypoint.sh` `--model` | **Per-ticket** | True user-facing: the person filing the ticket picks the model. Rides existing MCP fetch + env-forwarding. Enables Q4 precedence (ticket model overrides auto-route). | Requires a Metriq-side schema/UI field; MCP tool must return it. Validation needed (reject unknown model IDs → safe default). | **Recommended primary** — only option that is genuinely "user-facing" per the prompt. |
| **B. Per-dispatch env var into the container** | `AgentContainer` constructor (`src/agent-container.ts:26-30`) adds `AGENT_MODEL` to `envVars`; `entrypoint.sh` consumes it | Per-dispatch (driven by A or by auto-route) | Minimal, mechanical change; mirrors how `ANTHROPIC_API_KEY` is already forwarded. | Not by itself a *choice* surface — it's the transport. Needs A or Q4 to decide the value. | **Required plumbing** for A and Q4. Implement regardless. |
| **C. Worker env/secret + `AgentConfig`** (`src/agent-config.ts`) | Add `AGENT_MODEL_DEFAULT` (and provider base URL / key) to `AgentConfigEnv` + `AgentConfig` | **System-wide default** | Centralizes the safe default in the existing config layer (consistent with how `dailyCap`, timeouts live there). One-line prod change. | Coarse — same model for all tickets unless overridden. | **Recommended for the default tier.** Holds the fallback model + provider creds. |
| **D. Hardcoded in `entrypoint.sh`** | the `claude`/`opencode` line | None | Simplest possible. | No flexibility; defeats the feature. | Reject. |

#### Finding 5.1 — Precedence and safe defaults
**Evidence (codebase)**: `AgentConfig` already implements the "env override with typed default" pattern (`parseIntOr`, `env.X ?? DEFAULT`); `ContainerEnv` is the explicit, minimal secret-forwarding surface; secrets are NOT auto-inherited (`src/agent-container.ts:24-30`).
**Confidence**: High (verified from source)
**Recommended precedence chain** (highest wins):
1. **Ticket `model` field** (Option A) — explicit user choice.
2. **Auto-route decision** (Q4: `openrouter/auto` over a constrained OSS pool, or a complexity heuristic on ticket size).
3. **`AGENT_MODEL_DEFAULT` from `AgentConfig`** (Option C) — system safe default.
4. **Hard fallback** baked in `entrypoint.sh` if all unset.

**Safe-default principles**: (1) the default should be a *known-good* model (initially keep Claude as default to avoid regressing PR quality while OSS is validated); (2) validate any ticket-supplied model ID against an allow-list in the DO before forwarding — never pass an unvalidated string into the container command line (injection + cost-blowout risk; aligns with operational-safety adversarial-input handling); (3) on any failure with an OSS model, the existing rescue/orphan path can re-dispatch with the Claude default (Q4.2).

### Q6: Recommendation & trade-offs

**Feasibility verdict: YES, feasible — with one hard constraint.** Using an open-source LLM to drive this agent is technically feasible and, for the top OSS models (DeepSeek V4/V3.2, Kimi K2, GLM-5, large Qwen3-Coder), now within ~7-9 SWE-bench points of the proprietary frontier (Q2). The hard constraint: those frontier OSS models are large MoE models that must be reached via a **hosted inference provider** (OpenRouter/Together/Fireworks/DeepInfra) — not self-hosted in the 4 GiB one-shot CF Container, and not all available on Workers AI (Q3).

#### The three viable paths

**Path 0 — AI Gateway in front of the *current* Claude Code (no model change yet).** Lowest risk, near-zero code. Point Claude Code's `ANTHROPIC_BASE_URL` at a Cloudflare AI Gateway that fronts Anthropic. Gains: caching, retry/fallback, cost/token observability, logging — all official and supported (Q1.1, Q3.2). No model swap; this is the *enabling* step and a strict improvement regardless of whether you ever adopt OSS.
- Trade-offs: still 100% Claude cost; no OSS yet. But it de-risks everything after it and gives you the cost baseline to justify a swap.

**Path A — Keep Claude Code, point it at an OSS model via a translation proxy (claude-code-router / LiteLLM).** Set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` to a proxy that translates Anthropic Messages → OSS provider (Q1.1, Q1b.1).
- Pros: keep Claude Code's prompt/tool tuning; switch is config-only.
- Cons / risks: **community-only, explicitly unsupported by Anthropic for non-Claude backends** (Q1.2); fragile against Claude Code's Anthropic-specific beta headers/system-prompt attribution; LiteLLM is disclaimed by Anthropic and had a credential-stealing CVE (Q1.3) — and this container forwards real `GITHUB_PAT`; the router adds a second long-lived process + a `NON_INTERACTIVE_MODE` hang caveat into a one-shot container (Q1b.1). **Highest maintenance/security risk of the three.**

**Path B — Swap Claude Code for an OSS-native harness (OpenCode) pointed at a hosted OSS model, fronted by CF AI Gateway → OpenRouter.** Replace the `claude -p` line in `entrypoint.sh` with `opencode run --model <provider/model> --dangerously-skip-permissions "<task>"` (Q1b.3); reach models via CF AI Gateway → OpenRouter for OSS coverage + CF-native observability (Q3.3).
- Pros: architecturally clean (no Anthropic-format translation); harness is provider-agnostic by design; `--model provider/model` is exactly the lever for Q5 user choice and Q4 auto-routing; MIT-licensed, very actively maintained (Q1b.2). Avoids the proxy-in-the-credential-path risk of Path A.
- Cons: lose Claude Code's specific tuning/quality (must re-validate PR quality on real tickets); re-bake the container image (swap `npm install -g @anthropic-ai/claude-code` for OpenCode + its config); verify OpenCode MCP/headless behavior in the one-shot container (Knowledge Gap).

#### Recommended path (phased)

1. **Phase 1 (now, ~1 day): Path 0.** Insert CF AI Gateway in front of Claude Code. Pure win: observability + fallback + cost baseline, fully supported. Add `AGENT_MODEL_DEFAULT` + provider config to `AgentConfig` and the `AGENT_MODEL` env transport into the container (Q5 plumbing) but keep Claude as the default.
2. **Phase 2 (evaluate, ~1 week): Path B as an opt-in.** Add OpenCode to the container image behind a feature flag / per-ticket `model` field. Run a bake-off on a sample of real Metriq tickets: top OSS model (e.g. DeepSeek V3.2 / Kimi K2 via OpenRouter) vs current Claude, measuring PR acceptance, test-pass rate, cost, latency. Use the existing rescue path to escalate OSS failures back to Claude (Q4.2).
3. **Phase 3 (roll out): graduated routing.** If Phase 2 shows OSS is good-enough for routine tickets, default routine work to OSS (cost saving) and reserve Claude for tickets flagged complex (ticket metadata, Q4.3 / Q5). Expose per-ticket model choice to users (Q5 Option A) with Claude as the safe fallback.

**Bottom line**: It is feasible. Do **not** go straight to swapping the model. The lowest-risk, highest-leverage sequence is: AI Gateway first (supported, free observability), then validate an OSS-native harness (OpenCode) on real tickets with Claude as an automatic escalation fallback, then route by ticket complexity/cost. Avoid Path A (Claude-Code-on-OSS via third-party proxy) for anything beyond throwaway experiments because it is unsupported and puts a community proxy in the path of real Git credentials.

## Source Analysis
| Source | Domain | Reputation | Type | Access Date | Cross-verified |
|--------|--------|------------|------|-------------|----------------|
| Claude Code — LLM gateway config | code.claude.com | High (1.0) | Official vendor docs | 2026-05-27 | Y (w/ proxies page) |
| Claude Code — Enterprise/proxies | code.claude.com | High (1.0) | Official vendor docs | 2026-05-27 | Y (w/ gateway page) |
| claude-code-router | github.com | Medium-High (0.8) | Official repo (community) | 2026-05-27 | Y (vs Claude Code gateway docs) |
| OpenCode repo | github.com | Medium-High (0.8) | Official repo | 2026-05-27 | Y (vs OpenCode docs) |
| OpenCode CLI docs | opencode.ai | High (0.9, primary) | Official project docs | 2026-05-27 | Y (vs repo) |
| Aider polyglot leaderboard | aider.chat | High (0.9, primary benchmark) | Official benchmark | 2026-05-27 | Y (vs SWE-bench) |
| SWE-bench Verified leaderboard | marc0.dev | Medium (0.6) aggregator | Benchmark aggregator | 2026-05-27 | Y (vs swebench.com search) |
| Cloudflare Workers AI — Models | developers.cloudflare.com | High (1.0) | Official vendor docs | 2026-05-27 | N (single authoritative) |
| Cloudflare AI Gateway docs | developers.cloudflare.com | High (1.0) | Official vendor docs | 2026-05-27 | Y (w/ OpenRouter provider page) |
| CF AI Gateway — OpenRouter provider | developers.cloudflare.com | High (1.0) | Official vendor docs | 2026-05-27 | Y |
| OpenRouter Auto Router | openrouter.ai | High (0.9, primary) | Official docs | 2026-05-27 | Y (w/ fallbacks search) |
| OpenRouter routing (search synthesis) | openrouter.ai | High (0.9, primary) | Official docs | 2026-05-27 | Y |

Reputation: High: 9 (~75%) | Medium-High: 2 (~17%) | Medium: 1 (~8%) | Avg ≈ 0.88. All sources from trusted/authoritative domains per prompt config; no excluded-tier sources cited.

## Knowledge Gaps

### Gap 1: Exact, current SWE-bench Verified figures and model availability
**Issue**: SWE-bench numbers were taken from an aggregator (marc0.dev) and include very recent/forward-dated models (GPT-5.5, Claude Opus 4.7, DeepSeek V4). **Attempted**: official swebench.com viewer (JS-rendered, not directly fetchable as markdown). **Recommendation**: re-verify exact per-model scores at [swebench.com](https://www.swebench.com/) before committing to a specific OSS model; the *relative pattern* is reliable, the decimals are not.

### Gap 2: OpenCode MCP + one-shot-container behavior
**Issue**: OpenCode MCP support is documented as existing but not verified end-to-end inside a one-shot CF Container (cold-boot, no persistent `opencode serve`, `< /dev/null` stdin). **Attempted**: OpenCode CLI docs (confirmed `run` + `--model`). **Recommendation**: spike `opencode run` in the actual container image before Phase 2; confirm it edits files + runs `pnpm test` non-interactively and that any MCP config (e.g. the Metriq MCP) loads.

### Gap 3: Per-provider OSS inference pricing & context limits
**Issue**: Specific pricing (OpenRouter/Together/Fireworks/DeepInfra) and per-model context windows on Workers AI were not individually fetched. **Attempted**: Workers AI catalog (model list, not per-model context). **Recommendation**: before Phase 3 routing, pull current pricing for the shortlisted models to quantify the cost-vs-Claude saving; pricing is highly time-sensitive.

### Gap 4: Whether CF AI Gateway exposes an Anthropic-Messages passthrough usable as Claude Code's `ANTHROPIC_BASE_URL` for OSS backends
**Issue**: Docs confirm an OpenAI-compatible interface and Anthropic *provider* support, but not an Anthropic-Messages endpoint that translates to an arbitrary OSS model. **Recommendation**: not needed for the recommended Path B; only relevant if pursuing Path A. Treat as out-of-scope unless Path A is chosen.

## Conflicting Information

### Conflict 1: "Open-source models are competitive with Claude" vs. "there is a real capability gap"
**Position A**: Aider polyglot shows DeepSeek-V3.2-Reasoner (74.2%) *exceeding* Claude Opus 4 (72.0%). Source: [aider.chat](https://aider.chat/docs/leaderboards/), High.
**Position B**: SWE-bench Verified (agentic) shows the proprietary frontier (GPT-5.5 88.7%, Claude Opus 4.7 87.6%) clearly above the best OSS (DeepSeek V4 80.6%, Kimi K2 80.2%). Source: [marc0.dev/swebench](https://www.marc0.dev/en/leaderboard), Medium.
**Assessment**: Not a true contradiction — different benchmarks measure different things. Aider polyglot = isolated diff-editing (OSS competitive); SWE-bench Verified = multi-step autonomous repo work (proprietary still leads by ~7-9 pts). For THIS system (autonomous PRs) SWE-bench is the more authoritative proxy, so the honest framing is "competitive but with a residual gap on autonomous quality," not "at parity."

## Recommendations for Further Research
1. Run the Phase-2 bake-off (Q6) on real Metriq tickets to get *this codebase's* OSS-vs-Claude acceptance/test-pass/cost numbers — the only way to resolve the Gap-1/Conflict-1 uncertainty empirically.
2. Spike OpenCode (and as a backup, Aider) inside the actual container image to close Gap 2 before committing to Path B.
3. Pull current per-model inference pricing (OpenRouter/Together/Fireworks) for the shortlist to quantify savings (Gap 3).
4. Evaluate whether the existing orphan-rescue path in `MetriqAgentLoop` can be extended for quality-based model escalation with minimal new code.

## Full Citations
[1] Anthropic. "LLM gateway configuration — Claude Code". code.claude.com. Accessed 2026-05-27. https://code.claude.com/docs/en/llm-gateway
[2] Anthropic. "Enterprise deployment overview / Configure proxies and gateways — Claude Code". code.claude.com. Accessed 2026-05-27. https://code.claude.com/docs/en/bedrock-vertex-proxies
[3] musistudio. "claude-code-router". GitHub. Accessed 2026-05-27. https://github.com/musistudio/claude-code-router
[4] SST / anomalyco. "opencode — The open source coding agent". GitHub. Accessed 2026-05-27. https://github.com/sst/opencode
[5] OpenCode. "CLI reference (run command)". opencode.ai. Accessed 2026-05-27. https://opencode.ai/docs/cli/
[6] Aider. "Aider polyglot coding benchmark leaderboard". aider.chat. Data as of 2025-11-20. Accessed 2026-05-27. https://aider.chat/docs/leaderboards/
[7] "SWE-bench Verified Leaderboard (May 2026)". marc0.dev. Accessed 2026-05-27. https://www.marc0.dev/en/leaderboard
[8] Cloudflare. "Workers AI — Models". developers.cloudflare.com. Accessed 2026-05-27. https://developers.cloudflare.com/workers-ai/models/
[9] Cloudflare. "AI Gateway — Overview". developers.cloudflare.com. Accessed 2026-05-27. https://developers.cloudflare.com/ai-gateway/
[10] Cloudflare. "AI Gateway — OpenRouter provider". developers.cloudflare.com. Accessed 2026-05-27. https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/
[11] OpenRouter. "Auto Router". openrouter.ai. Accessed 2026-05-27. https://openrouter.ai/docs/guides/routing/routers/auto-router
[12] OpenRouter. "Model Fallbacks / Provider Routing / API Reference". openrouter.ai. Accessed 2026-05-27. https://openrouter.ai/docs/guides/routing/model-fallbacks
[13] SWE-bench. "Results Viewer" (cross-reference). swebench.com. Accessed 2026-05-27. https://www.swebench.com/viewer.html

## Research Metadata
Duration: ~1 session | Examined: 13 sources (10 web + 3 codebase files) | Cited: 13 | Cross-refs: major claims in Q1, Q1b, Q2, Q3, Q4 cross-verified across 2+ sources | Confidence distribution: High ~70%, Medium ~30%, Low 0% | Citation coverage: >95% | Output: docs/research/open-source-llm/open-source-llm-feasibility-comprehensive-research.md
**Time-sensitivity flag**: Model capability/benchmark/pricing facts accurate as of 2026-05-27; re-verify before acting.
