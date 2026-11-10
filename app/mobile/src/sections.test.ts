import { describe, expect, it } from "vitest";
import type { HubError } from "./desktop";
import type { ChatRow } from "./lists";
import { hubSectionStore, noPrefs, parsePrefs, reducePrefs, sectionsOf, type PrefsAction } from "./prefs";
import {
  addSection,
  labelActions,
  labelWords,
  memorySections,
  moveChat,
  moveSection,
  nameProblem,
  removeSection,
  renameSection,
  roomForSection,
  sectionChoices,
  sectionLines,
  Sections,
  SECTIONS_MAX,
  type Section,
  type SectionCall,
} from "./sections";

const row = (id: string, extra: Partial<ChatRow> = {}): ChatRow => ({
  key: `m1/${id}`,
  project: { machineId: "m1", projectId: id, title: id, workspaceRoot: `/home/devbox/${id}`, lastActivityAt: "2026-11-09T10:00:00Z", threads: { running: 0, waiting: 0, failed: 0, idle: 0 } },
  archived: false,
  want: undefined,
  working: false,
  approvals: 0,
  preview: "Done.",
  empty: false,
  at: "2026-11-09T10:00:00Z",
  pinned: false,
  muted: false,
  unread: 0,
  markedUnread: false,
  lastSeq: 1,
  ...extra,
});

const ref = (key: string) => ({ machineId: "m1", projectId: key.slice(3) });
const work: Section = { id: "s1", name: "Work", chats: ["m1/api", "m1/site"] };
const home: Section = { id: "s2", name: "Home", chats: ["m1/garden"] };

/** The list's lines in short: a chat's id, a label as [name, count] with ! when its dot shows and > when folded. */
const short = (rows: readonly ChatRow[], sections: readonly Section[], folded: readonly string[] = []) =>
  sectionLines(rows, sections, folded).map((l) => (l.t === "chat" ? l.row.project.projectId : `[${l.section.name} ${String(l.count)}${l.dot ? "!" : ""}${l.folded ? ">" : ""}]`));

describe("sectionLines", () => {
  // The list's own order: what spoke last first.
  const rows = [row("site"), row("loose"), row("garden"), row("api"), row("other")];

  it("puts the chats in no section on top with no label, then each section under its label, in the person's order", () => {
    expect(short(rows, [work, home])).toEqual(["loose", "other", "[Work 2]", "site", "api", "[Home 1]", "garden"]);
    expect(short(rows, [home, work])).toEqual(["loose", "other", "[Home 1]", "garden", "[Work 2]", "site", "api"]);
    expect(short(rows, [])).toEqual(["site", "loose", "garden", "api", "other"]);
  });

  it("keeps the list's order inside a section, whatever order the section names its chats in", () => {
    expect(short([row("api"), row("site")], [work])).toEqual(["[Work 2]", "api", "site"]);
    expect(short([row("site"), row("api")], [work])).toEqual(["[Work 2]", "site", "api"]);
  });

  it("gives no label to a section with no chat on show: all pinned, archived or gone", () => {
    // Pinned chats are in the grid, not among the rows.
    expect(short([row("loose"), row("garden")], [work, home])).toEqual(["loose", "[Home 1]", "garden"]);
    expect(short([row("api")], [work, home])).toEqual(["[Work 1]", "api"]);
  });

  it("folds a section to its label, which counts its chats and shows a dot when one needs you or is unread", () => {
    expect(short(rows, [work, home], ["s1"])).toEqual(["loose", "other", "[Work 2>]", "[Home 1]", "garden"]);
    expect(short([row("site"), row("api", { unread: 2 })], [work], ["s1"])).toEqual(["[Work 2!>]"]);
    expect(short([row("site", { markedUnread: true }), row("api")], [work], ["s1"])).toEqual(["[Work 2!>]"]);
    expect(short([row("site", { want: "Approve a send", approvals: 1 }), row("api")], [work], ["s1"])).toEqual(["[Work 2!>]"]);
    // A muted chat's unread is no reason to look.
    expect(short([row("site", { unread: 3, muted: true }), row("api")], [work], ["s1"])).toEqual(["[Work 2>]"]);
    // A folded id of a section that is no more changes nothing.
    expect(short(rows, [home], ["s1"])).toEqual(["site", "loose", "api", "other", "[Home 1]", "garden"]);
  });

  it("shows a chat two sections name in the first only, as the hub keeps it", () => {
    expect(short([row("api")], [work, { id: "s3", name: "Also", chats: ["m1/api"] }])).toEqual(["[Work 1]", "api"]);
  });

  it("says a label to VoiceOver: its name, folded or open, and what a folded one holds", () => {
    const [open] = sectionLines([row("api")], [work], []);
    const [folded] = sectionLines([row("api", { unread: 1 }), row("site")], [work], ["s1"]);
    const [one] = sectionLines([row("garden")], [home], ["s2"]);
    expect([open, folded, one].map((l) => (l?.t === "section" ? labelWords(l) : ""))).toEqual(["Work, open", "Work, folded, 2 chats, something new inside", "Home, folded, 1 chat"]);
  });
});

