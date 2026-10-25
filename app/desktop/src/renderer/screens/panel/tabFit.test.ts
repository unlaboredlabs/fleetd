import { describe, expect, it } from "vitest";
import { fitTabs, type TabWidths } from "./tabFit";

// Six tabs, as the panel will have: labels take 90 px each, icons 40, with 4 px between and a 28 px More.
const six: TabWidths = { full: [90, 90, 90, 90, 90, 90], icon: [40, 40, 40, 40, 40, 40], gap: 4, more: 28 };

describe("the tab bar's fit", () => {
  it("shows every label while they fit, then icons only", () => {
    expect(fitTabs(six, 560, 0)).toEqual({ labels: true, shown: [0, 1, 2, 3, 4, 5], more: [] });
    expect(fitTabs(six, 559, 0)).toEqual({ labels: false, shown: [0, 1, 2, 3, 4, 5], more: [] });
    expect(fitTabs(six, 260, 3)).toEqual({ labels: false, shown: [0, 1, 2, 3, 4, 5], more: [] });
  });

  it("puts the tabs past the bar under More, in order, and always keeps the open one on the bar", () => {
    expect(fitTabs(six, 210, 0)).toEqual({ labels: false, shown: [0, 1, 2, 3], more: [4, 5] });
    expect(fitTabs(six, 210, 5)).toEqual({ labels: false, shown: [0, 1, 2, 5], more: [3, 4] });
    // Not even one beside More: the open one shows anyway.
    expect(fitTabs(six, 10, 4)).toEqual({ labels: false, shown: [4], more: [0, 1, 2, 3, 5] });
  });

  it("shows every label when nothing was measured (no layout)", () => {
    expect(fitTabs({ full: [0, 0, 0], icon: [0, 0, 0], gap: 0, more: 0 }, 0, 1).labels).toBe(true);
  });
});
