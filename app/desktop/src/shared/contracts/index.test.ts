import { describe, expect, it } from "vitest";
import { eventData, isEvent, type HubEvent } from "./index";

const event = (type: string, data?: unknown): HubEvent => ({
  seq: 7,
  at: "2026-10-19T00:00:00.000Z",
  type,
  summary: type,
  ...(data === undefined ? {} : { data }),
});

describe("hub events", () => {
  it("narrows by type and reads the declared data", () => {
    const e = event("ask.answered", { askId: "A3", undoUntil: "2026-10-19T00:00:10.000Z" });
    expect(isEvent(e, "ask.created", "ask.answered") && eventData(e)?.askId).toBe("A3");
    expect(isEvent(e, "task.started")).toBe(false);
  });

  it("treats data the hub cut for size as absent, and a newer hub's type as generic", () => {
    const cut = event("pr.merged", { truncated: true });
    expect(isEvent(cut, "pr.merged") && eventData(cut)).toBeUndefined();
    expect(isEvent(event("rocket.launched", { x: 1 }), "pr.merged")).toBe(false);
  });
});
