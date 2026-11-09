import { describe, expect, it } from "vitest";
import { foldKey, resized, shownRows, sidebarHidden, toggled, type SidebarState } from "./sidebarState";

const wide: SidebarState = { narrow: false, hiddenWide: false, shownNarrow: false };

describe("the sidebar's visibility", () => {
  it("shows in a wide window and hides itself in a narrow one", () => {
    expect(sidebarHidden(wide)).toBe(false);
    expect(sidebarHidden(resized(wide, true))).toBe(true);
  });

  it("can be shown in a narrow window, and hides again the next time the window narrows", () => {
    const shown = toggled(resized(wide, true));
    expect(sidebarHidden(shown)).toBe(false);
    expect(sidebarHidden(resized(resized(shown, false), true))).toBe(true);
  });

  it("keeps the wide choice across a trip through narrow", () => {
    const hidden = toggled(wide);
    expect(sidebarHidden(hidden)).toBe(true);
    const back = resized(toggled(resized(hidden, true)), false);
    expect(sidebarHidden(back)).toBe(true);
  });

  it("changes nothing when the width stays on the same side", () => {
    const shown = toggled(resized(wide, true));
    expect(resized(shown, true)).toBe(shown);
  });
});

describe("the rows on show, which ⌘1–9 count", () => {
  const row = (key: string, hub: string, section?: string, pinned = false) => ({ key, hub, section, pinned });
  const ROWS = [row("pin", "a", "work", true), row("top", "a"), row("api", "a", "work"), row("garden", "a", "home"), row("other", "b", "work")];
  const keys = (rows: ReadonlyArray<{ key: string }>) => rows.map((r) => r.key);

  it("leaves out a folded section's chats on its own hub, bar the pinned ones", () => {
    expect(keys(shownRows(ROWS, new Set(), true, new Set()))).toEqual(["pin", "top", "api", "garden", "other"]);
    expect(keys(shownRows(ROWS, new Set(), true, new Set([foldKey("a", "work")])))).toEqual(["pin", "top", "garden", "other"]);
  });

  it("leaves out a collapsed hub's rows only while there are several hubs", () => {
    expect(keys(shownRows(ROWS, new Set(["a"]), true, new Set()))).toEqual(["other"]);
    expect(keys(shownRows(ROWS, new Set(["a"]), false, new Set()))).toEqual(["pin", "top", "api", "garden", "other"]);
  });
});