describe("Changes to the sections", () => {
  it("moves a chat into a section, to another, and out of them all", () => {
    expect(moveChat([work, home], "m1/loose", "s2")).toEqual([work, { ...home, chats: ["m1/garden", "m1/loose"] }]);
    expect(moveChat([work, home], "m1/api", "s2")).toEqual([{ ...work, chats: ["m1/site"] }, { ...home, chats: ["m1/garden", "m1/api"] }]);
    expect(moveChat([work, home], "m1/api", null)).toEqual([{ ...work, chats: ["m1/site"] }, home]);
  });

  it("drops a section with its last chat", () => {
    expect(moveChat([work, home], "m1/garden", null)).toEqual([work]);
    expect(moveChat([work, home], "m1/garden", "s1")).toEqual([{ ...work, chats: ["m1/api", "m1/site", "m1/garden"] }]);
  });

  it("is the same list when nothing would change", () => {
    const sections = [work, home];
    expect(moveChat(sections, "m1/api", "s1")).toBe(sections);
    expect(moveChat(sections, "m1/loose", null)).toBe(sections);
    expect(moveChat(sections, "m1/loose", "nowhere")).toBe(sections);
    expect(renameSection(sections, "s1", " Work ")).toBe(sections);
    expect(moveSection(sections, "s1", -1, ["s1", "s2"])).toBe(sections);
    expect(moveSection(sections, "s2", 1, ["s1", "s2"])).toBe(sections);
  });

  it("makes a section with its first chat, last, its name trimmed", () => {
    expect(addSection([work], "s9", "  Later ", "m1/loose")).toEqual([work, { id: "s9", name: "Later", chats: ["m1/loose"] }]);
    // The chat leaves its own section, which goes with it when it was the last.
    expect(addSection([work, home], "s9", "Plants", "m1/garden")).toEqual([work, { id: "s9", name: "Plants", chats: ["m1/garden"] }]);
  });

  it("renames a section, and removes one without touching its chats' place in the others", () => {
    expect(renameSection([work, home], "s2", " House ")).toEqual([work, { ...home, name: "House" }]);
    expect(removeSection([work, home], "s1")).toEqual([home]);
  });

  it("moves a section past the next one on show, and those between with nothing on show", () => {
    const hidden: Section = { id: "s3", name: "Pinned ones", chats: ["m1/pinned"] };
    const last: Section = { id: "s4", name: "Later", chats: ["m1/later"] };
    expect(moveSection([work, home, last], "s2", -1, ["s1", "s2", "s4"]).map((s) => s.id)).toEqual(["s2", "s1", "s4"]);
    expect(moveSection([work, home, last], "s2", 1, ["s1", "s2", "s4"]).map((s) => s.id)).toEqual(["s1", "s4", "s2"]);
    expect(moveSection([work, hidden, last], "s1", 1, ["s1", "s4"]).map((s) => s.id)).toEqual(["s3", "s4", "s1"]);
    expect(moveSection([work, hidden, last], "s4", -1, ["s1", "s4"]).map((s) => s.id)).toEqual(["s4", "s1", "s3"]);
  });

  it("says why a name won't do, in the hub's rules: none, too long, or another section's", () => {
    expect(nameProblem([work], "  ")).toBe("A section needs a name.");
    expect(nameProblem([work], "x".repeat(41))).toBe("A section's name is at most 40 characters: this one has 41.");
    // Counted as the hub counts: a character outside the basic plane is one.
    expect(nameProblem([work], "😀".repeat(40))).toBeUndefined();
    expect(nameProblem([work], " Work ")).toBe("You already have a section named “Work”.");
    expect(nameProblem([work], "work")).toBeUndefined();
    // Its own name is no clash for a rename.
    expect(nameProblem([work], "Work", "s1")).toBeUndefined();
  });

  it("has room for a new section up to the hub's most, counting the one a chat's leaving empties", () => {
    const full = Array.from({ length: SECTIONS_MAX }, (_, i): Section => ({ id: `s${String(i)}`, name: `S${String(i)}`, chats: [`m1/c${String(i)}`] }));
    expect(roomForSection(full.slice(1), "m1/loose")).toBe(true);
    expect(roomForSection(full, "m1/loose")).toBe(false);
    expect(roomForSection(full, "m1/c3")).toBe(true);
  });
});

