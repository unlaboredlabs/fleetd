// A session in a window of its own: the pop-out the person takes a page over in, roomier than the panel. It is the
// app's own page at the session's route (`#/session/<machine>/<project>/<session>`), which renders the session alone
// (renderer sessions/SessionWindow): the main window keeps the notifications, the badge and the menu. One window per
// session; asked again, it comes forward. Main builds the route from the ids, never from a URL the page sends.
import type { BrowserWindow } from "electron";
import type { SessionWindowRequest } from "../shared/ipc";

/** The route a session's window opens on. */
export const sessionHash = ({ machineId, projectId, session }: SessionWindowRequest): string =>
  `#/session/${[machineId, projectId, session].map(encodeURIComponent).join("/")}`;

export class SessionWindows {
  readonly #open = new Map<string, BrowserWindow>();
  readonly #create: (hash: string) => BrowserWindow;

  constructor(create: (hash: string) => BrowserWindow) {
    this.#create = create;
  }

  show(request: SessionWindowRequest): void {
    const hash = sessionHash(request);
    const held = this.#open.get(hash);
    if (held !== undefined && !held.isDestroyed()) {
      if (held.isMinimized()) held.restore();
      held.focus();
      return;
    }
    const win = this.#create(hash);
    this.#open.set(hash, win);
    win.once("closed", () => {
      if (this.#open.get(hash) === win) this.#open.delete(hash);
    });
  }
}
