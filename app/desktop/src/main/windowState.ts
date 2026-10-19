import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import { parseSaved, placeWindow, type Limits, type Placement, type SavedWindow } from "./windowBounds";

const file = (): string => join(app.getPath("userData"), "window-state.json");

const read = (): SavedWindow | null => {
  try {
    return parseSaved(JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    return null;
  }
};

/** Where the window opens: last time's place when it is still on a screen. */
export const restorePlacement = (limits: Limits): Placement => {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return placeWindow(read(), [primary.workArea, ...others.map((d) => d.workArea)], limits);
};

/** Saves the window's place as it changes (settled, not per pixel) and as it closes. */
export const trackPlacement = (win: BrowserWindow): void => {
  let timer: NodeJS.Timeout | undefined;
  const save = (): void => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    // The unmaximized bounds, so un-maximizing after a relaunch returns to the size it had.
    const saved: SavedWindow = { ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
    try {
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(saved));
      renameSync(tmp, file());
    } catch {
      // Not worth bothering anyone over: the window opens at the default place next time.
    }
  };
  const later = (): void => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("enter-full-screen", later);
  win.on("leave-full-screen", later);
  win.on("close", save);
};