describe("The menus", () => {
  it("offers a chat each section with a tick on its own, none, and a new one", () => {
    expect(sectionChoices([work, home], "m1/garden")).toEqual([
      { label: "Work", ticked: false, to: { t: "section", id: "s1" } },
      { label: "Home", ticked: true, to: { t: "section", id: "s2" } },
      { label: "No Section", ticked: false, to: { t: "none" } },
      { label: "New Section…", ticked: false, to: { t: "new" } },
    ]);
    expect(sectionChoices([work], "m1/loose").map((c) => [c.label, c.ticked])).toEqual([
      ["Work", false],
      ["No Section", true],
      ["New Section…", false],
    ]);
  });

  it("offers a held label a move only where there is a section on show to pass", () => {
    expect(labelActions("s1", ["s1", "s2", "s3"])).toEqual(["rename", "down", "remove"]);
    expect(labelActions("s2", ["s1", "s2", "s3"])).toEqual(["rename", "up", "down", "remove"]);
    expect(labelActions("s3", ["s1", "s2", "s3"])).toEqual(["rename", "up", "remove"]);
    expect(labelActions("s1", ["s1"])).toEqual(["rename", "remove"]);
  });
});

/** A hub that holds each call until the test answers it. */
const fakeCalls = () => {
  const calls: Array<{ tool: string; input: unknown; answer: (r: unknown) => void }> = [];
  const call = ((tool: string, input: unknown) => new Promise<unknown>((answer) => calls.push({ tool, input, answer }))) as SectionCall;
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Answers the oldest call still waiting. */
  const next = async (tool: string, r: { output: unknown } | { error: Partial<HubError> }) => {
    const c = calls.shift();
    expect(c?.tool).toBe(tool);
    c?.answer("output" in r ? { ok: true, output: r.output } : { ok: false, error: { message: "", fix: "", ...r.error } });
    await settle();
    return c?.input;
  };
  return { calls, call, next, settle };
};

const hubWork = { id: "s1", name: "Work", chats: [ref("m1/api"), ref("m1/site")] };
const hubHome = { id: "s2", name: "Home", chats: [ref("m1/garden")] };

/** Sections that have read `onHub` from the hub: this phone's copy is the hub's own list. */
const readSections = async (hub: ReturnType<typeof fakeCalls>, store = memorySections(), onHub: readonly unknown[] = [], onRefused?: (words: string) => void) => {
  const sections = new Sections(hub.call, store, onRefused);
  void sections.read();
  await hub.next("chat_sections_get", { output: { sections: onHub } });
  return sections;
};

