// In-memory job store for a single dispatch. Each container instance handles
// exactly one dispatch at a time (the DO addresses it by idFromName(dispatchId)
// and the loop is serial), so one `job` slot suffices.
//
// The store is decoupled from node:http and node:child_process: `start` takes a
// `spawnFn(ctx) → childProcess` so server.js can inject the real spawn and
// tests can inject a fake EventEmitter child. The store only wires the child's
// stdout/stderr/exit/error to job state; callers may attach their own
// listeners (e.g. server.js mirrors output to the container's stdout for CF
// logs) since EventEmitters fan out to every listener.

// Response body caps. stdout tail on success carries the PR URL (last line);
// combined stdout+stderr tail on failure is the diagnostic excerpt.
const SUCCESS_BODY_BYTES = 4096;
const ERROR_BODY_BYTES = 8000;

export function createJobStore() {
  /** @type {{dispatchId:string,status:string,stdout:string,combined:string,code:number|null}|null} */
  let job = null;

  return {
    /**
     * Spawn the dispatch child and begin tracking its output + exit. Returns
     * the child so the caller can attach extra listeners (log mirroring).
     */
    start(ctx, spawnFn) {
      const dispatchId = ctx.dispatch_id ?? "";
      job = { dispatchId, status: "running", stdout: "", combined: "", code: null };
      const child = spawnFn(ctx);

      child.stdout.on("data", (chunk) => {
        const s = chunk.toString();
        if (job && job.dispatchId === dispatchId) {
          job.stdout += s;
          job.combined += s;
        }
      });
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        if (job && job.dispatchId === dispatchId) job.combined += s;
      });
      // Listen on "exit" (not "close") because "close" waits for stdio streams
      // to close — a grandchild process holding our stdout/stderr fd open
      // (gh CLI telemetry, git credential helper, etc.) can prevent close from
      // firing indefinitely even after bash exits cleanly. The 2026-05-31
      // incident (dispatch 567d041d, PR #12 created but the work item orphaned
      // in_progress for 5 min until the watchdog killed monitoring) was
      // exactly this race.
      //
      // data listeners on stdout/stderr keep firing through stream flush, so
      // all captured output (including the PR URL emitted by `echo "$PR_URL"`
      // right before bash exits) is already in job.stdout by the time exit
      // fires.
      child.on("exit", (code) => {
        if (job && job.dispatchId === dispatchId) {
          job.code = code;
          job.status = code === 0 ? "done" : "failed";
        }
      });
      child.on("error", (err) => {
        if (job && job.dispatchId === dispatchId) {
          job.status = "failed";
          job.combined += `spawn error: ${err.message}`;
        }
      });

      return child;
    },

    /**
     * Snapshot of the job for the given dispatch. `unknown` means this instance
     * has no record of that dispatch — it was never started here, or the
     * container restarted and lost its memory. The DO treats `unknown` as a
     * terminal failure (sweeper reclaims).
     */
    status(dispatchId) {
      if (!job || job.dispatchId !== dispatchId) return { status: "unknown" };
      if (job.status === "running") return { status: "running" };
      if (job.status === "done") {
        return { status: "done", stdoutTail: job.stdout.slice(-SUCCESS_BODY_BYTES) };
      }
      return {
        status: "failed",
        code: job.code,
        bodyTail: job.combined.slice(-ERROR_BODY_BYTES),
      };
    },
  };
}
