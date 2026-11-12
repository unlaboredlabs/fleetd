import { describe, expect, it } from "vitest";
import { devicesStack, tapGoesNowhere, tappedStack, type StackRoute } from "./tapped";

const home: StackRoute = { key: "Home-1", name: "Home" };
const chat = (key: string, n = 1): StackRoute => ({ key: `Chat-${key}-${String(n)}`, name: "Chat", params: { key } });

describe("tappedStack", () => {
  it("opens a tapped chat over the list, not in place of the chat that was open", () => {
    expect(tappedStack([home, chat("m1/a")], { key: "m1/b" }, 1)).toEqual({
      index: 1,
      routes: [
        { key: "Home-1", name: "Home" },
        { name: "Chat", params: { key: "m1/b", tap: 1 } },
      ],
    });
  });

  it("closes a sheet, Settings or a live view, so the chat never opens under them", () => {
    const sheet: StackRoute = { key: "NewProject-1", name: "NewProject" };
    const live: StackRoute = { key: "Screen-1", name: "Screen", params: { key: "m1/a", sessionId: "s1" } };
    for (const top of [sheet, live, { key: "Settings-1", name: "Settings" }]) {
      const at = tappedStack([home, chat("m1/a"), top], { key: "m1/b", requestId: "r1" }, 2);
      expect(at.routes.map((r) => r.name)).toEqual(["Home", "Chat"]);
      expect(at.routes[1]).toEqual({ name: "Chat", params: { key: "m1/b", requestId: "r1", tap: 2 } });
    }
  });

  it("keeps the chat already open, its screen and draft, and lands it again", () => {
    const at = tappedStack([home, chat("m1/b"), { key: "ChatInfo-1", name: "ChatInfo" }], { key: "m1/b", requestId: "r2" }, 3);
    expect(at).toEqual({ index: 1, routes: [{ key: "Home-1", name: "Home" }, { key: "Chat-m1/b-1", name: "Chat", params: { key: "m1/b", requestId: "r2", tap: 3 } }] });
  });

  it("finds the tapped chat further down the stack", () => {
    const at = tappedStack([home, chat("m1/b"), chat("m1/a")], { key: "m1/b" }, 4);
    expect(at.routes).toEqual([{ key: "Home-1", name: "Home" }, { key: "Chat-m1/b-1", name: "Chat", params: { key: "m1/b", tap: 4 } }]);
  });

  it("puts a screen's live view over its chat, and keeps one already watching it", () => {
    expect(tappedStack([home], { key: "m1/a", sessionId: "s1" }, 5)).toEqual({
      index: 2,
      routes: [
        { key: "Home-1", name: "Home" },
        { name: "Chat", params: { key: "m1/a", tap: 5 } },
        { name: "Screen", params: { key: "m1/a", sessionId: "s1" } },
      ],
    });
    const watching: StackRoute = { key: "Screen-9", name: "Screen", params: { key: "m1/a", sessionId: "s1" } };
    expect(tappedStack([home, chat("m1/a"), watching], { key: "m1/a", sessionId: "s1" }, 6).routes[2]).toEqual({ key: "Screen-9", name: "Screen", params: { key: "m1/a", sessionId: "s1" } });
  });

  it("keeps the chats list's own stack, so Back finds it scrolled and searched as it was", () => {
    const list = { key: "Home-1", name: "Home", state: { index: 0, routes: [{ key: "Chats-1", name: "Chats" }] } };
    expect(tappedStack([list, chat("m1/a")], { key: "m1/b" }, 8).routes[0]).toEqual(list);
  });

  it("starts from the list when the app has no stack yet", () => {
    expect(tappedStack([], { key: "m1/a" }, 7).routes).toEqual([{ name: "Home" }, { name: "Chat", params: { key: "m1/a", tap: 7 } }]);
  });
});

describe("tapGoesNowhere", () => {
  it("opens nothing for a chat removed since, once the chats are known", () => {
    expect(tapGoesNowhere({ "m1/a": {} }, { key: "m1/b" })).toBe(true);
    expect(tapGoesNowhere({ "m1/a": {} }, { key: "m1/a" })).toBe(false);
    expect(tapGoesNowhere(undefined, { key: "m1/b" })).toBe(false);
  });
});

describe("devicesStack", () => {
  it("opens Settings' Devices over the chats list, whatever was open, with Back to Settings", () => {
    const list: StackRoute = { key: "Home-1", name: "Home", state: { index: 0 } };
    for (const top of [chat("m1/a"), { key: "Settings-1", name: "Settings", state: { index: 1 } }, { key: "NewProject-1", name: "NewProject" }]) {
      expect(devicesStack([list, top])).toEqual({
        index: 1,
        routes: [
          { key: "Home-1", name: "Home", state: { index: 0 } },
          { name: "Settings", state: { index: 1, routes: [{ name: "Settings" }, { name: "Devices" }] } },
        ],
      });
    }
    expect(devicesStack([]).routes[0]).toEqual({ name: "Home" });
  });
});
