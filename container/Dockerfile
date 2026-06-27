# Slice 5: git + gh + pnpm + Claude Code CLI.
# Force linux/amd64 — Cloudflare Containers run amd64; building on M-series
# Macs without this can ship arm64 native binaries (esbuild, etc.) that
# crash at dispatch time.
# Pinned by digest (supply-chain integrity): the mutable tag is kept in the
# trailing comment for legibility. Re-resolve + bump deliberately when updating.
FROM --platform=linux/amd64 node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc # node:24-slim

# git for clone, gh for PR, pnpm via corepack. curl + ca-certificates needed
# only for the gh APT repo bootstrap.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Claude Code CLI — invoked by entrypoint.sh as `claude -p "Task: ..."`
# using ANTHROPIC_API_KEY from the container env. Pinned EXACTLY (supply-chain
# integrity): this is the most-privileged binary in the image — it runs
# --dangerously-skip-permissions with secrets in env — so it must not float on
# trust-on-first-use. Bump deliberately, mirroring opencode-ai below.
RUN npm install -g @anthropic-ai/claude-code@2.1.195
# Fail the build early if the install is broken (no network/creds for --version).
RUN claude --version

# OpenCode CLI — the OSS harness. entrypoint.sh invokes it as
# `opencode run --model … "<task>"` when AGENT_HARNESS=opencode (the
# model-derived OSS path, ADR-005). Pinned EXACTLY to the SPIKE-validated
# version so the bake-off measures the same binary it was validated against.
# Without this install the real image has no opencode binary and every OSS
# dispatch dies with "opencode: command not found".
RUN npm install -g opencode-ai@1.15.11
# Fail the build early if the install is broken (no network/creds needed for
# --version, unlike `opencode models`).
RUN opencode --version

# Pre-bake node_modules so dispatch-time `pnpm install` is a lockfile-diff
# (fast) instead of a full download (slow). Sourced from container/baked/,
# which ships a generic placeholder manifest by default and can be synced
# from a specific target repo via scripts/sync-baked-lockfile.sh (re-run +
# redeploy when that repo's lockfile drifts). On a lockfile mismatch the
# entrypoint still gets a warm pnpm store, just not a verbatim
# node_modules copy.
RUN mkdir -p /baked && chown -R node:node /baked

# Switch to the `node` user (uid 1000, baked into node:24-slim) for runtime.
# Claude Code refuses `--dangerously-skip-permissions` when running as root.
RUN mkdir -p /app && chown -R node:node /app
USER node

WORKDIR /baked
COPY --chown=node:node baked/package.json baked/pnpm-lock.yaml baked/pnpm-workspace.yaml /baked/
RUN pnpm install --frozen-lockfile --ignore-scripts

WORKDIR /app
COPY --chown=node:node server.js entrypoint.sh job-state.mjs /app/
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080
CMD ["node", "/app/server.js"]
