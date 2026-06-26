#!/usr/bin/env bats
#
# Tests for container/entrypoint.sh. Stubs git, gh, and pnpm in PATH so the
# script never touches a real network or filesystem under the target repo.
# Run with: bats test/entrypoint.bats
#
# bats-core: brew install bats-core (or apt install bats).
# Tests deliberately do not require any other bats- helpers — vanilla bats.

setup() {
  STUB_DIR="$(mktemp -d)"
  GIT_LOG="$STUB_DIR/git.log"
  GH_LOG="$STUB_DIR/gh.log"
  PNPM_LOG="$STUB_DIR/pnpm.log"
  CLAUDE_LOG="$STUB_DIR/claude.log"
  export STUB_DIR GIT_LOG GH_LOG PNPM_LOG CLAUDE_LOG

  # Default good stubs.
  cat > "$STUB_DIR/git" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$GIT_LOG"
case "$1" in
  clone)
    # `git clone [--depth N] <url> <dest>` — dest is the last positional.
    eval "dest=\${$#}"
    mkdir -p "$dest"
    : > "$dest/README.md"
    ;;
esac
STUB_EOF

  cat > "$STUB_DIR/gh" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  # gh emits a few status lines before the URL in real life; entrypoint.sh
  # uses parseLastUrl which takes the LAST match — emit some noise first.
  echo "Creating pull request for agent/$SHORT_ID into main in example/target-repo"
  echo "https://github.com/example/target-repo/pull/123"
fi
STUB_EOF

  cat > "$STUB_DIR/pnpm" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$PNPM_LOG"
STUB_EOF

  CLAUDE_ENV_LOG="$STUB_DIR/claude-env.log"
  export CLAUDE_ENV_LOG
  cat > "$STUB_DIR/claude" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$CLAUDE_LOG"
# Capture the header-relevant env claude reads, so tests can assert what
# entrypoint.sh assembled. ANTHROPIC_BASE_URL is set by ContainerEnv (claude
# reads it directly); ANTHROPIC_CUSTOM_HEADERS is assembled by entrypoint.sh.
{
  echo "ANTHROPIC_CUSTOM_HEADERS=${ANTHROPIC_CUSTOM_HEADERS:-}"
  echo "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}"
} >> "$CLAUDE_ENV_LOG"
STUB_EOF

  # Stub `opencode` (the OSS harness). Logs
  # its args + the generated opencode.json so tests can assert the OSS-branch
  # wiring (model, baseURL, key, LiteLLM-native metadata) without a real model.
  OPENCODE_LOG="$STUB_DIR/opencode.log"
  OPENCODE_JSON_LOG="$STUB_DIR/opencode-json.log"
  export OPENCODE_LOG OPENCODE_JSON_LOG
  cat > "$STUB_DIR/opencode" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$OPENCODE_LOG"
# entrypoint.sh writes opencode.json into CWD before invoking `opencode run`.
# Capture it so tests can assert the provider block (baseURL/apiKey/metadata).
if [ -f opencode.json ]; then
  cat opencode.json >> "$OPENCODE_JSON_LOG"
fi
# Emit a PR-like URL on the same stdout discipline claude uses (>&2 in the
# entrypoint), so the happy-path PR flow still works on the OSS branch.
echo "opencode: done"
STUB_EOF

  chmod +x "$STUB_DIR/git" "$STUB_DIR/gh" "$STUB_DIR/pnpm" "$STUB_DIR/claude" "$STUB_DIR/opencode"
  export PATH="$STUB_DIR:$PATH"

  # Required env for the happy path.
  export WORK_ITEM_ID="wi-test"
  export DISPATCH_ID="d-test-1234abcd"
  export SHORT_ID="ab12cd34"
  export TITLE="Hello world"
  export DESCRIPTION="demo"
  export GITHUB_PAT="pat-xxx"
  export GITHUB_USER="metriq-agent"
  # TARGET_REPO is REQUIRED (no owner fallback) — every happy-path test needs it.
  export TARGET_REPO="example/target-repo"

  ENTRYPOINT="$BATS_TEST_DIRNAME/../container/entrypoint.sh"
  export ENTRYPOINT
}

teardown() {
  rm -rf "$STUB_DIR"
}

@test "happy path: exits 0 and emits the PR URL on stdout" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # parseLastUrl takes the last URL match — entrypoint must end with the PR URL.
  last_line="$(echo "$output" | tail -n 1)"
  [ "$last_line" = "https://github.com/example/target-repo/pull/123" ]
}

