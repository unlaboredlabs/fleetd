// A chat's newest line for its sidebar row: what you or the lead wrote, in plain words; fleetd's own lines, agents'
// notes and a reply still streaming are not one.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../shared/contracts";
import { latestOf, lineOf } from "./latest";

let seq = 0;
const message = (m: Partial<ChatMessage>): ChatMessage => ({
  messageId: `m${String(++seq)}`,
  projectRef: { machineId: "devbox", projectId: "api" },
  seq,
  author: "lead",
  text: "",
  attachments: [],
  createdAt: `2026-11-08T09:${String(seq).padStart(2, "0")}:00.000Z`,
  state: "final",
  ...m,
});

describe("a chat's line", () => {
  it("is the words without markdown, on one line", () => {
    expect(lineOf(message({ text: "**Done**: see `x` and [the PR](https://example.com/1).\n\n- one\n- two" }))).toBe("Done: see x and the PR. - one - two");
  });

  it("leaves out a lead's block fence, and says what a block is", () => {
    expect(lineOf(message({ text: 'Here it is.\n\n```fleetd-block\n{"v":1}\n```' }))).toBe("Here it is.");
    const text = "Opened it.PR";
    const parts = [
      { start: 0, end: 10 },
      { start: 10, end: 12, block: { v: 1, kind: "pr", repo: "o/r", number: 12, title: "Fix alerts" } },
    ] as NonNullable<ChatMessage["parts"]>;
    expect(lineOf(message({ text, parts }))).toBe("Opened it. Pull request #12: Fix alerts");
  });

  it("says what an open item asks, and names a picture with no words", () => {
    expect(lineOf(message({ item: { kind: "command_approval" } as NonNullable<ChatMessage["item"]> }))).toBe("Asks for your approval");
    expect(lineOf(message({ author: "human", attachments: [{ attachmentId: "a", bytes: 1, mime: "image/png", name: "x.png" }] }))).toBe("Photo");
  });

  it("is a reply's own words, not the quote it answers", () => {
    expect(lineOf(message({ author: "human", text: "> Shall I merge?\n\nYes, merge it." }))).toBe("Yes, merge it.");
  });

  it("is nothing for fleetd's own lines, an agent's note or a reply still streaming", () => {
    expect(lineOf(message({ author: "system", text: "PR #3 merged" }))).toBeNull();
    expect(lineOf(message({ author: "agent", text: "status" }))).toBeNull();
    expect(lineOf(message({ text: "Half a", state: "streaming" }))).toBeNull();
  });
});

describe("a chat's newest line", () => {
  it("is the newest message with a line, who wrote it, and the newest seq looked at", () => {
    const said = message({ text: "On it." });
    const mine = message({ author: "human", text: "ship it", person: { personId: "p_me", name: "Sam" } });
    const merged = message({ author: "system", text: "PR #3 merged" });
    expect(latestOf([merged, said, mine])).toEqual({ text: "ship it", at: mine.createdAt, seq: merged.seq, person: { id: "p_me", name: "Sam" } });
  });

  it("keeps the line it had when only fleetd's own lines came since", () => {
    const before = { text: "On it.", at: "2026-11-08T09:00:00.000Z", seq: 4 };
    expect(latestOf([message({ author: "system", text: "Agent started", seq: 9 })], before)).toEqual({ ...before, seq: 9 });
  });
});
