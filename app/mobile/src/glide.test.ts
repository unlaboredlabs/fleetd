import { describe, expect, it } from "vitest";
import type { ThreadRow } from "./chatView";
import type { ChatItem } from "./desktop";
import { GLIDE, glideOf } from "./glide";

const row = (id: string, side: "me" | "them", state: ChatItem["state"] = "sent"): ThreadRow => ({
  t: "item",
  id,
  side,
  first: true,
  item: { id, author: side === "me" ? "human" : "lead", kind: "message", text: id, at: "", attachments: [], state },
});

describe("the spring the thread glides on", () => {
  it("is the newest message's: a reply's, your send's, or a streaming reply's growing one", () => {
    expect(glideOf([row("b", "them"), row("a", "me")])).toBe(GLIDE.theirs);
    expect(glideOf([row("b", "me"), row("a", "them")])).toBe(GLIDE.mine);
    expect(glideOf([row("b", "them", "streaming"), row("a", "me")])).toBe(GLIDE.grow);
  });

  it("is a reply's with no message yet", () => {
    expect(glideOf([])).toBe(GLIDE.theirs);
  });

  it("matches the desktop's springs, all critically damped", () => {
    for (const s of Object.values(GLIDE)) expect(s.damping / (2 * Math.sqrt(s.stiffness * s.mass))).toBeCloseTo(1, 2);
  });
});
