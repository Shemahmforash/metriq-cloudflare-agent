#!/usr/bin/env bash
#
# Provision the Cloudflare AI Gateway for the agent (open-source-llm Slice A —
# AI Gateway cost visibility, ADR-001 / ADR-004). Idempotent: creates the
# gateway when absent, reconciles its settings when present. Run in CI right
# before `wrangler deploy` (see .github/workflows/ci.yml deploy job).
#
# Why a script — not the dashboard, not Terraform:
#   The AI Gateway is an ACCOUNT-LEVEL resource reached by URL
#   (ANTHROPIC_BASE_URL), not a Worker binding — so `wrangler.toml` can't
#   declare it (wrangler only manages the Worker's own deploy unit). This keeps
#   provisioning in the SAME imperative-CLI-in-CI toolchain the repo already
#   uses for `wrangler secret put` / `wrangler deploy`, with the gateway's
#   config version-controlled HERE as the single source of truth. No second IaC
#   tool (Terraform) for one resource.
#
# Required env (the same secrets `wrangler deploy` already consumes — note the
# token must additionally carry the "AI Gateway: Edit" permission):
#   CLOUDFLARE_API_TOKEN   — API token with AI Gateway edit scope
#   CLOUDFLARE_ACCOUNT_ID  — target account id
# Optional:
#   GATEWAY_ID    — gateway slug (default: metriq-agent). Must match the
#                   ANTHROPIC_BASE_URL secret the container uses.
#   GATEWAY_AUTH  — "true" to require the cf-aig-authorization header on every
#                   request (default: false). When true you MUST also set the
#                   AI_GATEWAY_TOKEN Worker secret (entrypoint.sh forwards it as
#                   cf-aig-authorization), otherwise dispatches get 401 at the
#                   gateway. Leave false until the token is wired end-to-end.

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required (AI Gateway: Edit scope)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
GATEWAY_ID="${GATEWAY_ID:-metriq-agent}"
GATEWAY_AUTH="${GATEWAY_AUTH:-false}"

case "$GATEWAY_AUTH" in
  true|false) ;;
  *) echo "[provision-gateway] GATEWAY_AUTH must be 'true' or 'false' (got '$GATEWAY_AUTH')" >&2; exit 2 ;;
esac

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Desired settings — the version-controlled source of truth:
#   collect_logs: true  -> per-PR cost/usage rows (Slice A / KPI-1)
#   cache_ttl: 0        -> no response caching (each dispatch is unique work)
#   rate_limiting off   -> the agent's own daily cap governs volume
#   authentication      -> gated behind GATEWAY_AUTH (see header note)
SETTINGS='"cache_invalidate_on_update": true, "cache_ttl": 0, "collect_logs": true, "rate_limiting_interval": 0, "rate_limiting_limit": 0, "authentication": '"${GATEWAY_AUTH}"

# Probe for existence (GET by id -> 200 exists / 404 absent).
code=$(curl -fsS -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" "${API}/${GATEWAY_ID}" || true)

if [ "$code" = "200" ]; then
  echo "[provision-gateway] '${GATEWAY_ID}' exists -> reconciling settings (PUT)"
  method=PUT; url="${API}/${GATEWAY_ID}"; body="{ ${SETTINGS} }"
elif [ "$code" = "404" ]; then
  echo "[provision-gateway] '${GATEWAY_ID}' absent -> creating (POST)"
  method=POST; url="${API}"; body="{ \"id\": \"${GATEWAY_ID}\", ${SETTINGS} }"
else
  echo "[provision-gateway] unexpected HTTP ${code} probing gateway; aborting" >&2
  exit 1
fi

resp=$(curl -sS -X "$method" "$url" \
  -H "$AUTH_HEADER" -H 'Content-Type: application/json' -d "$body")

if printf '%s' "$resp" | grep -q '"success":true'; then
  echo "[provision-gateway] ok: '${GATEWAY_ID}' (${method}, auth=${GATEWAY_AUTH})"
else
  echo "[provision-gateway] FAILED (${method}): ${resp}" >&2
  exit 1
fi
