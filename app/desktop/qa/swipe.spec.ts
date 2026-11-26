// W777: the sidebar's swipe between hubs on a Mac's own input path. A trackpad's scrolls (hubSwipe.samples.ts) posted
// as CGEvents with their scroll and momentum phases (qa/swipe/scroll.swift) at a row of the real app's list, the
// pointer put there once and never moved: through the window server, AppKit and Chromium as a trackpad's are, which
// is what tells the page where each touch begins. A swipe, one back and one on while the last one's glide still
// arrives, a long glide and momentum on its own, scrolls up and across the list; then a press during a slide.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { fingers, momentum, scrollDown, swipe, swipeFingers, type Scroll } from "../src/renderer/screens/shell/hubSwipe.samples.ts";
import { launch, resultsDir, setNativeView, settle, show } from "./harness.ts";

type Recorded = Window & { __hubs?: number[]; __wheels?: number[][] };

const dir = mkdtempSync(path.join(tmpdir(), "fleetd-swipe-"));
let compiled: string | undefined;
/** qa/swipe/scroll.swift, built once. */
const posterBin = (): string => {
  if (compiled !== undefined) return compiled;
  const bin = path.join(dir, "scroll");
  execFileSync("swiftc", ["-O", path.join(import.meta.dirname, "swipe", "scroll.swift"), "-o", bin]);
  compiled = bin;
  return bin;
};

