# Contributing

Thanks for your interest in `metriq-cloudflare-agent`. This is a small, test-driven
codebase; the bar for changes is "tests first, green before commit".

## Prerequisites

- **Node** ≥ 22 (CI and the container run on Node 24; ≥22 is enough for the test suite)
- **pnpm** 10 (`packageManager` pins the exact version)
- A **Cloudflare account** with Workers + Containers (only needed to deploy/run live; not to run the test suite)
- **wrangler** (installed as a dev dependency — use `pnpm wrangler …`)

## Setup

```bash
pnpm install
pnpm exec lefthook install   # one-time per clone — wires the git hooks
```

## Running the tests

```bash
pnpm typecheck                       # tsc --noEmit
pnpm test                            # vitest on workerd via @cloudflare/vitest-pool-workers
pnpm test:container                  # node --test test/*.test.mjs (container job-store + env/Dockerfile checks)
pnpm exec bats test/entrypoint.bats  # shell tests for the container entrypoint
```

The full suite runs without a Cloudflare account — vitest uses the local workerd
pool, and the container/entrypoint tests stub all external commands.

## Git hooks

[lefthook](https://github.com/evilmartians/lefthook) gates the repo:

- **pre-push** runs typecheck + vitest + container + bats in parallel.
- The hooks are **not optional**. **Never use `--no-verify` and never bypass a hook.**
  If a hook fails, fix the underlying issue — a red hook is the safety net working.

## Expectations for a change

1. **Tests are mandatory for every code change** — including "trivial" fixes.
   Write the test, watch it fail, then write the implementation (TDD). The
   existing history is outside-in TDD; please keep that rhythm.
2. **Keep the bar green.** Don't commit with failing tests or a failing typecheck.
3. **Update the README on every feature touch** — documentation drift is a bug.
4. **No secrets in CLI args or commits.** Secrets flow via `wrangler secret put`
   (interactive prompt / stdin only). See [SECURITY.md](SECURITY.md).

## Commit style

The history uses [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, `docs:`, scoped where it helps — e.g.
`feat(security): …`). Please match it.
