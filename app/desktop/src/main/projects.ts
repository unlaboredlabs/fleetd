// Main's part of Add project: the native folder picker and this computer's name.

import { hostname } from "node:os";
import { BrowserWindow, dialog, type WebContents } from "electron";

export { readDrop } from "./drop";

export const pickFolder = async (sender: WebContents): Promise<string | null> => {
  const win = BrowserWindow.fromWebContents(sender);
  const options = { title: "Add a project", buttonLabel: "Add", properties: ["openDirectory" as const] };
  const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

export const hostName = (): string => hostname().replace(/\.local$/u, "");
