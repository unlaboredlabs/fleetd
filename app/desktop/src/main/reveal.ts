// Shows a window made with `show: false` once its page is ready, so it never opens blank.
//
// ready-to-show waits for the page's first non-empty layout, which Chromium sometimes never reports on Linux with
// software compositing (electron/electron#48859: the renderer runs and the page loads, but the window stays hidden
// for good). It hit the Linux QA runners, which composite in software, as a window that never showed. So on Linux
// the window shows too once its page has loaded, whichever comes first; its background colour, the theme's, stands in
// until the page paints. macOS keeps ready-to-show alone: its see-through sidebar would show bare for a frame.

/** The slice of BrowserWindow this needs; a fake in tests. */
export interface RevealedWindow {
  isDestroyed(): boolean;
  once(event: "ready-to-show", listener: () => void): unknown;
  readonly webContents: { once(event: "did-finish-load", listener: () => void): unknown };
}

/** Calls `show` once, when `win`'s page is ready to show (or, on Linux, has loaded). */
export const revealWhenReady = (win: RevealedWindow, show: () => void, platform: NodeJS.Platform = process.platform): void => {
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    show();
  };
  win.once("ready-to-show", reveal);
  if (platform === "linux") win.webContents.once("did-finish-load", reveal);
};
