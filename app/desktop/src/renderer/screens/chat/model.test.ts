import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import { chatRows, dayLabel, heldLabel, rowIndexOf, systemHeadline } from "./model";

const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const NOW = Date.parse(at(19, 18));
const item = (id: string, author: ChatItem["author"], time: string, over: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text: `text ${id}`,
  at: time,
  attachments: [],
  state: "sent",
  ...over,
});
const rows = (items: ChatItem[], over: Partial<Parameters<typeof chatRows>[0]> = {}) =>
  chatRows({ items, hasOlder: false, loadingOlder: false, strip: false, nowMs: NOW, timeZone: "UTC", ...over });

describe("the chat's rows", () => {
  it("divide days, show an author once per run and fold fleetd's own messages", () => {
    const r = rows([
      item("a", "human", at(18, 9)),
      item("b", "lead", at(19, 9)),
      item("c", "lead", at(19, 9, 3)),
      item("d", "system", at(19, 9, 4), { text: "## Why you are woken\n- The human sent a message." }),
      item("e", "lead", at(19, 9, 5)),
      item("f", "lead", at(19, 9, 30)),
    ]);
    expect(r.map((x) => (x.kind === "message" ? `${x.kind}:${x.item.id}:${x.head ? "head" : "-"}` : x.kind === "day" ? `day:${x.label}` : x.kind))).toEqual([
      "top",
      "day:Yesterday",
      "message:a:head",
      "day:Today",
      "message:b:head",
      "message:c:-",
      "system",
      "message:e:head",
      "message:f:head",
    ]);
    expect(rows([])[0]).toEqual({ kind: "top", key: "top", state: "start" });
    expect(rows([], { hasOlder: true })[0]).toMatchObject({ state: "more" });
    expect(rows([], { hasOlder: true, loadingOlder: true })[0]).toMatchObject({ state: "loading" });
  });

  it("never show a held chat as current: offline, or connected before it is read again", () => {
    expect(rows([], { hasOlder: true, held: true, offline: true })[0]).toMatchObject({ state: "held" });
    // Connected, not read yet (or the read failed): never "once you're connected" while connected.
    expect(rows([], { hasOlder: true, held: true, offline: false })[0]).toMatchObject({ state: "reread" });
    expect(heldLabel(true, "as of 09:02")).toBe("Offline, as of 09:02");
    expect(heldLabel(false, "as of 09:02")).toBe("Last known, as of 09:02");
    expect(heldLabel(false, undefined)).toBe("Last known");
  });

  it("put the live strip under the lead's newest message and after the field that answers it, never between them", () => {
    const r = rows(
      [
        item("a", "lead", at(19, 9)),
        item("b", "human", at(19, 9, 1)),
        item("c", "lead", at(19, 9, 2), { state: "streaming" }),
        item("d", "system", at(19, 9, 3), { kind: "event", text: "#12 merged" }),
        item("e", "lead", at(19, 9, 4), { kind: "secret" }),
      ],
      { strip: true },
    );
    expect(r.map((x) => x.kind)).toEqual(["top", "day", "message", "message", "message", "event", "inline", "strip"]);
    expect(rows([item("a", "human", at(19, 9))], { strip: true }).at(-1)?.kind).toBe("strip");
    expect(rowIndexOf(r, "d")).toBe(5);
    // A reply after the field: the strip stays under the lead's message, before the reply.
    const replied = rows(
      [item("a", "lead", at(19, 9)), item("b", "lead", at(19, 9, 1), { kind: "gated" }), item("c", "human", at(19, 9, 2)), item("d", "lead", at(19, 9, 3), { kind: "secret" })],
      { strip: true },
    );
    expect(replied.map((x) => x.kind)).toEqual(["top", "day", "message", "inline", "strip", "message", "inline"]);
    expect(rowIndexOf(r, "nope")).toBeUndefined();
  });

  it("place a row whose time doesn't parse under today, rather than throwing", () => {
    // Intl throws a RangeError on an invalid date; a reply streaming ahead of its message once had "".
    const r = rows([item("a", "lead", at(18, 9)), item("s", "lead", "", { state: "streaming" })]);
    expect(r.map((x) => (x.kind === "day" ? `day:${x.label}` : x.kind === "message" ? `message:${x.item.id}` : x.kind))).toEqual([
      "top",
      "day:Yesterday",
      "message:a",
      "day:Today",
      "message:s",
    ]);
  });

  it("show history from before the chat as the conversation it was, under one divider, and a way back down", () => {
    const old = (id: string, author: ChatItem["author"], time: string): ChatItem =>
      item(id, author, time, { kind: "event", message: { history: "order" } as ChatItem["message"] });
    const r = rows([old("h1", "human", at(19, 8)), old("h2", "lead", at(19, 8, 1)), item("n1", "human", at(19, 9))], { hasNewer: true });
    expect(r.map((x) => (x.kind === "message" ? `${x.item.id}:${x.history ? "history" : "now"}` : x.kind))).toEqual([
      "top",
      "history",
      "day",
      "h1:history",
      "h2:history",
      "n1:now",
      "bottom",
    ]);
    expect(rows([], { hasNewer: true, loadingNewer: true }).at(-1)).toEqual({ kind: "bottom", key: "bottom", state: "loading" });
  });

  it("word days plainly", () => {
    expect(dayLabel(at(19, 1), NOW, "UTC")).toBe("Today");
    expect(dayLabel(at(18, 1), NOW, "UTC")).toBe("Yesterday");
    expect(dayLabel(at(12, 1), NOW, "UTC")).toBe("Mon 12 Oct");
    expect(dayLabel(new Date(Date.UTC(2025, 2, 3)).toISOString(), NOW, "UTC")).toBe("Mon 3 Mar 2025");
  });

  it("say why fleetd woke the lead in one line", () => {
    expect(systemHeadline("# digest\n\n## Why you are woken\n- T3 finished: the receipt dates. Judge it.\n- A PR merged")).toBe("Woken: T3 finished: the receipt dates (+1 more)");
    expect(systemHeadline("# project storefront (devbox/storefront), 09:12\n\n## Events\n- PR #214 merged")).toBe("Woken: PR #214 merged");
    expect(systemHeadline("# project storefront (devbox/storefront), 09:12\n\nNothing new.")).toBe("fleetd's digest of the project");
    expect(systemHeadline("You seem stalled; continue the task.")).toBe("You seem stalled; continue the task.");
  });
});
