# Security Policy

## Supported versions

This project is a single deployed Cloudflare Worker, not a released library.
Only the current `main` branch is supported — fixes land there and deploy
forward. There are no maintained release branches.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Open a private [GitHub Security Advisory](https://github.com/Shemahmforash/metriq-cloudflare-agent/security/advisories/new) on this repository, **or**
- email the maintainer at `cmrosao@gmail.com`.

Include enough detail to reproduce. You'll get an acknowledgement as soon as
the report is triaged.

## Secret-handling posture

- **All secrets flow through `wrangler secret put`** and are injected at runtime
  via the Worker `Env` — they are **never committed**.
- `.env` is a **names-only template** (committed). Real values live in
  `.env.local` / `.dev.vars`, which are gitignored.
- No secret is passed as a CLI positional argument (that leaks to shell history
  and logs). `wrangler secret put NAME` reads the value from an interactive
  prompt or stdin only.

## Access control on the public Worker

The control and debug routes (`/wake`, `/stop`, `/pause`, `/resume`, `/debug`)
require a bearer token: `Authorization: Bearer <CONTROL_TOKEN>`. The token is
set via `wrangler secret put CONTROL_TOKEN`. The check is **fail-closed** — if
`CONTROL_TOKEN` is unset, those routes reject every request. Only `/health`
(GET) is unauthenticated.

The container's internal HTTP server is intentionally unauthenticated: Cloudflare
container networking is private to the Worker binding and is not reachable from
the public internet.
