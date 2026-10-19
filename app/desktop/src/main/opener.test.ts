import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { Opener, type OpenerWindow } from "./opener";

const fakeWindow = () => {
  const sent: Array<unknown> = [];
  let closed: (() => void) | undefined;
  let destroyed = false;
  const win: OpenerWindow = {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: (_event, listener) => (closed = listener),
    webContents: {
      send: (channel, ...args) => sent.push([channel, ...args]),
      on: () => undefined,
    },
  };
  const close = () => {
    destroyed = true;
    closed?.();
  };
  return { win, sent, close };
};

const LINK = "fleetd://pair?hub=http%3A%2F%2F100.64.0.1%3A4790&code=ABCD-2345";
const PAIR = { kind: "pair", hub: "http://100.64.0.1:4790", code: "ABCD-2345" };

describe("Opener", () => {
  it("holds a launch link until the page listens", () => {
    const opener = new Opener();
    opener.openLink(LINK);
    const first = fakeWindow();
    opener.attach(first.win);
    expect(first.sent).toEqual([]);
    opener.ready();
    expect(first.sent).toEqual([[IPC.appOpen, PAIR]]);
  });

  it("opens a new window for a link or a notification click when the window was closed (macOS)", () => {
    const opener = new Opener();
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    opener.setHooks({
      create: () => {
        const w = fakeWindow();
        windows.push(w);
        opener.attach(w.win);
      },
    });
    opener.focus();
    opener.ready();
    windows[0]?.close();

    opener.open({ kind: "ask", askId: "A1" });
    expect(windows).toHaveLength(2);
    const second = windows[1];
    expect(second?.sent).toEqual([]);
    opener.ready();
    expect(second?.sent).toEqual([[IPC.appOpen, { kind: "ask", askId: "A1" }]]);
  });

  it("keeps only the latest target of a kind while it waits", () => {
    const opener = new Opener();
    opener.open({ kind: "ask", askId: "A1" });
    opener.open({ kind: "ask", askId: "A2" });
    opener.open({ kind: "inbox" });
    const w = fakeWindow();
    opener.attach(w.win);
    opener.ready();
    expect(w.sent).toEqual([
      [IPC.appOpen, { kind: "ask", askId: "A2" }],
      [IPC.appOpen, { kind: "inbox" }],
    ]);
  });
});
