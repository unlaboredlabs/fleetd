import { describe, expect, it } from "vitest";
import { listOrder, shownRows, viewedHub, type SidebarView } from "./sidebarLayout";

const row = (key: string, hub: string, at: string, more: { section?: string; pinned?: boolean } = {}) => ({ key, hub, at: `2026-11-18T${at}:00.000Z`, pinned: more.pinned ?? false, section: more.section });
// Each hub's rows as the frame has them: pins, the chats in no section, then section by section.
const ROWS = [row("pin", "a", "08:00", { section: "work", pinned: true }), row("top", "a", "09:00"), row("api", "a", "09:30", { section: "work" }), row("garden", "a", "07:00", { section: "home" }), row("other", "b", "09:10")];
const keys = (rows: ReadonlyArray<{ key: string }>) => rows.map((r) => r.key);
const view = (layout: SidebarView["layout"], section: string | null = null): SidebarView => ({ layout, hub: null, section });

describe("the rows on show, which ⌘1–9 count", () => {
  it("in List: the pins, then every hub's other bots newest first", () => {
    expect(keys(shownRows(ROWS, view("list"), "a"))).toEqual(["pin", "api", "other", "top", "garden"]);
  });

  it("in List, holds each row where it was while the pointer is over the list, a new one last", () => {
    expect(keys(listOrder(ROWS, ["top", "garden", "api"]))).toEqual(["pin", "top", "garden", "api", "other"]);
  });

  it("in Hubs: the hub on show's, in the frame's order", () => {
    expect(keys(shownRows(ROWS, view("hubs"), "a"))).toEqual(["pin", "top", "api", "garden"]);
    expect(keys(shownRows(ROWS, view("hubs"), "b"))).toEqual(["other"]);
  });

  it("in Rail: the hub on show's newest first, a tab's section alone, the pins whatever the tab", () => {
    expect(keys(shownRows(ROWS, view("rail"), "a"))).toEqual(["pin", "api", "top", "garden"]);
    expect(keys(shownRows(ROWS, view("rail", "work"), "a"))).toEqual(["pin", "api"]);
  });
});

describe("the hub on show", () => {
  const hubs = [{ id: "a" }, { id: "b" }];
  it("is the one picked while it is paired, else the screen's", () => {
    expect(viewedHub({ ...view("hubs"), hub: "b" }, hubs, "a")).toBe("b");
    expect(viewedHub({ ...view("hubs"), hub: "gone" }, hubs, "a")).toBe("a");
    expect(viewedHub(view("hubs"), hubs, "a")).toBe("a");
  });
});
