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
    const e = event("request.updated", { requestId: "Q3", kind: "secret", state: "answered" });
    expect(isEvent(e, "request.opened", "request.updated") && eventData(e)?.requestId).toBe("Q3");
    expect(isEvent(e, "task.started")).toBe(false);
  });

  it("treats data the hub cut for size as absent, and a newer hub's type as generic", () => {
    const cut = event("pr.merged", { truncated: true });
    expect(isEvent(cut, "pr.merged") && eventData(cut)).toBeUndefined();
    expect(isEvent(event("rocket.launched", { x: 1 }), "pr.merged")).toBe(false);
  });
});
