import { describe, expect, it } from "vitest";
import { onHome, openChatKey, paneStrip, sheetStrip, sideStrip, splitOf, SPLIT_LEAST } from "./split";

describe("splitOf", () => {
  it("keeps a phone, and the Duo folded, to one screen at a time", () => {
    expect(splitOf(402)).toBeUndefined();
    expect(splitOf(440)).toBeUndefined();
    expect(splitOf(SPLIT_LEAST - 1)).toBeUndefined();
  });

  it("puts the list beside the chat on a wide window, the two filling it", () => {
    const duo = splitOf(951);
    expect(duo).toEqual({ list: 342, chat: 609 });
    const mini = splitOf(744);
    expect(mini?.list).toBe(320);
    expect(mini && mini.list + mini.chat).toBe(744);
  });

  it("never makes the list narrower than Messages' sidebar or wider than it needs", () => {
    expect(splitOf(SPLIT_LEAST)?.list).toBe(320);
    expect(splitOf(1366)?.list).toBe(400);
  });
});

describe("openChatKey", () => {
  it("is the topmost chat, under whatever is over it", () => {
    const routes = [{ name: "Home" }, { name: "Chat", params: { key: "m1/a" } }, { name: "Chat", params: { key: "m1/b" } }, { name: "ChatInfo", params: { screen: "Info" } }];
    expect(openChatKey(routes)).toBe("m1/b");
  });

  it("is none with only the list, or Settings, open", () => {
    expect(openChatKey([{ name: "Home" }])).toBeUndefined();
    expect(openChatKey([{ name: "Home" }, { name: "Settings" }])).toBeUndefined();
  });

  it("is none with Home over the chat, as Open Approvals leaves it", () => {
    expect(openChatKey([{ name: "Home" }, { name: "Chat", params: { key: "m1/a" } }, { name: "Home" }])).toBeUndefined();
  });
});

describe("onHome", () => {
  it("is a chat straight on Home, not one over another screen", () => {
    const routes = [{ name: "Home" }, { name: "Chat" }, { name: "Settings" }, { name: "Chat" }];
    expect(onHome(routes, 1)).toBe(true);
    expect(onHome(routes, 3)).toBe(false);
    expect(onHome(routes, 0)).toBe(false);
  });
});

describe("sheetStrip", () => {
  it("keeps a sheet out of the strip where it spans the folded window, and leaves a centred card as it is", () => {
    expect(sheetStrip({ left: 0, right: 84 }, 466)).toEqual({ left: 0, right: 84 });
    expect(sheetStrip({ left: 0, right: 84 }, 951)).toBeUndefined();
    expect(sheetStrip(undefined, 402)).toBeUndefined();
  });
});

describe("sideStrip", () => {
  it("is the Duo's column at the side, which has no top inset", () => {
    expect(sideStrip({ top: 0, left: 0, right: 84 })).toEqual({ left: 0, right: 84 });
    expect(sideStrip({ top: 0, left: 84, right: 0 })).toEqual({ left: 84, right: 0 });
  });

  it("is none where the status is across the top, or there are no side insets", () => {
    expect(sideStrip({ top: 62, left: 0, right: 0 })).toBeUndefined();
    expect(sideStrip({ top: 24, left: 0, right: 0 })).toBeUndefined();
    expect(sideStrip({ top: 0, left: 0, right: 0 })).toBeUndefined();
  });
});

describe("paneStrip", () => {
  const strip = { left: 0, right: 84 };

  it("is the whole strip for a screen with the window to itself", () => {
    expect(paneStrip(strip, undefined)).toEqual(strip);
  });

  it("is the right edge's for the chat's pane and none for the list's, where the strip is at the right", () => {
    expect(paneStrip(strip, "chat")).toEqual({ left: 0, right: 84 });
    expect(paneStrip(strip, "list")).toBeUndefined();
    expect(paneStrip({ left: 84, right: 0 }, "list")).toEqual({ left: 84, right: 0 });
    expect(paneStrip({ left: 84, right: 0 }, "chat")).toBeUndefined();
  });

  it("is none where there is no strip", () => {
    expect(paneStrip(undefined, undefined)).toBeUndefined();
  });
});
