#!/usr/bin/env bash
#
# Slice 4 container entrypoint. Invoked by server.js as a subprocess on each
# /run dispatch. Reads dispatch context + GitHub auth from env, drives the
# git + GitHub plumbing end-to-end, prints the PR URL on stdout (so the
# Durable Object can capture it via parseLastUrl), and exits non-zero on
# any failure so the DO's existing sweeper path reclaims the dispatch.
#
# NEVER pass --no-verify. The agent pushes normally so whatever pre-push
# hooks the target repo defines run and gate the push.

set -euo pipefail

# Progress markers go to stderr so they don't pollute the PR-URL stdout that
# parseLastUrl reads. server.js merges stderr into the response body for
# diagnostic visibility on failure.
step() { echo "[step] $*" >&2; }

# Required env from server.js + container secrets
: "${WORK_ITEM_ID:?WORK_ITEM_ID required}"
: "${DISPATCH_ID:?DISPATCH_ID required}"
: "${SHORT_ID:?SHORT_ID required}"
: "${TITLE:?TITLE required}"
: "${GITHUB_PAT:?GITHUB_PAT required}"
: "${GITHUB_USER:?GITHUB_USER required}"
DESCRIPTION="${DESCRIPTION:-}"
step "env-ok short_id=${SHORT_ID} work_item_id=${WORK_ITEM_ID}"

# gh CLI auth via env, no interactive login needed.
export GH_TOKEN="$GITHUB_PAT"

# git identity for the agent's commits.
git config --global user.email "${GITHUB_USER}@users.noreply.github.com"
git config --global user.name "$GITHUB_USER"
step "git-config-ok"

WORK_DIR=$(mktemp -d)
cd "$WORK_DIR"
step "workdir=${WORK_DIR}"

# Target repo + base branch are deploy-time constants (buildContainerEnvVars).
# TARGET_REPO is REQUIRED — no hardcoded owner fallback. buildContainerEnvVars
# forwards it as "" when the Worker var is unset, so treat empty as unset and
# fail fast BEFORE the clone. TARGET_BASE_BRANCH keeps a generic "main" default.
if [ -z "${TARGET_REPO:-}" ]; then
  echo "TARGET_REPO is required (owner/name of the repo to clone + open PRs against)" >&2
  exit 1
fi
TARGET_BASE_BRANCH="${TARGET_BASE_BRANCH:-main}"
REPO_URL="https://x-access-token:${GITHUB_PAT}@github.com/${TARGET_REPO}.git"
step "clone-start target_repo=${TARGET_REPO}"
git clone --depth 1 "$REPO_URL" repo
cd repo
step "clone-ok"

git checkout -b "agent/${SHORT_ID}"
step "branch-ok"

step "pnpm-install-start"
# Hydrate node_modules from the baked image layer when its lockfile matches
# the freshly cloned one (the common case). pnpm install will then complete
# in seconds (diff-install only). When the target repo's lockfile has drifted
# from the bake, fall back to a full install — slower but always correct.
if cmp -s /baked/pnpm-lock.yaml pnpm-lock.yaml 2>/dev/null; then
  step "pnpm-baked-hit"
  cp -r /baked/node_modules ./node_modules
else
  step "pnpm-baked-miss"
fi
pnpm install --frozen-lockfile
step "pnpm-install-ok"

# The one-shot prompt handed to whichever harness runs the dispatch. Shared so
# the claude (-p) and opencode (positional) branches stay textually identical.
AGENT_PROMPT="Task: ${TITLE}

${DESCRIPTION}

