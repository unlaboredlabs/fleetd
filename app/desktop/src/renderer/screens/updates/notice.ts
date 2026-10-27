// The one quiet notice that a newer fleetd is downloaded and ready: once per version, kept across launches, so it
// never nags. While the sheet is open it says the same there, so it counts as seen and doesn't show.
import type { Notice } from "./model";

const KEY = "fleetd.updateNoticed";

export interface NoticeDeps {
  /** The version the notice last showed for. */
  readonly seen: () => string | null;
  readonly mark: (version: string) => void;
  readonly show: (notice: Notice) => void;
}

/** Shows `notice` unless its version was noticed before; true when it showed. */
export const noticeOnce = (notice: Notice | null, sheetOpen: boolean, deps: NoticeDeps): boolean => {
  if (notice === null || deps.seen() === notice.version) return false;
  deps.mark(notice.version);
  if (sheetOpen) return false;
  deps.show(notice);
  return true;
};

/** Where the notice remembers its version: this app's localStorage. Without storage it lasts until the window closes. */
let held: string | null = null;
export const storedNotice: Pick<NoticeDeps, "seen" | "mark"> = {
  seen: () => {
    try {
      return window.localStorage.getItem(KEY) ?? held;
    } catch {
      return held;
    }
  },
  mark: (version) => {
    held = version;
    try {
      window.localStorage.setItem(KEY, version);
    } catch {
      // Kept in memory only.
    }
  },
};
