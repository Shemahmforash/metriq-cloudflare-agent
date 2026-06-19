// Node-level unit tests for the container's job store. Runs under `node --test`
// (NOT the workers vitest pool) because container/server.js is plain Node that
// never executes in workerd. The store is spawn-injected so we drive it with a
// fake child process and assert the running→done / running→failed / unknown
// transitions without booting a real container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJobStore } from "../container/job-state.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const CTX = { dispatch_id: "d-1", work_item_id: "wi-1", short_id: "d-1", title: "t" };

test("status is unknown for an id that was never started", () => {
  const store = createJobStore();
  assert.deepEqual(store.status("nope"), { status: "unknown" });
});

test("status is running right after start, before the child closes", () => {
  const store = createJobStore();
  store.start(CTX, () => fakeChild());
  assert.deepEqual(store.status("d-1"), { status: "running" });
});

test("running → done on exit 0, stdoutTail carries the PR URL", () => {
  const store = createJobStore();
  const child = fakeChild();
  store.start(CTX, () => child);
  child.stdout.emit("data", Buffer.from("[step] working\n"));
  child.stdout.emit("data", Buffer.from("https://github.com/o/r/pull/9\n"));
  child.emit("exit", 0);

  const s = store.status("d-1");
  assert.equal(s.status, "done");
  assert.match(s.stdoutTail, /https:\/\/github\.com\/o\/r\/pull\/9/);
});

// Regression: 2026-05-31 production incident (dispatch 567d041d, PR #12).
// Bash entrypoint exited 0 and `echo "$PR_URL"` was captured in stdout, but
// a grandchild (gh CLI telemetry, git credential helper, etc.) held the
// inherited stdout/stderr fd open, so Node's child_process "close" event
// never fired. The DO's /status poll saw {status:"running"} for 5 min until
// the 15-min watchdog killed it, leaving the work item orphaned even though
// the PR existed. The fix: listen on "exit" (which fires the instant the
// process itself exits, independent of grandchildren holding stdio) instead
// of "close" (which waits for all stdio streams to close).
test("done on 'exit' even when 'close' never fires (grandchild holds stdio)", () => {
  const store = createJobStore();
  const child = fakeChild();
  store.start(CTX, () => child);
  child.stdout.emit("data", Buffer.from("[step] working\n"));
  child.stdout.emit("data", Buffer.from("https://github.com/o/r/pull/12\n"));
  // Emit ONLY 'exit' — never 'close'. Simulates a grandchild keeping the
  // inherited stdio descriptors open after bash itself has exited cleanly.
  child.emit("exit", 0);

  const s = store.status("d-1");
  assert.equal(s.status, "done");
  assert.match(s.stdoutTail, /https:\/\/github\.com\/o\/r\/pull\/12/);
});

test("running → failed on non-zero exit, bodyTail carries stderr + exit code", () => {
  const store = createJobStore();
  const child = fakeChild();
  store.start(CTX, () => child);
  child.stdout.emit("data", Buffer.from("[step] clone-ok\n"));
  child.stderr.emit("data", Buffer.from("fatal: boom\n"));
  child.emit("exit", 1);

  const s = store.status("d-1");
  assert.equal(s.status, "failed");
  assert.equal(s.code, 1);
  assert.match(s.bodyTail, /fatal: boom/);
});

test("spawn 'error' event marks the job failed", () => {
  const store = createJobStore();
  const child = fakeChild();
  store.start(CTX, () => child);
  child.emit("error", new Error("ENOENT entrypoint"));

  const s = store.status("d-1");
  assert.equal(s.status, "failed");
  assert.match(s.bodyTail, /ENOENT entrypoint/);
});

test("status for a different dispatch than the running one is unknown", () => {
  const store = createJobStore();
  store.start(CTX, () => fakeChild());
  assert.deepEqual(store.status("d-other"), { status: "unknown" });
});