@test "branch name is agent/<SHORT_ID>" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q "^checkout -b agent/ab12cd34$" "$GIT_LOG"
}

@test "pnpm install runs with --frozen-lockfile" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q "^install --frozen-lockfile$" "$PNPM_LOG"
}

@test "claude -p invoked with Task: <title> + description prompt and skip-permissions" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # -p flag is somewhere on the line (no longer first since flags precede it)
  grep -q -- "-p " "$CLAUDE_LOG"
  # --dangerously-skip-permissions required so claude can actually edit files
  grep -q -- "--dangerously-skip-permissions" "$CLAUDE_LOG"
  # Prompt must include the title and description text
  grep -q "Hello world" "$CLAUDE_LOG"
  grep -q "demo" "$CLAUDE_LOG"
}

@test "fails when claude exits non-zero (no gh pr create attempted)" {
  cat > "$STUB_DIR/claude" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$CLAUDE_LOG"
exit 1
STUB_EOF
  chmod +x "$STUB_DIR/claude"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  # gh pr create must NOT have fired — set -e aborts before reaching it
  ! grep -q "pr create" "$GH_LOG" 2>/dev/null || [ ! -s "$GH_LOG" ]
}

@test "gh pr create targets the default base (main) with correct head/title/body" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q "^pr create --base main --head agent/ab12cd34 --title Hello world --body Closes Metriq ticket #wi-test$" "$GH_LOG"
}

# ---- open-source-readiness Task 3: required target repo + base branch ----

@test "fails fast (non-zero) when TARGET_REPO is unset — no clone attempted" {
  unset TARGET_REPO
  run "$ENTRYPOINT"
  # TARGET_REPO is REQUIRED — no owner fallback. The script must abort BEFORE the
  # clone with a clear stderr message.
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "TARGET_REPO is required"
  # git clone must NOT have fired.
  ! grep -q "^clone" "$GIT_LOG" 2>/dev/null || [ ! -s "$GIT_LOG" ]
}

@test "fails fast (non-zero) when TARGET_REPO is the empty string — no clone attempted" {
  # buildContainerEnvVars forwards TARGET_REPO as "" when the Worker var is unset;
  # the script must treat empty the same as unset and fail fast.
  export TARGET_REPO=""
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "TARGET_REPO is required"
  ! grep -q "^clone" "$GIT_LOG" 2>/dev/null || [ ! -s "$GIT_LOG" ]
}

@test "clone URL is built from TARGET_REPO when set" {
  # A value distinct from the setup() default proves the env var is read.
  export TARGET_REPO="example/other-repo"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q "github.com/example/other-repo.git" "$GIT_LOG"
}

@test "PR base defaults to main when TARGET_BASE_BRANCH is unset" {
  unset TARGET_BASE_BRANCH
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q -- "--base main" "$GH_LOG"
}

@test "PR base is built from TARGET_BASE_BRANCH when set (overrides the main default)" {
  export TARGET_REPO="example/target-repo"
  # A value distinct from the "main" default proves the env var is actually read.
  export TARGET_BASE_BRANCH="develop"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q -- "--base develop" "$GH_LOG"
  ! grep -q -- "--base main" "$GH_LOG"
}

@test "commit and push do NOT include --no-verify (agent never bypasses target-repo hooks)" {
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  ! grep -q "^commit .*--no-verify" "$GIT_LOG"
  ! grep -q "^push .*--no-verify" "$GIT_LOG"
}

@test "fails when WORK_ITEM_ID is missing" {
  unset WORK_ITEM_ID
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when SHORT_ID is missing" {
  unset SHORT_ID
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when TITLE is missing" {
  unset TITLE
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when GITHUB_PAT is missing" {
  unset GITHUB_PAT
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when git push exits non-zero" {
  cat > "$STUB_DIR/git" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$GIT_LOG"
if [ "$1" = "push" ]; then exit 1; fi
case "$1" in
  clone) eval "dest=\${$#}" ; mkdir -p "$dest" ; : > "$dest/README.md" ;;
esac
STUB_EOF
  chmod +x "$STUB_DIR/git"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when pnpm install exits non-zero" {
  cat > "$STUB_DIR/pnpm" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$PNPM_LOG"
exit 1
STUB_EOF
  chmod +x "$STUB_DIR/pnpm"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

@test "fails when gh pr create exits non-zero" {
  cat > "$STUB_DIR/gh" <<'STUB_EOF'
#!/bin/sh
echo "$@" >> "$GH_LOG"
exit 1
STUB_EOF
  chmod +x "$STUB_DIR/gh"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
}