test("a Mac trackpad's swipes over the sidebar switch one hub each, back and on at once, the pointer never moving", async () => {
  test.skip(process.platform !== "darwin", "macOS only: it posts CGEvents");
  const poster = posterBin();
  // A real clock: the swipe reads its events' times, which a fixture's fixed one would stop.
  const { app, page, close } = await launch("sidebar-many-hubs", undefined, { realClock: true });
  try {
    await setNativeView(app, page, "window", "light");
    await show(page, "shell", "#/");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await settle(page);
    await app.evaluate(({ app: electron, BrowserWindow }) => {
      electron.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.moveTop();
    });
    // Every hub the sidebar shows, in turn, by its place among the marks.
    await page.evaluate(() => {
      const w = window as Recorded;
      const on = () => [...document.querySelectorAll("[role='group'][aria-label='Workspaces'] button")].findIndex((b) => b.hasAttribute("aria-current"));
      let last = on();
      w.__hubs = [last];
      new MutationObserver(() => {
        const now = on();
        if (now === last) return;
        last = now;
        w.__hubs?.push(now);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
      // And every wheel event the page gets (when it came, deltas, cancelable, its own time), for a failure's message:
      // replayed through hubSwipe.ts wheel, they say what the gesture made of them.
      w.__wheels = [];
      document.addEventListener("wheel", (e) => w.__wheels?.push([Date.now(), e.deltaX, e.deltaY, e.cancelable ? 1 : 0, Math.round(e.timeStamp)]), { capture: true, passive: true });
    });
    // What main's input-event says of the same scrolls (Electron gives a gesture's type and nothing more): whether
    // Chromium's gesture scroll begin and end, and fling, mark a trackpad's touches. Written down beside the page's
    // events (qa-results/swipe-events.jsonl), and counted per step in the log.
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __input?: Array<[number, string]> };
      g.__input = [];
      BrowserWindow.getAllWindows()[0]?.webContents.on("input-event", (_e, ev) => {
        if (ev.type.startsWith("gesture") || ev.type === "mouseWheel") g.__input?.push([Date.now(), ev.type]);
      });
    });
    mkdirSync(resultsDir, { recursive: true });
    const events = path.join(resultsDir, "swipe-events.jsonl");
    const list = page.locator("nav[aria-label='Sidebar'] [class*='list']").first();
    const box = await page.locator("nav[aria-label='Sidebar'] [data-reorder-row]").nth(4).boundingBox();
    if (box === null) throw new Error("no row to swipe over");
    const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    if (content === undefined) throw new Error("no window");
    const x = Math.round(content.x + box.x + box.width / 2);
    const y = Math.round(content.y + box.y + box.height / 2);
    const steps = path.join(dir, "steps.json");
    /**
     * Posts `scrolls` as the trackpad would, in its own time; then, once the list is still, the hubs shown since and the
     * wheel events the page got.
     */
    const post = async (scrolls: readonly Scroll[]): Promise<{ hubs: number[]; wheels: string }> => {
      writeFileSync(steps, JSON.stringify(scrolls));
      execFileSync(poster, [String(x), String(y), steps]);
      await expect.poll(() => page.evaluate(() => document.querySelector("nav[aria-label='Sidebar'] [data-moving]") === null), { timeout: 5_000 }).toBe(true);
      await page.waitForTimeout(150);
      // The record since the last call, the hub it started on first, which stays to start the next one's.
      const got = await page.evaluate(() => {
        const w = window as Recorded;
        const hubs = w.__hubs ?? [];
        const since = hubs.splice(0, hubs.length - 1);
        return { hubs: [...since, ...hubs].slice(1), wheels: JSON.stringify(w.__wheels?.splice(0) ?? []) };
      });
      const input = await app.evaluate(() => (globalThis as { __input?: Array<[number, string]> }).__input?.splice(0) ?? []);
      const count = (type: string) => input.filter(([, t]) => t === type).length;
      const touches = scrolls.filter((s) => s.phase === 1).length;
      const lifts = scrolls.filter((s) => s.phase === 4).length;
      const glides = scrolls.filter((s) => s.momentum === 1).length;
      console.log(
        `swipe events: ${String(touches)} touches, ${String(lifts)} lifts, ${String(glides)} glides posted; input-event: ${String(count("gestureScrollBegin"))} gestureScrollBegin, ${String(count("gestureScrollEnd"))} gestureScrollEnd, ${String(count("gestureFlingStart"))} gestureFlingStart, ${String(count("gestureFlingCancel"))} gestureFlingCancel, ${String(count("mouseWheel"))} mouseWheel; the page: ${String((JSON.parse(got.wheels) as unknown[]).length)} wheel events`,
      );
      appendFileSync(events, `${JSON.stringify({ posted: scrolls, input, wheels: JSON.parse(got.wheels) as unknown })}\n`);
      return got;
    };
    /** Posts `scrolls`, and checks the hubs it showed, in turn. */
    const play = async (scrolls: readonly Scroll[], hubs: number[]) => {
      const got = await post(scrolls);
      expect.soft(got.hubs, `the workspaces shown; the page's wheel events [ms, dx, dy, cancelable, its own ms]: ${got.wheels}`).toEqual(hubs);
    };
    const at = () => page.evaluate(() => [...document.querySelectorAll("[role='group'][aria-label='Workspaces'] button")].findIndex((b) => b.hasAttribute("aria-current")));

    expect(await at()).toBe(0);
    await test.step("a swipe switches one hub", async () => {
      await play(swipe(1), [1]);
    });
    await test.step("a swipe back while its glide still arrives switches back at once", async () => {
      await play([...swipe(1, 30), ...swipe(-1)], [2, 1]);
    });
    await test.step("a swipe on while its glide still arrives switches on at once", async () => {
      await play(swipe(-1, 30), [0]);
      await play([...swipe(1, 30), ...swipe(1)], [1, 2]);
    });
    await test.step("a long glide switches no second hub, and momentum on its own none", async () => {
      await play([...swipeFingers(-1), ...momentum([-30, 0], { decay: 0.97 })], [1]);
      await play(momentum([-20, 0], { decay: 0.97 }), []);
    });
    await test.step("a scroll down or across the list scrolls it and never switches, one started mid-glide included", async () => {
      const top = () => list.evaluate((el) => el.scrollTop);
      for (const scroll of [scrollDown(), [...fingers([[2, 2], [5, 4], [9, 8], [12, 11], [10, 10], [6, 6]]), ...momentum([5, 5])]]) {
        await list.evaluate((el) => (el.scrollTop = 0));
        await play(scroll, []);
        // It scrolled (as far as the list goes: a short hub's only so far).
        expect(await top()).toBeGreaterThan(0);
      }
      // Onto Personal, then back to Acme, whose list scrolls, with a scroll down straight after: while its glide still
      // arrives, and while its slide still settles.
      const range = () => list.evaluate((el) => el.scrollHeight - el.clientHeight);
      for (const count of [30, 4]) {
        await play(swipe(-1), [0]);
        await play([...swipe(1, count), ...scrollDown()], [1]);
        expect(await top(), `the list's scroll after a swipe and ${String(count)} of its glide's events (it scrolls ${String(await range())} px)`).toBeGreaterThan(0);
      }
    });
    await test.step("a press while a slide settles lands it, and goes to the row under it", async () => {
      await list.evaluate((el) => (el.scrollTop = 0));
      const before = await page.evaluate(() => window.location.hash);
      await page.locator("[role='group'][aria-label='Workspaces'] button").nth(1).click();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5_000 }).not.toBe(before);
      expect(await at()).toBe(1);
    });
    await settle(page);
  } finally {
    await close();
  }
});

