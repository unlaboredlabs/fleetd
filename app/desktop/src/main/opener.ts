// Brings the window forward on something to open (a clicked notification, a fleetd:// link). No electron import,
// so it is unit-tested with a fake window; index.ts hands it the real ones.
import { parseDeepLink, type OpenTarget } from "../shared/app";
import { IPC } from "../shared/channels";

/** The parts of a BrowserWindow the opener uses. */
export interface OpenerWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  once(event: "closed", listener: () => void): unknown;
  readonly webContents: {
    send(channel: string, ...args: Array<unknown>): void;
    on(event: "did-start-navigation", listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown;
  };
}

export interface OpenerHooks {
  /** Opens the app window (it attaches itself). Absent until the app is ready to make windows. */
  create?: () => void;
  /** Activates the app (macOS: a notification click or a link doesn't on its own). */
  activateApp?: () => void;
}

export class Opener {
  #window: OpenerWindow | undefined;
  #ready = false;
  #held: Array<OpenTarget> = [];
  #hooks: OpenerHooks = {};

  /** Called once the app is ready to make windows. */
  setHooks(hooks: OpenerHooks): void {
    this.#hooks = hooks;
  }

  attach(win: OpenerWindow): void {
    this.#window = win;
    this.#ready = false;
    // A reload or a crashed renderer starts a new page, which must say it is ready again.
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.#ready = false;
    });
    win.once("closed", () => {
      if (this.#window === win) {
        this.#window = undefined;
        this.#ready = false;
      }
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
    // On macOS the window may be closed while the app runs; a link or a notification click opens a new one.
    const win = this.focus();
    if (win === undefined || !this.#ready) {
      // Held until the page listens. Only the latest of each kind matters: a second pairing link replaces the first.
      this.#held = [...this.#held.filter((t) => t.kind !== target.kind), target];
      return;
    }
    win.webContents.send(IPC.appOpen, target);
  }

  /** Brings the window forward, opening one when there is none (and the app can). */
  focus(): OpenerWindow | undefined {
    if (this.#window === undefined || this.#window.isDestroyed()) this.#hooks.create?.();
    const win = this.#window;
    if (win === undefined || win.isDestroyed()) return undefined;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.#hooks.activateApp?.();
    return win;
  }

  /** A fleetd:// link; anything that isn't one we know is ignored. */
  openLink(link: string): void {
    const target = parseDeepLink(link);
    if (target !== null) this.open(target);
  }
}

/** The fleetd:// links in a command line (Linux passes them to `Exec=fleetd %u`, and to a second instance). */
export const linksIn = (argv: ReadonlyArray<string>): Array<string> => argv.filter((arg) => arg.startsWith("fleetd://"));