# ---- per-dispatch model + cf-aig headers ----

@test "strips anthropic/ prefix before passing --model to claude (CLI rejects the provider prefix)" {
  # The agent's allow-list shape (anthropic/<id>) is the harness-routing key
  # internally (resolveHarness, src/resolve-model.ts). Anthropic's `claude` CLI
  # rejects the provider-prefixed shape — it wants bare ids or the always-latest
  # shortcuts (haiku/sonnet/opus). entrypoint.sh must strip the prefix at the
  # CLI boundary, NOT in resolveModel.
  export AGENT_MODEL="anthropic/haiku"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # The CLI received the stripped form (no anthropic/ prefix).
  grep -q -- "--model haiku" "$CLAUDE_LOG"
  # And the un-stripped form was NEVER passed to the CLI.
  ! grep -q -- "--model anthropic/" "$CLAUDE_LOG"
}

@test "strips anthropic/ prefix for versioned ids too (e.g. claude-opus-4.7 → claude-opus-4.7)" {
  export AGENT_MODEL="anthropic/claude-opus-4.7"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q -- "--model claude-opus-4.7" "$CLAUDE_LOG"
  ! grep -q -- "--model anthropic/" "$CLAUDE_LOG"
}

@test "logs both the allow-list form (cost-attribution continuity) and the CLI form (diagnostics)" {
  # The `[step] model=<allow-list> cli=<stripped>` log line keeps the existing
  # cost-attribution tag textually intact while making the post-strip CLI value
  # visible in dispatch logs for diagnostic triage.
  export AGENT_MODEL="anthropic/opus"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # step logs go to stderr, which `run` merges into $output.
  echo "$output" | grep -q "model=anthropic/opus cli=opus"
}

@test "does NOT pass --model when AGENT_MODEL is empty/unset (default behavior preserved)" {
  export AGENT_MODEL=""
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  ! grep -q -- "--model" "$CLAUDE_LOG"
}

@test "ANTHROPIC_BASE_URL is honored from ContainerEnv (no --base-url flag)" {
  export ANTHROPIC_BASE_URL="https://gateway.example/anthropic"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # claude reads ANTHROPIC_BASE_URL from the env directly — entrypoint must NOT
  # pass it as a flag.
  ! grep -q -- "--base-url" "$CLAUDE_LOG"
  grep -q "^ANTHROPIC_BASE_URL=https://gateway.example/anthropic$" "$CLAUDE_ENV_LOG"
}

@test "assembles ANTHROPIC_CUSTOM_HEADERS with cf-aig-metadata when CF_AIG_METADATA set" {
  export CF_AIG_METADATA='{"work_item_id":"wi-1","phase":"1"}'
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q 'cf-aig-metadata: {"work_item_id":"wi-1","phase":"1"}' "$CLAUDE_ENV_LOG"
}

@test "assembles ANTHROPIC_CUSTOM_HEADERS with cf-aig-authorization when AI_GATEWAY_TOKEN set" {
  export AI_GATEWAY_TOKEN="tok-123"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  grep -q "cf-aig-authorization: Bearer tok-123" "$CLAUDE_ENV_LOG"
}

@test "omits cf-aig-authorization header when AI_GATEWAY_TOKEN is unset (no broken header)" {
  unset AI_GATEWAY_TOKEN
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  ! grep -q "cf-aig-authorization" "$CLAUDE_ENV_LOG"
}

@test "omits cf-aig-metadata header when CF_AIG_METADATA is unset" {
  unset CF_AIG_METADATA
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  ! grep -q "cf-aig-metadata" "$CLAUDE_ENV_LOG"
}

# ---- OpenCode harness branch -----------------------------------------------
# These drive the AGENT_HARNESS=opencode branch in entrypoint.sh: generate
# opencode.json from the forwarded env (LiteLLM baseURL + key + LiteLLM-native
# cost metadata), then `opencode run --model … --dangerously-skip-permissions
# "<positional task>"`. NO cf-aig-* on the OSS path. The Claude branch is
# unaffected.