// The web app takes where a touch begins from the same word in Chromium on a Mac (hubSwipe.ts phased): Chromium itself,
// as a browser, marks a touch's first wheel event the only cancelable one, and says it is Chromium on macOS.
test("Chromium as a browser on a Mac marks a trackpad touch's first wheel event, and only that one, cancelable", async () => {
  test.skip(process.platform !== "darwin", "macOS only: it posts CGEvents");
  const poster = posterBin();
  const browser = await chromium.launch({ headless: false, args: ["--window-position=40,40", "--window-size=900,700"] });
  try {
    const page = await browser.newPage();
    // An https page, as the web app is: the browser's word on what it is (userAgentData) is for secure pages only.
    await page.route("https://swipe.test/", (route) => route.fulfill({ contentType: "text/html", body: `<div id="list" style="height:100vh;overflow:auto"><div style="height:4000px"></div></div>` }));
    await page.goto("https://swipe.test/");
    await page.evaluate(() => {
      const w = window as Window & { __wheels?: number[][] };
      w.__wheels = [];
      document.getElementById("list")?.addEventListener("wheel", (e) => w.__wheels?.push([e.deltaX, e.cancelable ? 1 : 0]), { passive: false });
    });
    await page.bringToFront();
    const at = await page.evaluate(() => [Math.round(window.screenX + 300), Math.round(window.screenY + window.outerHeight - window.innerHeight + 300)]);
    const steps = path.join(dir, "browser-steps.json");
    const post = async (scrolls: readonly Scroll[]) => {
      writeFileSync(steps, JSON.stringify(scrolls));
      execFileSync(poster, [String(at[0]), String(at[1]), steps]);
      await page.waitForTimeout(300);
    };
    // A first touch brings the window forward, and its first events go to that: then the two that count, the second
    // while the first one's glide still arrives.
    await post(scrollDown());
    await page.evaluate(() => ((window as Window & { __wheels?: number[][] }).__wheels = []));
    await post([...swipe(1, 12), ...swipe(-1, 12)]);
    const wheels = await page.evaluate(() => (window as Window & { __wheels?: number[][] }).__wheels ?? []);
    const firsts = wheels.flatMap(([dx, c], i) => (c === 1 ? [[i, dx]] : []));
    expect(firsts, `the cancelable ones among the page's wheel events [dx, cancelable]: ${JSON.stringify(wheels)}`).toEqual([
      [0, 2],
      [wheels.findIndex(([dx]) => (dx ?? 0) < 0), -2],
    ]);
    const ua = await page.evaluate(() => {
      const data = (navigator as Navigator & { userAgentData?: { platform: string; brands: ReadonlyArray<{ brand: string }> } }).userAgentData;
      return { platform: data?.platform, chromium: data?.brands.some((b) => b.brand === "Chromium") ?? false };
    });
    expect(ua).toEqual({ platform: "macOS", chromium: true });
  } finally {
    await browser.close();
  }
});
