import { describe, expect, it } from "vitest";
import { arrivalsOf, ENTER_MS } from "./arrivals";
import type { ChatItem } from "./desktop";

const NOW = 1_000_000;

const hub = (id: string, seq: number, author: ChatItem["author"] = "lead", extra: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text: id,
  at: "2026-10-28T10:00:00Z",
  attachments: [],
  state: "sent",
  message: { messageId: id, projectRef: { machineId: "m", projectId: "p" }, seq, author, text: id, state: "final", createdAt: "2026-10-28T10:00:00Z" },
  ...extra,
});

const steps = (a: ReturnType<typeof arrivalsOf>) => Object.fromEntries([...a.entering].map(([k, v]) => [k, v.step]));

describe("arrivalsOf", () => {
  it("shows what the chat opened with still, and staggers what comes after", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    expect(steps(opened)).toEqual({});
    const next = arrivalsOf(opened, [hub("a", 1), hub("b", 2), hub("c", 3)], true, NOW + 10);
    expect(steps(next)).toEqual({ b: 0, c: 1 });
  });

  it("enters your send once: the hub's echo keeps its key", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const send: ChatItem = { id: "r1", author: "human", kind: "message", text: "hi", at: "", attachments: [], state: "pending", clientRequestId: "r1" };
    const sent = arrivalsOf(opened, [hub("a", 1), send], true, NOW + 10);
    expect(steps(sent)).toEqual({ r1: 0 });
    const echoed = arrivalsOf(sent, [hub("a", 1), hub("m9", 2, "human", { clientRequestId: "r1" })], true, NOW + 20);
    expect(steps(echoed)).toEqual({ r1: 0 });
  });

  it("brings older pages and what a reconnect reads back in still", () => {
    const opened = arrivalsOf(undefined, [hub("b", 5)], true, NOW);
    expect(steps(arrivalsOf(opened, [hub("a", 2), hub("b", 5)], true, NOW + 10))).toEqual({});
    const held = arrivalsOf(opened, [hub("b", 5)], false, NOW + 10);
    expect(steps(arrivalsOf(held, [hub("b", 5), hub("c", 6)], true, NOW + 20))).toEqual({});
  });

  it("forgets an entrance once its moment is past", () => {
    const opened = arrivalsOf(undefined, [hub("a", 1)], true, NOW);
    const next = arrivalsOf(opened, [hub("a", 1), hub("b", 2)], true, NOW);
    expect(steps(arrivalsOf(next, [hub("a", 1), hub("b", 2)], true, NOW + ENTER_MS))).toEqual({});
  });
});