describe("Sections", () => {
  it("shows the hub's sections, in the person's order", async () => {
    const hub = fakeCalls();
    const store = memorySections([home]);
    const sections = new Sections(hub.call, store);
    void sections.read();
    await hub.next("chat_sections_get", { output: { sections: [hubWork, hubHome] } });
    expect(store.saved()).toEqual([work, home]);
    expect(hub.calls).toHaveLength(0);
  });

  it("keeps what it has when the hub can't be read, or is from before sections", async () => {
    const hub = fakeCalls();
    const store = memorySections([home]);
    const sections = new Sections(hub.call, store);
    void sections.read();
    await hub.next("chat_sections_get", { error: { code: "not_found" } });
    expect(store.saved()).toEqual([home]);
    expect(hub.calls).toHaveLength(0);
  });

  it("shows a change at once and sends one set at a time, the newest last", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const sections = await readSections(hub, store);
    void sections.change(() => [home]);
    void sections.change(() => [work, home]);
    void sections.change(() => [work]);
    expect(store.saved()).toEqual([work]);
    expect(store.pending()).toBe(true);
    // The first is on its way; the two after it go as one, the newest.
    expect(hub.calls).toHaveLength(1);
    expect(await hub.next("chat_sections_set", { output: { sections: [hubHome] } })).toEqual({ sections: [hubHome] });
    expect(store.saved()).toEqual([work]);
    expect(await hub.next("chat_sections_set", { output: { sections: [hubWork] } })).toEqual({ sections: [hubWork] });
    expect(store.pending()).toBe(false);
    expect(hub.calls).toHaveLength(0);
  });

  it("takes the list as the hub stored it: a name trimmed, a chat it no longer has left out", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const sections = await readSections(hub, store);
    void sections.change(() => [{ id: "s1", name: "Work", chats: ["m1/api", "m1/deleted"] }, home]);
    await hub.next("chat_sections_set", { output: { sections: [{ ...hubWork, chats: [ref("m1/api")] }, hubHome] } });
    expect(store.saved()).toEqual([{ ...work, chats: ["m1/api"] }, home]);
  });

  it("takes back a change the hub refuses, with the hub's list and its words", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const said: string[] = [];
    const sections = await readSections(hub, store, [hubWork], (words) => said.push(words));
    void sections.change((now) => [...now, { ...home, name: "Work" }]);
    expect(store.saved()).toHaveLength(2);
    await hub.next("chat_sections_set", { error: { code: "invalid", message: "Two sections are named “Work”." } });
    expect(said).toEqual(["Two sections are named “Work”."]);
    expect(store.pending()).toBe(false);
    // The hub's own list is read back over what was shown.
    await hub.next("chat_sections_get", { output: { sections: [hubWork] } });
    expect(store.saved()).toEqual([work]);
    expect(hub.calls).toHaveLength(0);
  });

  it("takes back a change on a hub from before sections, and says to update it", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const said: string[] = [];
    const sections = new Sections(hub.call, store, (words) => said.push(words));
    void sections.change(() => [work]);
    // Asked what it has first: it has no such tool, and the set is refused in its words.
    await hub.next("chat_sections_get", { error: { code: "not_found" } });
    await hub.next("chat_sections_set", { error: { code: "not_found", message: "No tool chat_sections_set." } });
    expect(said).toEqual(["This hub doesn't keep sections yet. Update it to use them."]);
    expect(store.pending()).toBe(false);
    await hub.next("chat_sections_get", { error: { code: "not_found" } });
    expect(hub.calls).toHaveLength(0);
  });

  it("keeps a change made offline and sends it on the next read, over what the hub has", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const said: string[] = [];
    const sections = await readSections(hub, store, [], (words) => said.push(words));
    void sections.change(() => [work]);
    await hub.next("chat_sections_set", { error: { code: "offline" } });
    expect(store.saved()).toEqual([work]);
    expect(store.pending()).toBe(true);
    expect(said).toEqual([]);
    // The link is live again: the snapshot's read sends it instead of reading.
    void sections.read();
    expect(await hub.next("chat_sections_set", { output: { sections: [hubWork] } })).toEqual({ sections: [hubWork] });
    expect(store.pending()).toBe(false);
    expect(hub.calls).toHaveLength(0);
  });
});

