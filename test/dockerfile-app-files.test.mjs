// Guards against the class of bug where container/server.js gains a new local
// import (e.g. `./job-state.mjs`) but the Dockerfile's COPY into /app is not
// updated to ship it. The missing file makes `node /app/server.js` die with
// ERR_MODULE_NOT_FOUND before binding port 8080, which the @cloudflare/containers
// runtime surfaces as "Container crashed while checking for ports". Runs under
// `node --test` (the test:container script) since it only reads repo files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = readFileSync(`${root}container/server.js`, "utf8");
const dockerfile = readFileSync(`${root}container/Dockerfile`, "utf8");

// Relative (local-file) imports in server.js — node builtins (node:*) and bare
// package specifiers are shipped by other means and intentionally excluded.
function relativeImports(src) {
  const out = new Set();
  const re = /\bfrom\s+["'](\.\.?\/[^"']+)["']/g;
  for (const m of src.matchAll(re)) out.add(m[1].split("/").pop());
  return out;
}

// Basenames of files COPYed into /app (handles --flags and the trailing dest).
function filesCopiedToApp(df) {
  const out = new Set();
  for (const line of df.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("COPY ")) continue;
    const toks = t.slice(5).split(/\s+/).filter((x) => !x.startsWith("--"));
    const dest = toks.at(-1);
    if (dest !== "/app" && dest !== "/app/") continue;
    for (const src of toks.slice(0, -1)) out.add(src.split("/").pop());
  }
  return out;
}

test("every local import in container/server.js is COPYed into the image's /app", () => {
  const imports = relativeImports(server);
  const copied = filesCopiedToApp(dockerfile);
  assert.ok(imports.size > 0, "expected server.js to have at least one local import");
  const missing = [...imports].filter((f) => !copied.has(f));
  assert.deepEqual(
    missing,
    [],
    `server.js imports ${JSON.stringify(missing)} but the Dockerfile never COPYs them into /app ` +
      `(copied: ${JSON.stringify([...copied])}). The container will crash on boot with ERR_MODULE_NOT_FOUND.`,
  );
});

// ADR-005 Part C: the OSS path runs `opencode run` in the container. The
// harness MUST be installed in the image — the bats suite only passes because
// it PATH-stubs `opencode`, which would never catch a missing install in the
// real image (the OSS dispatch would die with "opencode: command not found").
// Pin it EXACTLY to the validated version so the bake-off measures the version
// it was validated against (ADR-005 reproducibility).
test("Dockerfile pins the OpenCode harness to opencode-ai@1.15.11", () => {
  assert.match(
    dockerfile,
    /npm install -g\b[^\n]*\bopencode-ai@1\.15\.11\b/,
    "the OSS path runs `opencode run` in the container, but the Dockerfile does " +
      "not `npm install -g opencode-ai@1.15.11`. Without it the real image has no " +
      "opencode binary and every OSS dispatch dies with 'opencode: command not found' " +
      "(the bats tests pass only because they PATH-stub opencode).",
  );
});
