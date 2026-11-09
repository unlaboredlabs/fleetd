import { describe, expect, it } from "vitest";
import type { ChatRow } from "./lists";
import { gridSize, pinFace, pinnedSplit } from "./pinnedGrid";

const row = (id: string, extra: Partial<ChatRow> = {}): ChatRow => ({
  key: `m1/${id}`,
  project: { machineId: "m1", projectId: id, title: id, workspaceRoot: `/home/devbox/${id}`, lastActivityAt: "2026-10-31T10:00:00Z", threads: { running: 0, waiting: 0, failed: 0, idle: 0 } },
  archived: false,
  want: undefined,
  working: false,
  approvals: 0,
  preview: "Done.",
  empty: false,
  at: "2026-10-31T10:00:00Z",
  pinned: false,
  muted: false,
  unread: 0,
  markedUnread: false,
  lastSeq: 1,
  ...extra,
});

describe("pinnedSplit", () => {
  const rows = [row("waiting", { pinned: true, approvals: 1 }), row("a", { pinned: true }), row("x"), row("b", { pinned: true }), row("y")];

  it("takes the pinned chats out of the list into the grid, in the person's order", () => {
    const split = pinnedSplit(rows, ["m1/b", "m1/a", "m1/waiting"], "all", "");
    expect(split.grid.map((r) => r.key)).toEqual(["m1/b", "m1/a", "m1/waiting"]);
    expect(split.rows.map((r) => r.key)).toEqual(["m1/x", "m1/y"]);
  });

  it("has no grid under a filter or a search: the pinned chats are rows", () => {
    for (const [filter, query] of [["pinned", ""], ["unread", ""], ["all", "sto"]] as const) {
      const split = pinnedSplit(rows, ["m1/a", "m1/b"], filter, query);
      expect(split.grid).toEqual([]);
      expect(split.rows).toBe(rows);
    }
  });
});

describe("gridSize", () => {
  it("fits three to a row with the avatars at most 84 pt", () => {
    // An iPhone 17 Pro's width, and a narrow one's.
    expect(gridSize(402)).toEqual({ cell: 105, avatar: 84 });
    expect(gridSize(320)).toEqual({ cell: 100, avatar: 80 });
    // The widest phone's, and a tablet's: no bigger than 84 pt.
    expect(gridSize(440).avatar).toBe(84);
    expect(gridSize(820).avatar).toBe(84);
  });

  it("sets the avatars a quarter of their width apart at every width, three cells within the screen's insets", () => {
    for (let width = 280; width <= 460; width++) {
      const { cell, avatar } = gridSize(width);
      expect(cell * 3).toBeLessThanOrEqual(width - 16);
      expect(Math.abs(cell - avatar - avatar / 4)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("pinFace", () => {
  it("shows nothing over a read chat", () => {
    expect(pinFace(row("a"))).toEqual({ bubble: undefined, dot: undefined, approvals: 0 });
  });

  it("raises an unread chat's newest message in a bubble, with the dot", () => {
    expect(pinFace(row("a", { unread: 2, preview: "Booked it." }))).toEqual({ bubble: { t: "said", text: "Booked it." }, dot: "unread", approvals: 0 });
    // Marked unread by hand: the dot, and the message it has.
    expect(pinFace(row("a", { markedUnread: true })).dot).toBe("unread");
    // Muted: the dot goes grey.
    expect(pinFace(row("a", { unread: 1, muted: true })).dot).toBe("muted");
    // Nothing read yet to show: the dot alone.
    expect(pinFace(row("a", { unread: 1, preview: undefined })).bubble).toBeUndefined();
  });

  it("shows the typing bubble while its lead works, over an unread message", () => {
    expect(pinFace(row("a", { working: true, unread: 1 })).bubble).toEqual({ t: "typing" });
  });

  it("counts the approvals waiting", () => {
    expect(pinFace(row("a", { approvals: 2 })).approvals).toBe(2);
  });
});
