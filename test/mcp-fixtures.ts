/**
 * Test data factory for the pre-container MCP exchange. Every dispatch
 * test queues the same 5-message lead-in (register → wait → claim →
 * get_item → move-to-in_progress) before whatever it wants to exercise.
 * This factory produces that block with knobs for the values that
 * actually differ between tests.
 */

export type WorkItemState = "backlog" | "ready" | "in_progress" | "done";

export interface PreContainerOpts {
  dispatchId?: string;
  workItemId?: string;
  title?: string;
  description?: string;
  currentState?: WorkItemState;
  sessionId?: string;
  /**
   * Optional ticket `model` field on the wait_for_assignment payload
   * (open-source-llm Slice C / ADR-003). Omit ⇒ the payload has no `model`
   * field (the cross-system absent case). Pass "" to exercise the blank case.
   */
  ticketModel?: string;
  /**
   * Truncate the queue at one of the natural pre-container handoff points.
   * Drop-tests use `claimed`, cap-tests use `got-item`, etc. Defaults to
   * the full 5-message sequence ending with move-to-in_progress.
   */
  through?:
    | "registered"
    | "assigned"
    | "claimed"
    | "got-item"
    | "moved-to-in-progress";
  /**
   * Override the claim_assigned_task reply (lost_race / superseded
   * scenarios). Default is a successful claim against workItemId.
   */
  claim?:
    | { ok: true; work_item_id?: string }
    | { ok: false; reason: "lost_race" | "superseded" };
}

const STOPS = {
  registered: 1,
  assigned: 2,
  claimed: 3,
  "got-item": 4,
  "moved-to-in-progress": 5,
} as const;

export function preContainerQueue(opts: PreContainerOpts = {}): unknown[] {
  const dispatchId = opts.dispatchId ?? "d-1";
  const workItemId = opts.workItemId ?? "wi-1";
  const title = opts.title ?? "test-title";
  const description = opts.description ?? "demo";
  const currentState: WorkItemState = opts.currentState ?? "ready";
  const sessionId = opts.sessionId ?? "s-1";
  const through = opts.through ?? "moved-to-in-progress";

  const claim =
    opts.claim ?? ({ ok: true as const, work_item_id: workItemId });
  // Default to workItemId when caller didn't set it explicitly.
  const claimPayload =
    claim.ok && claim.work_item_id === undefined
      ? { ...claim, work_item_id: workItemId }
      : claim;

  // Only attach `model` to the payload when the test supplied it, so the
  // default fixture reproduces the real cross-system "field absent" shape.
  const payload =
    opts.ticketModel === undefined
      ? { title, description }
      : { title, description, model: opts.ticketModel };

  const full: unknown[] = [
    { session_id: sessionId },
    {
      dispatch_id: dispatchId,
      work_item_id: workItemId,
      payload,
    },
    claimPayload,
    { id: workItemId, title, currentState },
    { error: null },
  ];

  return full.slice(0, STOPS[through]);
}
