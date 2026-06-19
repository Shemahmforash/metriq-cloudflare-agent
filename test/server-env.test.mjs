// Node-level unit tests for the container HTTP server's ctx → child-env mapping
// (container/server.js spawnEntrypoint). Runs under `node --test` (NOT the
// workers vitest pool) because server.js is plain Node that never executes in
// workerd. spawnEntrypoint is exported and accepts an injectable spawn function
// so we can capture the env handed to the child WITHOUT booting a real
// container or the HTTP listener.
//
// open-source-llm Slice A (01-04): the per-dispatch `model` + `cost_tags` ride
// the POST /start body; server.js must forward them to the entrypoint child as
// AGENT_MODEL and CF_AIG_METADATA (a JSON string) so entrypoint.sh can pass
// `--model` and assemble cf-aig-metadata. Constants (ANTHROPIC_BASE_URL,
// AI_GATEWAY_TOKEN) ride ContainerEnv and are already in process.env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnEntrypoint } from "../container/server.js";

/** Capture the env passed to spawn without actually spawning anything. */
function captureEnv(ctx) {
  let captured;
  const fakeSpawn = (_cmd, _args, opts) => {
    captured = opts.env;
    return { stdout: {}, stderr: {}, on() {} };
  };
  spawnEntrypoint(ctx, fakeSpawn);
  return captured;
}

test("forwards ctx.model to the child as AGENT_MODEL", () => {
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
    model: "anthropic/claude-opus-4.7",
  });
  assert.equal(env.AGENT_MODEL, "anthropic/claude-opus-4.7");
});

test("forwards ctx.cost_tags to the child as CF_AIG_METADATA (JSON string)", () => {
  const cost_tags = {
    dispatch_id: "d-1",
    work_item_id: "wi-1",
    short_id: "d-1",
    model: "anthropic/claude-opus-4",
    source: "ticket",
    phase: "1",
  };
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
    model: "anthropic/claude-opus-4",
    cost_tags,
  });
  assert.equal(env.CF_AIG_METADATA, JSON.stringify(cost_tags));
});

test("AGENT_MODEL is empty (not undefined) when ctx.model is absent", () => {
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
  });
  assert.equal(env.AGENT_MODEL, "");
});

test("CF_AIG_METADATA is empty (not undefined) when ctx.cost_tags is absent", () => {
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
  });
  assert.equal(env.CF_AIG_METADATA, "");
});

// ---- open-source-llm Phase 2 / Slice D (ADR-005): forward the resolved
// `harness` from the /start body to the entrypoint child as AGENT_HARNESS, so
// entrypoint.sh branches claude vs opencode. RED until server.js forwards it.

test("forwards ctx.harness to the child as AGENT_HARNESS", () => {
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
    model: "deepseek/deepseek-v3",
    harness: "opencode",
  });
  assert.equal(env.AGENT_HARNESS, "opencode");
});

test("AGENT_HARNESS is empty (not undefined) when ctx.harness is absent", () => {
  const env = captureEnv({
    work_item_id: "wi-1",
    dispatch_id: "d-1",
    short_id: "d-1",
    title: "t",
  });
  assert.equal(env.AGENT_HARNESS, "");
});
