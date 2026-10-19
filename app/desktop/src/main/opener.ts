import { app, BrowserWindow } from "electron";
import { parseDeepLink, type OpenTarget } from "../shared/app";
import { IPC } from "../shared/channels";

/**
 * Brings the window forward on something to open (a clicked notification, a fleetd:// link). A target that
 * arrives before the page listens (the link that launched the app) waits for it.
 */
export class Opener {
  #window: BrowserWindow | undefined;
  #ready = false;
  #held: Array<OpenTarget> = [];

  attach(win: BrowserWindow): void {
    this.#window = win;
    this.#ready = false;
    // A reload or a crashed renderer starts a new page, which must say it is ready again.
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.#ready = false;
    });
    win.once("closed", () => {
      if (this.#window === win) this.#window = undefined;
    });
  }

  /** The page listens now; hand it what was held. */
  ready(): void {
    this.#ready = true;
    const held = this.#held;
    this.#held = [];
    for (const target of held) this.open(target);
  }

  open(target: OpenTarget): void {
    const win = this.#window;
    if (win === undefined || win.isDestroyed() || !this.#ready) {
      // Only the latest of each kind matters: a second pairing link replaces the first.
      this.#held = [...this.#held.filter((t) => t.kind !== target.kind), target];
      return;
    }
    this.focus();
    win.webContents.send(IPC.appOpen, target);
  }

  focus(): void {
    const win = this.#window;
    if (win === undefined || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  }

  /** A fleetd:// link; anything that isn't one we know is ignored. */
  openLink(link: string): void {
    const target = parseDeepLink(link);
    if (target !== null) this.open(target);
  }
}

/** The fleetd:// links in a command line (Linux passes them to `Exec=fleetd %u`, and to a second instance). */
export const linksIn = (argv: ReadonlyArray<string>): Array<string> => argv.filter((arg) => arg.startsWith("fleetd://"));

/**
 * Registers fleetd:// and routes links to the opener. Call before `ready`: macOS sends a launch link as an
 * `open-url` event right after `will-finish-launching`. Returns false when another instance already runs (this
 * one handed its links over and should quit).
 */
export const listenForLinks = (opener: Opener): boolean => {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", (_event, argv) => {
    // Launching the app again while it runs brings this window forward, on the link if it came with one.
    opener.focus();
    for (const link of linksIn(argv)) opener.openLink(link);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    opener.openLink(url);
  });
  for (const link of linksIn(process.argv)) opener.openLink(link);
  // In development the scheme would point at the bare Electron binary; only a packaged app registers it.
  if (app.isPackaged) app.setAsDefaultProtocolClient("fleetd");
  return true;
};
