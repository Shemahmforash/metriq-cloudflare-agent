import http from "node:http";
import { spawn } from "node:child_process";
import { createJobStore } from "./job-state.mjs";

const PORT = 8080;
const ENTRYPOINT = "/app/entrypoint.sh";

// One dispatch per container instance (the DO addresses us by
// idFromName(dispatchId) and runs serially). The DO fires POST /start, which
// spawns entrypoint.sh and returns 202 immediately, then polls GET /status on
// a short cycle until the job is done/failed. This decouples the long agent
// run from the DO's 15-min alarm wall-clock ceiling.
const jobs = createJobStore();

// Exported + spawn-injectable so test/server-env.test.mjs can assert the
// ctx → child-env mapping without booting a real container or HTTP listener.
export function spawnEntrypoint(ctx, spawnFn = spawn) {
  return spawnFn(ENTRYPOINT, [], {
    env: {
      ...process.env,
      WORK_ITEM_ID: ctx.work_item_id ?? "",
      DISPATCH_ID: ctx.dispatch_id ?? "",
      SHORT_ID: ctx.short_id ?? "",
      TITLE: ctx.title ?? "",
      DESCRIPTION: ctx.description ?? "",
      // Per-dispatch values carried from the /start body: the resolved model
      // (claude --model) and the cost-attribution tags (entrypoint exports them
      // as cf-aig-metadata). Serialize cost_tags to a JSON string for transport
      // through the process env.
      AGENT_MODEL: ctx.model ?? "",
      CF_AIG_METADATA: ctx.cost_tags ? JSON.stringify(ctx.cost_tags) : "",
      // ADR-005: the resolved harness rides
      // the /start body too. entrypoint.sh branches claude (unset/empty) vs
      // opencode on it. Empty string (not undefined) when absent so the shell
      // sees a defined-but-empty var and falls through to the claude path.
      AGENT_HARNESS: ctx.harness ?? "",
    },
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://container");

  // POST /start — spawn the dispatch and return immediately. The child keeps
  // running in the container after this response; /status reports its outcome.
  if (req.method === "POST" && url.pathname === "/start") {
    let ctx;
    try {
      ctx = JSON.parse((await readBody(req)) || "{}");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid json");
      return;
    }
    console.log(
      `[container] /start dispatch_id=${ctx.dispatch_id ?? "?"} work_item_id=${ctx.work_item_id ?? "?"}`,
    );
    const child = jobs.start(ctx, spawnEntrypoint);
    // Mirror child output to the container's own stdout/stderr so it shows up
    // in Cloudflare logs (the job store keeps its own buffered copy).
    child.stdout.on("data", (s) => process.stdout.write(`[entrypoint] ${s}`));
    child.stderr.on("data", (s) => process.stderr.write(`[entrypoint:err] ${s}`));
    child.on("error", (err) => console.error("[container] spawn error:", err));
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("started");
    return;
  }

  // GET /status?dispatch_id=X — running | done{stdoutTail} | failed{code,bodyTail}
  // | unknown (no job for that id; container restarted or never started it).
  if (req.method === "GET" && url.pathname === "/status") {
    const dispatchId = url.searchParams.get("dispatch_id") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jobs.status(dispatchId)));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// Only bind the port when run directly (node /app/server.js in the container).
// When imported by a test (server-env.test.mjs) we expose spawnEntrypoint
// without starting the HTTP listener.
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`[container] listening on :${PORT}`);
  });
}
