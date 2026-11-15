// The browser's notifications (browser.ts browserNotify), with Notification faked: permission is asked from a click only.
import { describe, expect, it } from "vitest";
import { browserNotify, type NotificationApi } from "./browser";

const fake = (permission: NotificationPermission, answer: NotificationPermission = "granted") => {
  const asked: number[] = [];
  const shown: string[] = [];
  class Fake {
    static permission = permission;
    static requestPermission() {
      asked.push(1);
      Fake.permission = answer;
      return Promise.resolve(answer);
    }
    onclick: ((this: never, ev: Event) => unknown) | null = null;
    constructor(title: string) {
      shown.push(title);
    }
    close() {}
  }
  return { api: Fake as unknown as NotificationApi, asked, shown };
};

const options = { body: "", tag: "test" };

describe("browserNotify", () => {
  it("asks for permission from a click, then shows", async () => {
    const n = fake("default");
    expect(await browserNotify(n.api, () => true)("Hi", options, () => undefined)).toBe(true);
    expect(n.asked).toHaveLength(1);
    expect(n.shown).toEqual(["Hi"]);
  });

  it("never asks without a click, which Safari and Firefox would ignore or deny for good", async () => {
    const n = fake("default");
    expect(await browserNotify(n.api, () => false)("Hi", options, () => undefined)).toBe(false);
    expect(n.asked).toHaveLength(0);
    expect(n.shown).toEqual([]);
  });

  it("shows once allowed and never once blocked, asking neither time", async () => {
    const allowed = fake("granted");
    expect(await browserNotify(allowed.api, () => false)("Hi", options, () => undefined)).toBe(true);
    const blocked = fake("denied");
    expect(await browserNotify(blocked.api, () => true)("Hi", options, () => undefined)).toBe(false);
    expect([...allowed.asked, ...blocked.asked]).toHaveLength(0);
  });

  it("answers false where the browser has no notifications", async () => {
    expect(await browserNotify(undefined, () => true)("Hi", options, () => undefined)).toBe(false);
  });
});
