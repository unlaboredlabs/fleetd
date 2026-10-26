import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/**
 * The native menu a right-click (or Shift+F10, or the Menu key) gets where the page shows none of its own: in a text
 * field, Cut/Copy/Paste/Select All, each on when Chromium says it can act; over selected text elsewhere, Copy. The
 * page's own menus (ui/primitives/ContextMenu) cancel the event, so they never get this as well. Null: no menu.
 */
export const editMenuTemplate = (params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">): MenuItemConstructorOptions[] | null => {
  const flags = params.editFlags;
  if (params.isEditable) {
    return [
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    ];
  }
  if (params.selectionText.trim() !== "") return [{ role: "copy", enabled: flags.canCopy }];
  return null;
};