describe("A change to the sections before the hub has said what they are", () => {
  const toWork = (key: string) => (now: readonly Section[]) => moveChat(now, key, "s1");

  it("waits for the read on its way and is made on the hub's list, so a section made on another phone stays", async () => {
    const hub = fakeCalls();
    // What this phone kept: Home was made on the person's other phone since.
    const store = memorySections([work]);
    const sections = new Sections(hub.call, store);
    // Launch: the snapshot's read is on its way.
    void sections.read();
    void sections.change(toWork("m1/docs"));
    // Shown at once on what this phone has; nothing sent yet.
    expect(store.saved()).toEqual([{ ...work, chats: ["m1/api", "m1/site", "m1/docs"] }]);
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_sections_get"]);
    await hub.next("chat_sections_get", { output: { sections: [hubWork, hubHome] } });
    expect(store.saved()).toEqual([{ ...work, chats: ["m1/api", "m1/site", "m1/docs"] }, home]);
    const sent = { sections: [{ ...hubWork, chats: [...hubWork.chats, ref("m1/docs")] }, hubHome] };
    expect(await hub.next("chat_sections_set", { output: sent })).toEqual(sent);
    expect(store.pending()).toBe(false);
    expect(hub.calls).toHaveLength(0);
  });

  it("asks the hub itself when no read is on its way, and makes each change that waited, in order", async () => {
    const hub = fakeCalls();
    const store = memorySections([work]);
    const sections = new Sections(hub.call, store);
    void sections.change(toWork("m1/docs"));
    void sections.change((now) => renameSection(now, "s1", "Job"));
    expect(store.saved()).toEqual([{ id: "s1", name: "Job", chats: ["m1/api", "m1/site", "m1/docs"] }]);
    // One read for both.
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_sections_get"]);
    await hub.next("chat_sections_get", { output: { sections: [hubHome, hubWork] } });
    const sent = { sections: [hubHome, { id: "s1", name: "Job", chats: [...hubWork.chats, ref("m1/docs")] }] };
    expect(await hub.next("chat_sections_set", { output: sent })).toEqual(sent);
    expect(store.saved()).toEqual([home, { id: "s1", name: "Job", chats: ["m1/api", "m1/site", "m1/docs"] }]);
    expect(hub.calls).toHaveLength(0);
  });

  it("asks again after a read the hub didn't answer, rather than send this phone's copy", async () => {
    const hub = fakeCalls();
    const store = memorySections([work]);
    const sections = new Sections(hub.call, store);
    void sections.read();
    await hub.next("chat_sections_get", { error: { code: "timeout" } });
    void sections.change(toWork("m1/docs"));
    await hub.next("chat_sections_get", { output: { sections: [hubWork, hubHome] } });
    const sent = { sections: [{ ...hubWork, chats: [...hubWork.chats, ref("m1/docs")] }, hubHome] };
    expect(await hub.next("chat_sections_set", { output: sent })).toEqual(sent);
  });

  it("waits for the read a new link or another device's change started, and only for the newest", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const sections = await readSections(hub, store, [hubWork]);
    // Back from a drop: the snapshot's read; then the other phone's new section is announced, and read too.
    void sections.read();
    void sections.read();
    void sections.change(toWork("m1/docs"));
    // The older read's answer, from before the other phone's section, is not the one.
    await hub.next("chat_sections_get", { output: { sections: [hubWork] } });
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_sections_get"]);
    await hub.next("chat_sections_get", { output: { sections: [hubWork, hubHome] } });
    const sent = { sections: [{ ...hubWork, chats: [...hubWork.chats, ref("m1/docs")] }, hubHome] };
    expect(await hub.next("chat_sections_set", { output: sent })).toEqual(sent);
  });

  it("is sent as changed here once the hub's list is this phone's: after a set it took", async () => {
    const hub = fakeCalls();
    const store = memorySections();
    const sections = await readSections(hub, store, [hubWork]);
    void sections.change((now) => [...now, home]);
    await hub.next("chat_sections_set", { output: { sections: [hubWork, hubHome] } });
    void sections.change((now) => removeSection(now, "s1"));
    expect(await hub.next("chat_sections_set", { output: { sections: [hubHome] } })).toEqual({ sections: [hubHome] });
    expect(hub.calls).toHaveLength(0);
  });

  it("waits as one made offline when the hub can't be reached, for the next live link", async () => {
    const hub = fakeCalls();
    const store = memorySections([work]);
    const said: string[] = [];
    const sections = new Sections(hub.call, store, (words) => said.push(words));
    void sections.change(toWork("m1/docs"));
    await hub.next("chat_sections_get", { error: { code: "offline" } });
    expect(store.saved()).toEqual([{ ...work, chats: ["m1/api", "m1/site", "m1/docs"] }]);
    expect(store.pending()).toBe(true);
    expect(said).toEqual([]);
    expect(hub.calls).toHaveLength(0);
    void sections.read();
    const sent = { sections: [{ ...hubWork, chats: [...hubWork.chats, ref("m1/docs")] }] };
    expect(await hub.next("chat_sections_set", { output: sent })).toEqual(sent);
    expect(store.pending()).toBe(false);
  });
});

