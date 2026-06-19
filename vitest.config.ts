import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Only the workers-pool TS suites. container/*.mjs has its own Node-level
    // tests (test/*.test.mjs) run via `node --test` — they import node:test and
    // node:child_process, which don't exist in the workerd runtime.
    include: ["test/**/*.test.ts"],
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
