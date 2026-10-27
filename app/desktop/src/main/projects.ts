// Main's part of Add project: the native folder picker and this computer's name.

import { hostname } from "node:os";
import { BrowserWindow, dialog, type WebContents } from "electron";

import { RELEASE_BUILD } from "./build";
import { fixtureRequest } from "./hub/fixture";

export { readDrop } from "./drop";

export const pickFolder = async (sender: WebContents): Promise<string | null> => {
  const win = BrowserWindow.fromWebContents(sender);
  const options = { title: "Add a project", buttonLabel: "Add", properties: ["openDirectory" as const] };
  const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

/** This computer's name; under a fixture, a stand-in, so a screenshot never shows the name of the machine that took it. */
export const hostName = (fixture = fixtureRequest(process.env, RELEASE_BUILD).kind === "fixture"): string =>
  fixture ? "laptop" : hostname().replace(/\.local$/u, "");
