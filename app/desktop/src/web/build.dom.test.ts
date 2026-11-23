// @vitest-environment happy-dom
// A page left open on an older build: it learns of the new one and switches to it by itself when its tab is hidden or
// the person moves to another screen, never in front of them, offline, under their typing, an open dialog or a draft's
// files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, entryOf, followNewBuild } from "./build";
import { FRESH_LOAD } from "./shell";

const index = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entry}"></script><link rel="modulepreload" crossorigin href="/assets/hubs-1.js"></head><body><div id="root"></div></body></html>`;

/** Where the page is: its address, which a move to another screen changes. */
const at = { href: "" };
const page = { document, location: at as Location, sessionStorage: window.sessionStorage, addEventListener: window.addEventListener.bind(window) };

/** The cloud serving `current` as its build; a page on `own` follows it. */
const open = (own: string, opts: { holding?: () => boolean } = {}) => {
  const cloud = { current: own, asked: 0, down: false };
  const went: string[] = [];
  let focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  let online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  window.sessionStorage.setItem(FRESH_LOAD, "1");
  followNewBuild(page, {
    own: `/assets/${own}`,
    fetch: () => {
      cloud.asked++;
      return cloud.down ? Promise.reject(new Error("offline")) : Promise.resolve(new Response(index(cloud.current)));
    },
    go: (url) => void went.push(url),
    holding: opts.holding ?? (() => false),
  });
  return {
    cloud,
    went,
    blur: () => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
    },
    offline: (off: boolean) => {
      online = !off;
      window.dispatchEvent(new Event(off ? "offline" : "online"));
    },
    hide: () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
};

const settle = () => vi.advanceTimersByTimeAsync(0);
/** A deploy: the cloud now serves `entry`, which the page finds at its next ask. */
const deploy = async (p: ReturnType<typeof open>, entry: string) => {
  p.cloud.current = entry;
  await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  at.href = "https://app.fleetd.dev/?team=t1#/project/a/b";
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("followNewBuild", () => {
  it("reads the build an index starts from", () => {
    expect(entryOf(index("index-c9xcZT_l.js"))).toBe("/assets/index-c9xcZT_l.js");
    // The dev server's index names its source, not a build.
    expect(entryOf('<script type="module" src="./main.tsx"></script>')).toBeNull();
  });

  it("never runs on a page that isn't a build", async () => {
    let asked = 0;
    followNewBuild(page, { own: null, fetch: () => Promise.resolve(new Response(String(asked++))), go: () => undefined, holding: () => false });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(asked).toBe(0);
  });

  it("stays on its build while the cloud serves the same one", async () => {
    const p = open("index-1.js");
    await settle();
    p.hide();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    expect(p.cloud.asked).toBeGreaterThan(1);
    expect(p.went).toEqual([]);
  });

  it("switches to a new build, fresh and on the same screen, once the tab is hidden", async () => {
    const p = open("index-1.js");
    await deploy(p, "index-2.js");
    // In front and in use: no reload under the person.
    expect(p.went).toEqual([]);
    p.hide();
    expect(p.went).toEqual(["https://app.fleetd.dev/?team=t1&fresh=1#/project/a/b"]);
    // The new build's load may still load itself again on a failed chunk.
    expect(window.sessionStorage.getItem(FRESH_LOAD)).toBeNull();
  });

  it("never switches a tab still in sight: the window behind another, or a long read with no key or pointer", async () => {
    const p = open("index-1.js");
    await deploy(p, "index-2.js");
    p.blur();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(p.went).toEqual([]);
    p.hide();
    expect(p.went).toHaveLength(1);
  });

  it("never switches offline: the new build's page couldn't load", async () => {
    const p = open("index-1.js");
    await deploy(p, "index-2.js");
    p.offline(true);
    p.hide();
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(p.went).toEqual([]);
    p.offline(false);
    await settle();
    expect(p.went).toHaveLength(1);
  });

  it("switches on the person's next move to another screen", async () => {
    const p = open("index-1.js");
    await deploy(p, "index-2.js");
    at.href = "https://app.fleetd.dev/?team=t1#/project/a/c";
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(p.went).toEqual(["https://app.fleetd.dev/?team=t1&fresh=1#/project/a/c"]);
  });

  it("learns of it as the person comes back, without waiting for the next ask", async () => {
    const p = open("index-1.js");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    p.cloud.current = "index-2.js";
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(p.cloud.asked).toBe(2);
    expect(p.went).toEqual([]);
    p.hide();
    expect(p.went).toHaveLength(1);
    expect(p.cloud.asked).toBe(2);
  });

  it("never reloads while a field holds words typed in this load, and does once they're sent or the screen is left", async () => {
    const p = open("index-1.js");
    const box = document.createElement("textarea");
    document.body.append(box);
    box.value = "half a sente";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await deploy(p, "index-2.js");
    p.hide();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(p.went).toEqual([]);
    // Sent: the box is empty again.
    box.value = "";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.went).toHaveLength(1);
  });

  it("counts a field gone with its screen no more", async () => {
    const p = open("index-1.js");
    const name = document.createElement("input");
    document.body.append(name);
    name.value = "acme";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await deploy(p, "index-2.js");
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(p.went).toEqual([]);
    name.remove();
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(p.went).toHaveLength(1);
  });

  it("an empty box the screen focused, or a ticked box, holds nothing", async () => {
    const p = open("index-1.js");
    const box = document.createElement("textarea");
    const tick = document.createElement("input");
    tick.type = "checkbox";
    document.body.append(box, tick);
    box.focus();
    tick.dispatchEvent(new Event("input", { bubbles: true }));
    await deploy(p, "index-2.js");
    p.hide();
    expect(p.went).toHaveLength(1);
  });

  it("waits out an open dialog and a draft's files", async () => {
    let files = true;
    const p = open("index-1.js", { holding: () => files });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await deploy(p, "index-2.js");
    p.hide();
    expect(p.went).toEqual([]);
    dialog.remove();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.went).toEqual([]);
    files = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.went).toHaveLength(1);
  });

  it("asks again later when the cloud can't be reached", async () => {
    const p = open("index-1.js");
    p.cloud.down = true;
    p.cloud.current = "index-2.js";
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    p.hide();
    expect(p.went).toEqual([]);
    p.cloud.down = false;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(p.went).toHaveLength(1);
  });
});
