import { describe, expect, it } from "vitest";
import type { ChatMessagePin } from "./desktop";
import { capsuleLabel, capsuleOf, findPinsShown, isPinned, pinLine, pinnedByLine } from "./messagePins";

const pin = (messageId: string, text: string, extra: Partial<ChatMessagePin> = {}): ChatMessagePin => ({
  messageId,
  seq: 1,
  pinnedAt: "2026-01-02T10:00:00.000Z",
  pinnedBy: { personId: "ada", name: "Ada" },
  author: "lead",
  createdAt: "2026-01-01T10:00:00.000Z",
  text,
  ...extra,
});

describe("a chat's pinned messages", () => {
  it("shows nothing with no pins", () => {
    expect(capsuleOf(undefined)).toBeUndefined();
    expect(capsuleOf([])).toBeUndefined();
  });

  it("goes to the one pin's message, or opens the list with several, showing the newest pinned", () => {
    expect(capsuleOf([pin("m1", "Deploy plan")])).toEqual({ line: "Deploy plan", count: 1, goesTo: "m1" });
    const several = capsuleOf([pin("m3", "Newest"), pin("m1", "Older")]);
    expect(several).toEqual({ line: "Newest", count: 2, goesTo: undefined });
    if (several === undefined) throw new Error("no capsule");
    expect(capsuleLabel(several)).toBe("2 pinned messages. Newest: Newest");
  });

  it("says a pin's words as plain text on one line, never a block's JSON", () => {
    expect(pinLine(pin("m", "**Ship** it\n\nnow"))).toBe("Ship it now");
    expect(pinLine(pin("m", '```fleetd-block\n{"v":1,"kind":"table","columns":["a"],"rows":[]}\n```'))).not.toContain("{");
    expect(pinLine(pin("m", "   "))).toBe("Message");
  });

  it("knows which are pinned, and who pinned each", () => {
    expect(isPinned([pin("m1", "a")], "m1")).toBe(true);
    expect(isPinned([pin("m1", "a")], "m2")).toBe(false);
    expect(pinnedByLine(pin("m", "a"), "ada", "Today")).toBe("Pinned by you · Today");
    expect(pinnedByLine(pin("m", "a"), "bo", "Today")).toBe("Pinned by Ada · Today");
  });

  it("shows search and Pin only on a live hub that has them", () => {
    expect(findPinsShown({ phase: "live", hub: "h", protocol: 1, features: ["chat_find_pins"] })).toBe(true);
    expect(findPinsShown({ phase: "live", hub: "h", protocol: 1, features: [] })).toBe(false);
    expect(findPinsShown({ phase: "connecting", hub: "h", attempt: 0 })).toBe(false);
  });
});
