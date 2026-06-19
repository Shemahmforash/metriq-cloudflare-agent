export interface RegisterSessionResponse {
  session_id: string;
}
export interface WaitResponse {
  dispatch_id: string | null;
  work_item_id?: string;
  // open-source-llm Slice C / ADR-003: optional ticket `model` surfaced from the
  // MCP payload. Optional ⇒ a Metriq payload without the field deserializes fine
  // (cross-system absence-tolerance). Blank/whitespace is treated as absent by
  // resolveModel. Owned by Metriq; agent degrades to default.
  payload?: { title?: string; description?: string; model?: string };
}
export interface EndSessionResponse {
  ok: boolean;
}
export type ClaimResponse =
  | { ok: true; work_item_id: string }
  | { ok: false; reason: "superseded" | "lost_race" };
export interface ReportArtifactResponse {
  artifact_id: string;
  posted_at: string;
}
export interface MoveItemResponse {
  error: string | null;
  blessingRequested?: boolean;
}
export type WorkItemState = "backlog" | "ready" | "in_progress" | "done";
export interface WorkItemSummary {
  id: string;
  title: string;
  currentState: WorkItemState;
  // open-source-llm Slice C / ADR-003: optional ticket `model` if read via
  // get_item. Same absence-tolerance as WaitResponse.payload.model.
  model?: string;
}