describe("Sections in the phone's prefs", () => {
  const HUB = "http://devbox:4790";

  it("keeps each hub's sections apart, and which wait to be sent", () => {
    let prefs = noPrefs;
    const dispatch = (a: PrefsAction) => {
      prefs = reducePrefs(prefs, a);
    };
    const store = hubSectionStore(() => prefs, dispatch, HUB);
    expect(store.saved()).toEqual([]);
    store.save([work]);
    store.setPending(true);
    expect(sectionsOf(prefs, HUB)).toEqual([work]);
    expect(sectionsOf(prefs, "http://other:4790")).toEqual([]);
    expect(store.pending()).toBe(true);
    expect(hubSectionStore(() => prefs, dispatch, "http://other:4790").pending()).toBe(false);
    // The same list again changes nothing: the list isn't drawn again for it.
    const was = prefs;
    store.save([{ ...work, chats: [...work.chats] }]);
    expect(prefs).toBe(was);
    store.setPending(false);
    expect(prefs.sectionsPending).toEqual([]);
  });

  it("remembers the sections folded on this phone", () => {
    const folded = reducePrefs(noPrefs, { t: "fold", id: "s1", on: true });
    expect(folded.folded).toEqual(["s1"]);
    expect(reducePrefs(folded, { t: "fold", id: "s1", on: true })).toBe(folded);
    expect(reducePrefs(folded, { t: "fold", id: "s1", on: false }).folded).toEqual([]);
  });

  it("reads them back from disk, dropping what has the wrong shape", () => {
    const disk = JSON.parse(JSON.stringify(reducePrefs(reducePrefs(reducePrefs(noPrefs, { t: "sections", hub: HUB, sections: [work, home] }), { t: "sectionsPending", hub: HUB, on: true }), { t: "fold", id: "s2", on: true }))) as unknown;
    expect(parsePrefs(disk)).toMatchObject({ sections: { [HUB]: [work, home] }, sectionsPending: [HUB], folded: ["s2"] });
    expect(parsePrefs({ sections: { [HUB]: [{ id: "s1", name: "Work", chats: ["m1/api", 3] }, { id: 4, name: "x" }, "y"], other: "z" }, sectionsPending: "h", folded: [1, "s1"] })).toMatchObject({
      sections: { [HUB]: [{ id: "s1", name: "Work", chats: ["m1/api"] }], other: [] },
      sectionsPending: [],
      folded: ["s1"],
    });
  });
});
