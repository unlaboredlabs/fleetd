// A chat's newest line for its sidebar row: what you or the lead wrote, in plain words; fleetd's own lines, agents'
// notes and a reply still streaming are not one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { FIRST_LOOK, latestOf, lineOf, linesOf, LOOK, readAll } from "./latest";

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

  it("takes a streamed reply once it is final: the streaming copy moves nothing, the final one with the same seq is the line", () => {
    const before = { text: "ship it", at: "2026-11-08T09:00:00.000Z", seq: 4, person: { id: "p_me", name: "Sam" } };
    const opened = message({ text: "", state: "streaming", seq: 5, createdAt: "2026-11-08T09:05:00.000Z" });
    const streaming = latestOf([opened], before);
    expect(streaming).toEqual(before);
    const final = latestOf([{ ...opened, text: "Done, merged.", state: "final" }], streaming);
    expect(final).toEqual({ text: "Done, merged.", at: "2026-11-08T09:05:00.000Z", seq: 5 });
  });

  it("keeps the line it had when only fleetd's own lines came since", () => {
    const before = { text: "On it.", at: "2026-11-08T09:00:00.000Z", seq: 4 };
    expect(latestOf([message({ author: "system", text: "Agent started", seq: 9 })], before)).toEqual({ ...before, seq: 9 });
  });
});

describe("reading the lines as the link comes up", () => {
  const msg = (seq: number, author: ChatMessage["author"], text: string): ChatMessage =>
    ({ messageId: `m${String(seq)}`, seq, author, text, state: "final", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` }) as ChatMessage;
  const layerOf = (hub: string, messages: ChatMessage[]) => {
    const limits: number[] = [];
    const call = vi.fn((_tool: string, input: { limit: number }) => {
      limits.push(input.limit);
      return Promise.resolve({ ok: true as const, output: { messages: messages.slice(-input.limit), state: {} } });
    });
    return { layer: { hub, call } as unknown as DataLayer, limits };
  };
  beforeEach(() => {
    vi.stubGlobal("window", { setTimeout: () => 0, localStorage: { getItem: () => null, setItem: () => undefined } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a chat's newest two, not ten, when they hold its line", async () => {
    const { layer, limits } = layerOf("h1", [msg(1, "human", "old"), msg(2, "lead", "a long reply ".repeat(400)), msg(3, "human", "ship it")]);
    await readAll(layer, ["m/p"]);
    expect(limits).toEqual([FIRST_LOOK]);
    expect(linesOf("h1")["m/p"]).toMatchObject({ text: "ship it", seq: 3 });
  });

  it("looks further back only when the newest are fleetd's own lines", async () => {
    const { layer, limits } = layerOf("h2", [msg(1, "lead", "the plan"), msg(2, "fleetd", "An agent started"), msg(3, "fleetd", "A PR merged")]);
    await readAll(layer, ["m/p"]);
    expect(limits).toEqual([FIRST_LOOK, LOOK]);
    expect(linesOf("h2")["m/p"]).toMatchObject({ text: "the plan", seq: 3 });
  });
});
