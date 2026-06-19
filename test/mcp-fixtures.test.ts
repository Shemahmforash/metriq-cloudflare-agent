import { describe, expect, it } from "vitest";
import { preContainerQueue } from "./mcp-fixtures";

describe("preContainerQueue", () => {
  it("returns the full 5-message register→wait→claim→get→move sequence by default", () => {
    const q = preContainerQueue();
    expect(q).toHaveLength(5);
    expect(q[0]).toEqual({ session_id: "s-1" });
    expect(q[1]).toEqual({
      dispatch_id: "d-1",
      work_item_id: "wi-1",
      payload: { title: "test-title", description: "demo" },
    });
    expect(q[2]).toEqual({ ok: true, work_item_id: "wi-1" });
    expect(q[3]).toEqual({
      id: "wi-1",
      title: "test-title",
      currentState: "ready",
    });
    expect(q[4]).toEqual({ error: null });
  });

  it("honors dispatchId, workItemId, title and currentState overrides", () => {
    const q = preContainerQueue({
      dispatchId: "d-X",
      workItemId: "wi-X",
      title: "my-task",
      currentState: "backlog",
    });
    expect(q[1]).toEqual({
      dispatch_id: "d-X",
      work_item_id: "wi-X",
      payload: { title: "my-task", description: "demo" },
    });
    expect(q[2]).toEqual({ ok: true, work_item_id: "wi-X" });
    expect(q[3]).toEqual({
      id: "wi-X",
      title: "my-task",
      currentState: "backlog",
    });
  });

  it("supports description override (some tests assert on it)", () => {
    const q = preContainerQueue({ description: "custom desc" });
    expect(q[1]).toMatchObject({
      payload: { description: "custom desc" },
    });
  });

  it("can stop early via `through` so cap/drop tests don't queue stages they never reach", () => {
    expect(preContainerQueue({ through: "registered" })).toHaveLength(1);
    expect(preContainerQueue({ through: "assigned" })).toHaveLength(2);
    expect(preContainerQueue({ through: "claimed" })).toHaveLength(3);
    expect(preContainerQueue({ through: "got-item" })).toHaveLength(4);
    expect(preContainerQueue({ through: "moved-to-in-progress" })).toHaveLength(
      5,
    );
  });

  it("when claim fails (lost_race / superseded) replaces the claim payload accordingly", () => {
    const q = preContainerQueue({
      through: "claimed",
      claim: { ok: false, reason: "lost_race" },
    });
    expect(q[2]).toEqual({ ok: false, reason: "lost_race" });
  });
});
