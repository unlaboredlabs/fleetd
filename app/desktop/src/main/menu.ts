import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/menu";
import { RELEASE_BUILD } from "./build";
import type { Opener } from "./opener";
import { accelerator, isShortcutId } from "../shared/shortcuts";

const REPO_URL = "https://github.com/unlaboredlabs/fleetd";
const DOCS_URL = "https://fleetd.sh/docs";


/**
 * A menu item that runs a palette command. Its key is shared/shortcuts.ts's: the renderer's keymap runs it, so a
 * click here only covers the mouse. Linux doesn't register the accelerator at all (it would fire twice there);
 * macOS needs it registered to show it, and hands a key the page didn't take to the menu, which ignores it.
 */
const item = (opener: Opener, id: MenuCommand, label: string): MenuItemConstructorOptions => ({
  // The id is the command id, so the renderer's enabled list (menuState.ts) finds the item.
  id,
  label,
  ...(isShortcutId(id) ? { accelerator: accelerator(id), registerAccelerator: process.platform === "darwin" } : {}),
  // With the window closed (macOS), a click opens it and runs the command once the page is up.
  click: (_item, _window, event) => {
    if (event.triggeredByAccelerator) return;
    opener.command(id);
  },
});

/**
 * The full app menu. Edit uses Chromium's own roles, so Undo/Cut/Copy/Paste/Select All act on whichever text field
 * has focus, and macOS adds its dictation and emoji items to it.
 */
export const installMenu = (
  opener: Opener,
  checkForUpdates: (() => Promise<void>) | null,
  help: { readonly revealLogs: () => void; readonly copyDiagnostics: () => void },
): void => {
  const mac = process.platform === "darwin";
  const separator = { type: "separator" } as const;
  // Only a release build has an updater (dev and test builds get null), so they don't show the item at all.
  const updates: Array<MenuItemConstructorOptions> =
    checkForUpdates === null
      ? []
      : [
          {
            label: "Check for Updates…",
            // Off while a check or its download runs, so a second click can't stack a second answer.
            click: (menuItem) => {
              menuItem.enabled = false;
              void checkForUpdates().finally(() => {
                menuItem.enabled = true;
              });
            },
          },
        ];
  const template: Array<MenuItemConstructorOptions> = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              ...updates,
              separator,
              item(opener, "settings.open", "Settings…"),
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
        item(opener, "go:projects.add", "Add Project…"),
        item(opener, "composer.focus", "Focus Composer"),
        separator,
        ...(mac ? [{ role: "close" } as const] : [item(opener, "settings.open", "Settings…"), separator, { role: "quit" } as const]),
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
        item(opener, "status.toggle", "Status"),
        item(opener, "go:time", "Time"),
        separator,
        item(opener, "palette.toggle", "Command Palette"),
        item(opener, "shortcuts.show", "Keyboard Shortcuts"),
        item(opener, "sidebar.toggle", "Toggle Sidebar"),
        separator,
        { role: "togglefullscreen" },
        // Reload and devtools only in dev and test builds: a reload drops the live view's state for nothing, and
        // devtools reach window.fleetd. Keyed on the build, not app.isPackaged (the executable's name).
        ...(RELEASE_BUILD ? [] : [separator, { role: "reload" } as const, { role: "toggleDevTools" } as const]),
      ],
    },
    {
      label: "Project",
      submenu: [item(opener, "project.previous", "Previous Project"), item(opener, "project.next", "Next Project")],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "fleetd on GitHub", click: () => void shell.openExternal(REPO_URL) },
        { label: "Docs", click: () => void shell.openExternal(DOCS_URL) },
        separator,
        // For a bug report: the app log (main/applog.ts) and the version, OS, connection and recent log lines.
        { label: "Reveal Logs", click: help.revealLogs },
        { label: "Copy Diagnostics", click: help.copyDiagnostics },
        ...(mac ? [] : [separator, ...updates, { role: "about" } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};
