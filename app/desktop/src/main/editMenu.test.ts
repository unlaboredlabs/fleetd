import { expect, it } from "vitest";
import { editMenuTemplate } from "./editMenu";

const FLAGS = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

it("a text field gets Cut, Copy, Paste and Select All, each on as Chromium says", () => {
  const menu = editMenuTemplate({ isEditable: true, selectionText: "", editFlags: { ...FLAGS, canCut: false, canCopy: false } });
  expect(menu?.map((i) => i.role ?? i.type)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
  expect(menu?.map((i) => i.enabled)).toEqual([false, false, true, undefined, true]);
});

it("selected text outside a field gets Copy; nothing else gets a menu", () => {
  expect(editMenuTemplate({ isEditable: false, selectionText: "PR #12", editFlags: FLAGS })).toEqual([{ role: "copy", enabled: true }]);
  expect(editMenuTemplate({ isEditable: false, selectionText: "  ", editFlags: FLAGS })).toBeNull();
});
