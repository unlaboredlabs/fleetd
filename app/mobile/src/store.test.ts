import { describe, expect, it } from "vitest";
import type { ChatMessage, HubEvent } from "./desktop";
import { effectsOf, initial, reduce } from "./store";

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

  it("an agent starting, ending or moving reads the orders board again, which counts each project's agents at work", () => {
    expect(effectsOf(event("task.started")).board).toBe(true);
    expect(effectsOf(event("workstream.closed")).board).toBe(true);
    expect(effectsOf(event("chat.message")).board).toBe(false);
    const p1 = { machineId: "devbox", projectId: "p1" };
    const lane = (laneId: string, role: string, status: string) => ({ laneId, role, status, title: laneId });
    const orders = [
      { projectRef: p1, lanes: [lane("lead", "lead", "working"), lane("a", "writer", "working"), lane("b", "reviewer", "starting"), lane("c", "writer", "done")] },
      // The same agent on a second order counts once.
      { projectRef: p1, lanes: [lane("a", "writer", "working")] },
      { projectRef: { machineId: "devbox", projectId: "p2" }, lanes: [lane("d", "writer", "failed")] },
    ] as never;
    const s = reduce(initial({ phase: "live", hub: "http://devbox:4790" } as never), { t: "board", orders });
    expect(s.running).toEqual({ "devbox/p1": 2 });
  });

  it("opens a chat on the newest messages the list holds, shown until its latest page starts it over", () => {
    const m = (seq: number): ChatMessage => ({ messageId: `m${String(seq)}`, projectRef: { machineId: "m1", projectId: "p" }, seq, author: "lead", text: "hi", attachments: [], createdAt: "2026-11-07T10:00:00.000Z", state: "final" });
    const s = { ...initial({ phase: "live", hub: "http://devbox:4790" } as never), latest: { "m1/p": [m(8), m(9)] } };
    expect(reduce(s, { t: "chat_open", key: "m1/p" }).chats["m1/p"]).toMatchObject({ messages: [m(8), m(9)], cached: true, loaded: false });
    expect(reduce(s, { t: "chat_open", key: "m1/q" }).chats["m1/q"]).toMatchObject({ messages: [], loaded: false });
  });
});
