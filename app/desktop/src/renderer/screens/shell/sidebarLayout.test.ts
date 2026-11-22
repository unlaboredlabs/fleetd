import { describe, expect, it } from "vitest";
import { foldKey, shownRows, sortRows, viewedHub, type SidebarView } from "./sidebarLayout";

const row = (key: string, hub: string, more: { pinned?: boolean; want?: boolean; title?: string } = {}) => ({
  key,
  hub,
  pinned: more.pinned ?? false,
  ...(more.want === true ? { want: { word: "reply" } } : {}),
  project: { title: more.title ?? key },
});
// Each hub's rows as the frame has them, newest first.
const ROWS = [row("pin", "a", { pinned: true }), row("top", "a"), row("Api", "a", { want: true }), row("garden", "a"), row("other", "b")];
const keys = (rows: ReadonlyArray<{ key: string }>) => rows.map((r) => r.key);
const view = (more: Partial<SidebarView> = {}): SidebarView => ({ hub: null, sort: "recent", compact: false, ...more });

describe("the rows on show, which ⌘1–9 count", () => {
  it("are the hub on show's: its pins, then the rest as they came", () => {
    expect(keys(shownRows(ROWS, view(), "a"))).toEqual(["pin", "top", "Api", "garden"]);
    expect(keys(shownRows(ROWS, view(), "b"))).toEqual(["other"]);
  });

  it("follow the list's order: by name, whatever the case, or the ones that want you first", () => {
    expect(keys(shownRows(ROWS, view({ sort: "name" }), "a"))).toEqual(["pin", "Api", "garden", "top"]);
    expect(keys(shownRows(ROWS, view({ sort: "needs" }), "a"))).toEqual(["pin", "Api", "top", "garden"]);
  });

  it("are sorted within each section, the groups in the frame's order, as the sidebar draws them", () => {
    const sectioned = [
      { ...row("zed", "a"), section: undefined },
      { ...row("amy", "a"), section: undefined },
      { ...row("web", "a", { want: true }), section: "work" },
      { ...row("api", "a"), section: "work" },
      { ...row("bee", "a", { want: true }), section: "home" },
    ];
    expect(keys(shownRows(sectioned, view({ sort: "name" }), "a"))).toEqual(["amy", "zed", "api", "web", "bee"]);
    expect(keys(shownRows(sectioned, view({ sort: "needs" }), "a"))).toEqual(["zed", "amy", "web", "api", "bee"]);
  });

  it("leave out a folded section's chats on its own hub, bar the pinned ones", () => {
    const sectioned = [{ ...row("pin", "a", { pinned: true }), section: "work" }, { ...row("top", "a"), section: undefined }, { ...row("api", "a"), section: "work" }, { ...row("garden", "a"), section: "home" }];
    expect(keys(shownRows(sectioned, view(), "a", new Set([foldKey("a", "work")])))).toEqual(["pin", "top", "garden"]);
    // Another hub's fold of a section by the same id is that hub's alone.
    expect(keys(shownRows(sectioned, view(), "a", new Set([foldKey("b", "work")])))).toEqual(["pin", "top", "api", "garden"]);
  });

  it("keep the order they came in when sorted by recent", () => {
    const rest = ROWS.filter((r) => !r.pinned);
    expect(sortRows(rest, "recent")).toBe(rest);
  });
});

describe("the hub on show", () => {
  const hubs = [{ id: "a" }, { id: "b" }];
  it("is the one picked while it is paired, else the screen's", () => {
    expect(viewedHub(view({ hub: "b" }), hubs, "a")).toBe("b");
    expect(viewedHub(view({ hub: "gone" }), hubs, "a")).toBe("a");
    expect(viewedHub(view(), hubs, "a")).toBe("a");
  });
});
