import { expect, it } from "vitest";
import { sections } from "./ShortcutsSheet";

it("lists each section once, a part's own keys among the menu's rows of the same name", () => {
  const all = sections("linux");
  const names = all.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  const composer = all.find((s) => s.name === "Composer")?.rows.map((r) => [r.title, r.keys.join(" ")]);
  expect(composer).toEqual([
    ["Attach a File", "Ctrl+Shift+A"],
    ["Stop the Agent’s Step and Send Now", "Ctrl+Enter"],
  ]);
});

it("writes Enter and Title Case on every row, as the menus do", () => {
  const rows = sections("linux").flatMap((s) => s.rows);
  for (const r of rows) {
    expect(r.keys.join(" ")).not.toContain("↩");
    expect(r.title.charAt(0)).toBe(r.title.charAt(0).toUpperCase());
  }
  expect(rows.find((r) => r.title === "Move the Selection")).toBeDefined();
});
