import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { revealWhenReady } from "./reveal";

const setup = (platform: NodeJS.Platform) => {
  const page = new EventEmitter();
  let destroyed = false;
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, webContents: page });
  const show = vi.fn();
  revealWhenReady(win, show, platform);
  return { win, page, show, destroy: () => (destroyed = true) };
};

describe("revealWhenReady", () => {
  it("shows the window once its page is ready to show", () => {
    const { win, page, show } = setup("darwin");
    win.emit("ready-to-show");
    page.emit("did-finish-load");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("on macOS, waits for ready-to-show however long the page has been loaded", () => {
    const { page, show } = setup("darwin");
    page.emit("did-finish-load");
    expect(show).not.toHaveBeenCalled();
  });

  // electron/electron#48859: on Linux, ready-to-show can never come.
  it("on Linux, shows the window once its page has loaded when ready-to-show doesn't come", () => {
    const { win, page, show } = setup("linux");
    page.emit("did-finish-load");
    expect(show).toHaveBeenCalledTimes(1);
    win.emit("ready-to-show");
    page.emit("did-finish-load");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("doesn't show a window closed before it was ready", () => {
    const { win, show, destroy } = setup("linux");
    destroy();
    win.emit("ready-to-show");
    expect(show).not.toHaveBeenCalled();
  });
});
