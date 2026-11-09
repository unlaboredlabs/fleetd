// Your sections of chats: each change to them, and the lines the sidebar draws of them.
import { describe, expect, it } from "vitest";
import type { ChatSection, ProjectRef } from "../../../shared/contracts";
import { addSection, foldedWords, moveChat, moveSection, removeSection, renameSection, roomForSection, sectionLines, sectionNameProblem, sectionOf, SECTIONS_MAX } from "./sections";

const chat = (projectId: string): ProjectRef => ({ machineId: "devbox", projectId });
const section = (id: string, name: string, ...chats: string[]): ChatSection => ({ id, name, chats: chats.map(chat) });
const WORK = section("s1", "Work", "api", "web");
const HOME = section("s2", "Home", "garden");
const said = (sections: readonly ChatSection[]) => sections.map((s) => `${s.name}: ${s.chats.map((c) => c.projectId).join(" ")}`);

describe("a chat moved between your sections", () => {
  it("joins the section last, leaves its own, and is in the first that names it", () => {
    expect(said(moveChat([WORK, HOME], chat("docs"), "s2"))).toEqual(["Work: api web", "Home: garden docs"]);
    expect(said(moveChat([WORK, HOME], chat("api"), "s2"))).toEqual(["Work: web", "Home: garden api"]);
    expect(sectionOf([WORK, section("s3", "Twice", "api")], "devbox/api")?.id).toBe("s1");
  });

  it("goes back on top with No section, and its section goes with its last chat", () => {
    expect(said(moveChat([WORK, HOME], chat("api"), null))).toEqual(["Work: web", "Home: garden"]);
    expect(said(moveChat([WORK, HOME], chat("garden"), null))).toEqual(["Work: api web"]);
    expect(said(moveChat([WORK, HOME], chat("garden"), "s1"))).toEqual(["Work: api web garden"]);
  });

  it("is the same list when nothing would change, so nothing is sent", () => {
    const sections = [WORK, HOME];
    expect(moveChat(sections, chat("api"), "s1")).toBe(sections);
    expect(moveChat(sections, chat("docs"), null)).toBe(sections);
    expect(moveChat(sections, chat("docs"), "gone")).toBe(sections);
    expect(renameSection(sections, "s1", " Work ")).toBe(sections);
  });
});

describe("a section made, renamed, moved and removed", () => {
  it("is made last with its first chat, which leaves its own", () => {
    expect(said(addSection([WORK, HOME], "s3", "  Later ", chat("docs")))).toEqual(["Work: api web", "Home: garden", "Later: docs"]);
    expect(said(addSection([WORK, HOME], "s3", "Later", chat("garden")))).toEqual(["Work: api web", "Later: garden"]);
  });

  it("has room up to the hub's limit, counting the one its chat would leave empty", () => {
    const full = Array.from({ length: SECTIONS_MAX }, (_, i) => section(`s${String(i)}`, `S${String(i)}`, `c${String(i)}`));
    expect(roomForSection(full, chat("docs"))).toBe(false);
    expect(roomForSection(full, chat("c7"))).toBe(true);
    expect(roomForSection(full.slice(1), chat("docs"))).toBe(true);
  });

  it("keeps its id and chats through a rename, and gives its chats back when removed", () => {
    expect(renameSection([WORK, HOME], "s1", " Job ")).toEqual([{ ...WORK, name: "Job" }, HOME]);
    expect(said(removeSection([WORK, HOME], "s1"))).toEqual(["Home: garden"]);
  });

  it("moves past the next section on show, and any between with no chat on show", () => {
    const hidden = section("s3", "All pinned", "pinned");
    const last = section("s4", "Later", "docs");
    const sections = [WORK, hidden, HOME, last];
    const shown = ["s1", "s2", "s4"];
    expect(moveSection(sections, "s1", 1, shown).map((s) => s.id)).toEqual(["s3", "s2", "s1", "s4"]);
    expect(moveSection(sections, "s2", -1, shown).map((s) => s.id)).toEqual(["s2", "s1", "s3", "s4"]);
    expect(moveSection(sections, "s4", -1, shown).map((s) => s.id)).toEqual(["s1", "s3", "s4", "s2"]);
    // Nowhere to go: the first up, the last down, one not on show.
    expect(moveSection(sections, "s1", -1, shown)).toBe(sections);
    expect(moveSection(sections, "s4", 1, shown)).toBe(sections);
    expect(moveSection(sections, "s3", 1, shown)).toBe(sections);
  });

  it("says why the hub would refuse a name before it is sent", () => {
    expect(sectionNameProblem([WORK], "  ")).toBe("A section needs a name");
    expect(sectionNameProblem([WORK], "x".repeat(40))).toBeUndefined();
    expect(sectionNameProblem([WORK], "x".repeat(41))).toBe("Keep it to 40 characters: this one has 41");
    // A character is one, however many units it takes.
    expect(sectionNameProblem([WORK], "🌱".repeat(40))).toBeUndefined();
    expect(sectionNameProblem([WORK], " Work ")).toBe("You already have a section named “Work”");
    expect(sectionNameProblem([WORK], "work")).toBeUndefined();
    // Its own name is no clash while it is renamed.
    expect(sectionNameProblem([WORK, HOME], "Work", "s1")).toBeUndefined();
    expect(sectionNameProblem([WORK, HOME], "Home", "s1")).toBe("You already have a section named “Home”");
  });
});

