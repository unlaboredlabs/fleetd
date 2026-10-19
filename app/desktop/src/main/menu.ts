import { app, BrowserWindow, Menu, shell, type BaseWindow, type MenuItemConstructorOptions } from "electron";
import { IPC } from "../shared/channels";
import { accelerator, SHORTCUTS, type ShortcutId } from "../shared/shortcuts";

const REPO_URL = "https://github.com/unlaboredlabs/fleetd";
const DOCS_URL = "https://fleetd.sh/docs";

/** Palette commands that have a menu item but no key. */
type MenuOnlyId = "project.add";

const send = (id: ShortcutId | MenuOnlyId, focused: BaseWindow | undefined): void => {
  const win = (focused instanceof BrowserWindow ? focused : null) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win === undefined || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  win.webContents.send(IPC.menuCommand, id);
};

/**
 * A menu item that runs a palette command. Its key is shared/shortcuts.ts's: the renderer's keymap runs it, so a
 * click here only covers the mouse. Linux doesn't register the accelerator at all (it would fire twice there);
 * macOS needs it registered to show it, and hands a key the page didn't take to the menu, which ignores it.
 */
const item = (id: ShortcutId | MenuOnlyId, label?: string): MenuItemConstructorOptions => {
  const shortcut = id in SHORTCUTS ? (id as ShortcutId) : undefined;
  return {
    label: label ?? (shortcut === undefined ? id : SHORTCUTS[shortcut].title),
    ...(shortcut === undefined ? {} : { accelerator: accelerator(shortcut), registerAccelerator: process.platform === "darwin" }),
    click: (_item, focused, event) => {
      if (event.triggeredByAccelerator) return;
      send(id, focused);
    },
  };
};

/**
 * The full app menu. Edit uses Chromium's own roles, so Undo/Cut/Copy/Paste/Select All act on whichever text field
 * has focus, and macOS adds its dictation and emoji items to it.
 */
export const installMenu = (): void => {
  const mac = process.platform === "darwin";
  const separator = { type: "separator" } as const;
  const template: Array<MenuItemConstructorOptions> = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              separator,
              item("settings.open", "Settings…"),
              separator,
              { role: "services" },
              separator,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              separator,
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        item("order.new", "New Order"),
        item("project.add", "Add Project…"),
        item("composer.focus", "Focus Composer"),
        separator,
        ...(mac ? [{ role: "close" } as const] : [item("settings.open", "Settings…"), separator, { role: "quit" } as const]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(mac ? [{ role: "pasteAndMatchStyle" } as const] : []),
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        item("status.toggle", "Status"),
        item("board.open", "Board"),
        item("inbox.toggle", "Inbox"),
        item("board.toggleGrouping", "Group by Project or Status"),
        separator,
        item("palette.toggle", "Command Palette"),
        item("shortcuts.show", "Keyboard Shortcuts"),
        item("sidebar.toggle", "Toggle Sidebar"),
        separator,
        { role: "togglefullscreen" },
        // Reload and devtools only in development: a reload drops the live view's state for nothing.
        ...(app.isPackaged ? [] : [separator, { role: "reload" } as const, { role: "toggleDevTools" } as const]),
      ],
    },
    {
      label: "Order",
      submenu: [item("order.previous", "Previous Order"), item("order.next", "Next Order"), separator, item("order.stop", "Stop Order…")],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "fleetd on GitHub", click: () => void shell.openExternal(REPO_URL) },
        { label: "Docs", click: () => void shell.openExternal(DOCS_URL) },
        ...(mac ? [] : [separator, { role: "about" } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};
