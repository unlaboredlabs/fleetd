import { describe, expect, it } from "vitest";
import { resized, sidebarHidden, toggled, type SidebarState } from "./sidebarState";

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