Make the changes in this repository. Run \`pnpm test\` to verify nothing breaks. You may commit your changes; if you don't, the agent will commit them for you."

# ADR-005/006: pick the harness.
#   AGENT_HARNESS=opencode  → OSS path: opencode.json (LiteLLM baseURL + key +
#                             LiteLLM-native cost metadata), `opencode run`, NO
#                             cf-aig headers (CF gateway is the Claude path only).
#   AGENT_HARNESS unset/""   → Claude path: the default behavior
#                             (ANTHROPIC_BASE_URL + cf-aig via ANTHROPIC_CUSTOM_HEADERS).
if [ "${AGENT_HARNESS:-}" = "opencode" ]; then
  # --- OSS / OpenCode branch ------------------------------------------------
  # Fail fast (ADR-006): without an OSS key we'd dial an unauthenticated
  # endpoint. Exit non-zero so the DO escalates this dispatch to Claude rather
  # than running an unconfigured model.
  : "${OSS_MODEL_API_KEY:?OSS_MODEL_API_KEY required for the opencode harness}"
  : "${OSS_MODEL_BASE_URL:?OSS_MODEL_BASE_URL required for the opencode harness}"
  step "harness=opencode"

  # opencode.json mirrors the Claude-path ANTHROPIC_CUSTOM_HEADERS assembly: the
  # DO-minted cost tags (CF_AIG_METADATA JSON, keyed by work_item_id /
  # dispatch_id) ride as LiteLLM-native `x-litellm-metadata` extra-body — NOT
  # cf-aig headers. When no tags are minted the metadata block is omitted. The
  # provider points at the OSS (LiteLLM) endpoint.
  #
  # SECURITY: write the config OUTSIDE the cloned repo and point opencode at it
  # via OPENCODE_CONFIG. The file carries OSS_MODEL_API_KEY, so if it lived in
  # the repo working tree the later `git add -A` would stage it and publish the
  # key in the PR diff. Keeping it in $WORK_DIR (the repo's parent) means
  # `git add -A` — which only sees the repo — can never reach it.
  #
  # IMPORTANT: build the file with node + JSON.stringify, NOT a bash heredoc.
  # The inputs (operator secrets + the allow-listed model + DO-minted cost tags)
  # are not attacker free-text, but a stray quote/special char in any value
  # would yield malformed JSON under string interpolation. JSON.stringify
  # guarantees valid JSON regardless of value contents. CF_AIG_METADATA is
  # embedded as PARSED JSON (JSON.parse) under the LiteLLM metadata field —
  # never spliced as a raw string.
  #
  # NOTE: the exact LiteLLM-native metadata header/key (`x-litellm-metadata` vs
  # `metadata`) and the extraBody nesting MUST be confirmed against the pinned
  # LiteLLM at deploy time (ADR-007). OSS per-PR cost attribution depends on this
  # contract; it cannot be verified here without a live LiteLLM instance.
  OPENCODE_CONFIG="${WORK_DIR}/opencode.json"
  export OPENCODE_CONFIG
  node -e '
    const fs = require("fs");
    const cfg = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        oss: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: process.env.OSS_MODEL_BASE_URL,
            apiKey: process.env.OSS_MODEL_API_KEY,
          },
          models: {
            [process.env.AGENT_MODEL]: {},
          },
        },
      },
    };
    const raw = process.env.CF_AIG_METADATA;
    if (raw) {
      cfg.options = { extraBody: { "x-litellm-metadata": JSON.parse(raw) } };
    }
    fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  '
  step "opencode-json-written path=${OPENCODE_CONFIG}"

  # OpenCode takes the task positionally (no `-p`). stdout → stderr so the
  # harness output never reaches entrypoint stdout (parseLastUrl reads the PR
  # URL there). `--dangerously-skip-permissions` so it can actually edit files.
  step "opencode-start"
  opencode run \
    --model "$AGENT_MODEL" \
    --dangerously-skip-permissions \
    "$AGENT_PROMPT" \
    >&2 < /dev/null
  step "opencode-ok"
else
  # --- Claude branch --------------------------------------------------------
  # Per-dispatch model + AI Gateway cost headers.
  #   AGENT_MODEL      — the resolved model id (server.js carried it from the
  #                      /start body). When non-empty, pass `claude --model`.
  #   CF_AIG_METADATA  — DO-minted cost-attribution tags JSON. Becomes the
  #                      cf-aig-metadata header so per-PR cost is attributable.
  #   AI_GATEWAY_TOKEN — optional AI Gateway auth (ContainerEnv constant). Becomes
  #                      cf-aig-authorization. ABSENT ⇒ no header (never a broken
  #                      empty Bearer).
  # ANTHROPIC_BASE_URL is already in the env (ContainerEnv) and claude reads it
  # directly — do NOT pass it as a flag.
  MODEL_ARGS=()
  if [ -n "${AGENT_MODEL:-}" ]; then
    # Anthropic's `claude` CLI does NOT accept the `anthropic/` provider prefix
    # — it wants bare ids (claude-haiku-4-5-20251001) or the always-latest
    # shortcuts (haiku / sonnet / opus). The agent's MODEL_ALLOW_LIST keeps the
    # `anthropic/...` shape because it's the harness-routing key internally
    # (resolveHarness, src/resolve-model.ts) and the cost-attribution-tag
    # textual key. Strip the prefix HERE at the CLI boundary only — never in
    # resolveModel.
    CLI_MODEL="${AGENT_MODEL#anthropic/}"
    MODEL_ARGS=(--model "$CLI_MODEL")
    # Log BOTH forms: the allow-list form keeps `step` log continuity with the
    # cost-attribution tag; the CLI form lets diagnostics show exactly what the
    # CLI was handed.
    step "model=${AGENT_MODEL} cli=${CLI_MODEL}"
  fi

  # Assemble ANTHROPIC_CUSTOM_HEADERS (claude reads this env). Newline-separated
  # `Header: value` lines; only add a line when its source is set.
  CUSTOM_HEADERS=""
  if [ -n "${CF_AIG_METADATA:-}" ]; then
    CUSTOM_HEADERS="cf-aig-metadata: ${CF_AIG_METADATA}"
  fi
  if [ -n "${AI_GATEWAY_TOKEN:-}" ]; then
    auth_line="cf-aig-authorization: Bearer ${AI_GATEWAY_TOKEN}"
    if [ -n "$CUSTOM_HEADERS" ]; then
      CUSTOM_HEADERS="${CUSTOM_HEADERS}
${auth_line}"
    else
      CUSTOM_HEADERS="$auth_line"
    fi
  fi
  if [ -n "$CUSTOM_HEADERS" ]; then
    export ANTHROPIC_CUSTOM_HEADERS="$CUSTOM_HEADERS"
    step "aig-headers-set"
  fi

  # Hand the ticket to Claude. stdout is redirected to stderr so claude's
  # response text + tool output don't end up on entrypoint stdout (where
  # parseLastUrl in the DO would mistake a referenced URL for the PR URL).
  step "claude-start"
  # `< /dev/null` skips claude's 3s stdin-wait check; `>&2` keeps its response
  # text + tool output off entrypoint stdout so parseLastUrl doesn't grab a
  # URL Claude happens to mention.
  #
  # `--dangerously-skip-permissions` is intentional here — without it,
  # `claude -p` cannot actually use Write/Edit/Bash tools (PR comes through
  # empty). The flag's "dangerous" naming is for use on developer machines;
  # for this ephemeral one-shot container, it's the correct permission mode.
  claude \
    --dangerously-skip-permissions \
    "${MODEL_ARGS[@]}" \
    -p "$AGENT_PROMPT" \
    >&2 < /dev/null
  step "claude-ok"
fi

# Stage anything claude left unstaged. --allow-empty ensures we always
# have at least one commit on the branch (so push + PR don't no-op when
# claude decided to commit its own work or made no edits).
git add -A
git commit --allow-empty -m "agent-touch: ${SHORT_ID}

Closes Metriq ticket #${WORK_ITEM_ID}"
step "commit-ok"

# Push triggers whatever pre-push hook the target repo defines (if any). The
# agent never bypasses them (no --no-verify); if one fails, the push fails.
step "push-start"
git push -u origin "agent/${SHORT_ID}"
step "push-ok"

step "pr-create-start"
# `--head` is explicit so gh doesn't try to auto-detect the upstream from
# git's tracking config — that detection occasionally trips even right
# after a successful push (replication/cache lag).
PR_URL=$(gh pr create \
  --base "$TARGET_BASE_BRANCH" \
  --head "agent/${SHORT_ID}" \
  --title "$TITLE" \
  --body "Closes Metriq ticket #${WORK_ITEM_ID}")
step "pr-create-ok url=${PR_URL}"

# Last line of stdout. parseLastUrl in agent-loop takes the last URL match.
echo "$PR_URL"
