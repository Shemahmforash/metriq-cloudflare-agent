import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Only the workers-pool TS suites. container/*.mjs has its own Node-level
    // tests (test/*.test.mjs) run via `node --test` — they import node:test and
    // node:child_process, which don't exist in the workerd runtime.
    include: ["test/**/*.test.ts"],
    // Retry on CI ONLY, to absorb the rare @cloudflare/vitest-pool-workers
    // cross-file isolated-storage flake ("Isolated storage failed … .sqlite-shm")
    // that surfaces under CI timing/resource pressure and passes on re-run. Local
    // runs stay strict (retry: 0) so genuinely flaky tests surface during dev. A
    // persistently failing test still fails — only the rare isolation race is
    // absorbed, not real breakage.
    retry: process.env.CI ? 2 : 0,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            METRIQ_API_KEY: "test-api-key",
            METRIQ_MCP_URL: "https://example.test/api/v1/mcp",
            RETRY_DELAY_MS: "0",
            // Used by notifyFailure() — tests intercept api.github.com calls
            // and assert the issue create fires.
            GITHUB_PAT: "test-github-pat",
            GITHUB_USER: "test-agent",
            ANTHROPIC_API_KEY: "test-anthropic-key",
            ALERT_GITHUB_REPO: "TestOwner/test-repo",
            CONTROL_TOKEN: "test-token",
          },
        },
      },
    },
  },
});
