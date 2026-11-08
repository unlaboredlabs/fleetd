import { describe, expect, it } from "vitest";
import type { HubEvent } from "./desktop";
import { effectsOf } from "./store";

const event = (type: string, extra: Partial<HubEvent> = {}): HubEvent => ({ seq: 1, at: "2026-11-07T10:00:00.000Z", type, summary: type, ...extra });

describe("what an event reads again", () => {
  it("a project or machine coming or going reads the snapshot again, so its chats leave the list at once", () => {
    expect(effectsOf(event("project.removed")).snapshot).toBe(true);
    expect(effectsOf(event("project.added")).snapshot).toBe(true);
    // The hub erased the machine's projects with it: their chats go without a restart.
    expect(effectsOf(event("machine.removed", { machineId: "devbox" })).snapshot).toBe(true);
    expect(effectsOf(event("machine.offline", { machineId: "devbox" })).snapshot).toBe(false);
  });

  it("a change to the hub's people (a new picture) reads who the person is again", () => {
    expect(effectsOf(event("people.changed")).info).toBe(true);
    expect(effectsOf(event("project.settings")).info).toBe(false);
  });
});
