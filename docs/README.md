# Documentation

Design and research docs for the Cloudflare-hosted agent runtime. Start with the
[project README](../README.md) for setup, deployment, and operation.

## Architecture

A set of Architecture Decision Records (ADRs) capturing the load-bearing design
choices.

- [ADR-001 — AI Gateway interposition](product/architecture/adr-001-ai-gateway-interposition.md)
- [ADR-002 — Model resolution precedence](product/architecture/adr-002-model-resolution-precedence.md)
- [ADR-003 — Model validation allowlist](product/architecture/adr-003-model-validation-allowlist.md)
- [ADR-004 — Per-PR cost attribution](product/architecture/adr-004-per-pr-cost-attribution.md)
- [ADR-005 — Harness selection and OpenCode config](product/architecture/adr-005-harness-selection-and-opencode-config.md)
- [ADR-006 — OSS provider routing and allowlist extension](product/architecture/adr-006-oss-provider-routing-and-allowlist-extension.md)
- [ADR-007 — Cost tag: harness and fallback dimension](product/architecture/adr-007-cost-tag-harness-and-fallback-dimension.md)
- [ADR-008 — Auto-escalation OSS to Claude](product/architecture/adr-008-auto-escalation-oss-to-claude.md)
- [ADR-009 — Decoupling dispatch from the alarm](product/architecture/adr-009-alarm-dispatch-decoupling.md)

## Research

- [Open-source LLM feasibility](research/open-source-llm/open-source-llm-feasibility-comprehensive-research.md) —
  the feasibility study behind the model-agnostic and OSS-harness work.

## Evolution

- [Open-source LLM evolution](evolution/open-source-llm-evolution.md) — how the
  operator-controllable model / OSS-harness capability was built, phase by phase.
