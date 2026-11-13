import { describe, expect, it } from "vitest";
import { botOf } from "./botState";
import { leadLaneId } from "./desktop";

const KEY = "devbox/p1";
const ref = { machineId: "devbox", projectId: "p1" };
const base = { chatStates: {}, requests: [], leadActivity: {}, running: {} };

describe("a project's bot on the phone", () => {
  it("is idle, done with a new reply, at work while its lead works, and needs you over all", () => {
    expect(botOf(base, KEY)).toBe("idle");
    expect(botOf(base, KEY, true)).toBe("done");
    const lead = { ...base, chatStates: { [KEY]: { projectRef: ref, needsYou: false, leadWorking: true } } };
    const working = lead as never;
    expect(botOf(working, KEY, true)).toBe("working");
    const thinking = { ...lead, leadActivity: { [leadLaneId(ref)]: { kind: "thinking" } } } as never;
    expect(botOf(thinking, KEY)).toBe("thinking");
    const waiting = { ...base, chatStates: { [KEY]: { projectRef: ref, needsYou: true, leadWorking: true } } } as never;
    expect(botOf(waiting, KEY)).toBe("needs");
    const asked = { ...base, requests: [{ requestId: "Q1", projectRef: ref, kind: "approval", state: "open", text: "", createdAt: "" }] } as never;
    expect(botOf(asked, KEY)).toBe("needs");
  });

  it("needs only the person a question or a card is for", () => {
    const theirs = {
      ...base,
      chatStates: { [KEY]: { projectRef: ref, needsYou: true, needsYouFor: ["p_dana"], leadWorking: false } },
      requests: [{ requestId: "Q1", projectRef: ref, kind: "approval", state: "open", text: "", createdAt: "", for: { personId: "p_dana", name: "Dana" } }],
    } as never;
    expect(botOf({ ...(theirs as object), me: "p_sam" } as never, KEY)).toBe("idle");
    expect(botOf({ ...(theirs as object), me: "p_dana" } as never, KEY)).toBe("needs");
  });

  it("works while its agents do, its lead idle or thinking, as the desktop's", () => {
    const agents = { ...base, running: { [KEY]: 2 } };
    expect(botOf(agents, KEY)).toBe("working");
    expect(botOf(agents, KEY, true)).toBe("working");
    const thinking = { ...agents, chatStates: { [KEY]: { projectRef: ref, needsYou: false, leadWorking: true } }, leadActivity: { [leadLaneId(ref)]: { kind: "thinking" } } } as never;
    expect(botOf(thinking, KEY)).toBe("working");
    expect(botOf({ ...base, running: { "devbox/p2": 1 } }, KEY)).toBe("idle");
  });
});