describe("the list under the pins", () => {
  const row = (key: string, sectionId?: string, extra: { want?: string; unread?: boolean } = {}) => ({ key, section: sectionId, want: extra.want, unread: extra.unread ?? false });
  const said = (lines: ReturnType<typeof sectionLines<ReturnType<typeof row>>>) =>
    lines.map((l) => (l.t === "chat" ? l.row.key : `[${l.section.name}${l.folded ? ` ${String(l.count)}` : ""}${l.dot === undefined ? "" : ` ${l.dot}`}]`));
  const open = () => false;

  it("has the chats in no section on top with no label, then each section in your order under its own", () => {
    const rows = [row("new"), row("garden", "s2"), row("api", "s1"), row("old"), row("web", "s1")];
    expect(said(sectionLines(rows, [WORK, HOME], open))).toEqual(["new", "old", "[Work]", "api", "web", "[Home]", "garden"]);
    expect(said(sectionLines(rows, [HOME, WORK], open))).toEqual(["new", "old", "[Home]", "garden", "[Work]", "api", "web"]);
    // A section the hub no longer has: its chat is in none.
    expect(said(sectionLines([row("api", "gone"), row("web", "s1")], [WORK], open))).toEqual(["api", "[Work]", "web"]);
  });

  it("has no label for a section with no chat on show (all pinned or archived)", () => {
    expect(said(sectionLines([row("new"), row("garden", "s2")], [WORK, HOME], open))).toEqual(["new", "[Home]", "garden"]);
    expect(said(sectionLines([], [WORK, HOME], open))).toEqual([]);
  });

  it("is a folded section's label alone, with how many chats and what waits inside", () => {
    const rows = [row("api", "s1"), row("web", "s1", { unread: true }), row("garden", "s2")];
    const folded = (id: string) => id === "s1";
    expect(said(sectionLines(rows, [WORK, HOME], folded))).toEqual(["[Work 2 new]", "[Home]", "garden"]);
    // One that waits on you speaks over a new message.
    expect(said(sectionLines([...rows, row("docs", "s1", { want: "approve" })], [WORK, HOME], folded))).toEqual(["[Work 3 you]", "[Home]", "garden"]);
    expect(said(sectionLines([row("api", "s1")], [WORK], folded))).toEqual(["[Work 1]"]);
  });

  it("names what a folded label holds for a screen reader", () => {
    expect(foldedWords(1, undefined)).toBe("1 chat");
    expect(foldedWords(3, "new")).toBe("3 chats, something new inside");
    expect(foldedWords(2, "you")).toBe("2 chats, one waits on you");
  });
});