@test "OpenCode branch: invokes 'opencode run --model <id> --dangerously-skip-permissions' with the task positionally" {
  export AGENT_HARNESS="opencode"
  export AGENT_MODEL="deepseek/deepseek-v3"
  export OSS_MODEL_BASE_URL="https://litellm.internal/v1"
  export OSS_MODEL_API_KEY="sk-litellm-123"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # opencode (NOT claude) ran the dispatch.
  grep -q -- "run" "$OPENCODE_LOG"
  grep -q -- "--model deepseek/deepseek-v3" "$OPENCODE_LOG"
  grep -q -- "--dangerously-skip-permissions" "$OPENCODE_LOG"
  # The task text (title) is passed positionally (OpenCode has no -p for prompt).
  grep -q "Hello world" "$OPENCODE_LOG"
  ! grep -q -- "-p " "$OPENCODE_LOG"
  # The Claude branch must NOT have run on the OSS path.
  [ ! -s "$CLAUDE_LOG" ] || ! grep -q -- "--model" "$CLAUDE_LOG"
}

@test "OpenCode branch: generates opencode.json with the LiteLLM baseURL + apiKey + LiteLLM-native cost metadata (NO cf-aig)" {
  export AGENT_HARNESS="opencode"
  export AGENT_MODEL="deepseek/deepseek-v3"
  export OSS_MODEL_BASE_URL="https://litellm.internal/v1"
  export OSS_MODEL_API_KEY="sk-litellm-123"
  export CF_AIG_METADATA='{"work_item_id":"wi-test","dispatch_id":"d-test-1234abcd","harness":"opencode","phase":"2"}'
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # opencode.json carries the provider block pointing at the OSS endpoint.
  grep -q "https://litellm.internal/v1" "$OPENCODE_JSON_LOG"
  grep -q "sk-litellm-123" "$OPENCODE_JSON_LOG"
  # The DO-minted tags ride as LiteLLM-native metadata keyed by work_item_id /
  # dispatch_id (ADR-005/007) — NOT cf-aig headers.
  grep -q "wi-test" "$OPENCODE_JSON_LOG"
  grep -q "x-litellm-metadata" "$OPENCODE_JSON_LOG"
  # NO cf-aig-* anywhere on the OSS path.
  ! grep -q "cf-aig-authorization" "$OPENCODE_JSON_LOG"
  ! grep -q "cf-aig-metadata" "$OPENCODE_JSON_LOG"
}

@test "OpenCode branch: opencode.json is always VALID JSON even when a value contains a double-quote" {
  export AGENT_HARNESS="opencode"
  export AGENT_MODEL="deepseek/deepseek-v3"
  # A stray double-quote in an operator secret / cost tag must NOT corrupt the
  # generated opencode.json. String-interpolating it via a bash heredoc yields
  # malformed JSON; building it with node + JSON.stringify keeps it valid.
  export OSS_MODEL_BASE_URL='https://litellm.internal/"v1'
  export OSS_MODEL_API_KEY='sk-litellm-"123'
  export CF_AIG_METADATA='{"work_item_id":"wi-\"quote","dispatch_id":"d-test-1234abcd"}'
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # The captured opencode.json must parse as JSON (exit 0 from JSON.parse).
  # node reads the captured file from the OPENCODE_JSON_LOG (the stub `cat`ed it).
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OPENCODE_JSON_LOG"
}

@test "OpenCode branch [ERROR]: fails fast (non-zero) when OSS_MODEL_API_KEY is unset — does NOT run unconfigured" {
  export AGENT_HARNESS="opencode"
  export AGENT_MODEL="deepseek/deepseek-v3"
  export OSS_MODEL_BASE_URL="https://litellm.internal/v1"
  unset OSS_MODEL_API_KEY
  run "$ENTRYPOINT"
  # Missing OSS key ⇒ fail fast (ADR-006 fail-fast → the DO escalates to Claude),
  # rather than dialing an unconfigured/unauthenticated endpoint.
  [ "$status" -ne 0 ]
  # opencode run must NOT have been invoked with no key.
  [ ! -s "$OPENCODE_LOG" ] || ! grep -q -- "run" "$OPENCODE_LOG"
}

@test "Claude branch unchanged: AGENT_HARNESS unset still runs claude with cf-aig (no opencode)" {
  unset AGENT_HARNESS
  export AGENT_MODEL="anthropic/opus"
  export CF_AIG_METADATA='{"work_item_id":"wi-test","phase":"2"}'
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  # The Claude path ran (cf-aig assembled); opencode did NOT.
  # The CLI receives the stripped (CLI-shape) form; the cost-tag header keeps
  # the allow-list (anthropic/-prefixed) form for attribution continuity.
  grep -q -- "--model opus" "$CLAUDE_LOG"
  grep -q 'cf-aig-metadata' "$CLAUDE_ENV_LOG"
  [ ! -s "$OPENCODE_LOG" ]
}

