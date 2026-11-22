// W813: the sidebar's swipe, recorded on a real Mac for its clips and numbers. A trackpad's phased scrolls posted as
// CGEvents (qa/swipe/scroll.swift) at the real app, as swipe.spec.ts does, each scene recorded twice over: every frame
// the page drew (its time and where the list stood), every wheel event it got, and the window's own frames (CDP
// screencast). Written to qa-results/clip/<scene>/; scripts/swipe-clip.py turns them into GIFs and frame timings.
// Not a check: `pnpm exec playwright test -c qa/playwright.config.ts --project=swipe-clip` on a Mac, alone on its screen.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { FINGERS, MOMENTUM, type Scroll } from "../src/renderer/screens/shell/hubSwipe.samples.ts";
import { launch, resultsDir, setNativeView, settle, show } from "./harness.ts";

type Clip = Window & { __frames?: number[][]; __wheels?: number[][]; __longs?: number[][] };

const step = (dx: number, phase: number, momentum: number, wait = 16): Scroll => ({ dx, dy: 0, phase, momentum, wait });
/** Fingers down, moving `deltas` sideways (+ toward the next hub), then up. */
const fingers = (deltas: readonly number[]): Scroll[] => [
  step(0, FINGERS.mayBegin, MOMENTUM.none),
  ...deltas.map((d, i) => step(d, i === 0 ? FINGERS.began : FINGERS.changed, MOMENTUM.none)),
  step(0, FINGERS.ended, MOMENTUM.none, 0),
];
/** macOS's glide after a lift moving `from` px a frame: each frame 0.95 of the one before. */
const glide = (from: number): Scroll[] => {
  const out: Scroll[] = [];
  for (let v = from, i = 0; Math.abs(v) >= 0.5; v *= 0.95, i++) out.push(step(Math.round(v), FINGERS.none, i === 0 ? MOMENTUM.begin : MOMENTUM.continue));
  return [...out, step(0, FINGERS.none, MOMENTUM.end)];
};
const flip = (s: Scroll[]): Scroll[] => s.map((e) => ({ ...e, dx: -e.dx }));
/** A quick swipe on (+1) or back (-1), lifted moving, its glide after it. */
const flick = (side: 1 | -1): Scroll[] => {
  const s = [...fingers([3, 6, 10, 14, 17, 18, 17, 15, 13]), ...glide(13)];
  return side > 0 ? s : flip(s);
};
/** A slow, deliberate swipe that stops before the fingers lift: no glide at all. */
const drag = (side: 1 | -1): Scroll[] => {
  const s = fingers([1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 7, 7, 6, 6, 6, 5, 5, 4, 4, 3, 2, 2, 1, 1]);
  return side > 0 ? s : flip(s);
};

/** Each scene: the hub it starts on, and what the fingers do. */
const scenes: ReadonlyArray<{ name: string; from: number; scrolls: Scroll[] }> = [
  { name: "next-flick", from: 0, scrolls: flick(1) },
  { name: "back-flick", from: 1, scrolls: flick(-1) },
  { name: "next-drag", from: 0, scrolls: drag(1) },
  { name: "back-drag", from: 1, scrolls: drag(-1) },
  { name: "edge-first-flick", from: 0, scrolls: flick(-1) },
  { name: "edge-first-drag", from: 0, scrolls: drag(-1) },
  { name: "edge-last-flick", from: 2, scrolls: flick(1) },
  { name: "edge-last-drag", from: 2, scrolls: drag(1) },
];

test("records the sidebar's swipe on a Mac trackpad, both ways and at both ends", async () => {
  test.skip(process.platform !== "darwin", "macOS only: it posts CGEvents");
  test.setTimeout(300_000);
  const t0 = Date.now();
  const log = (what: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
  const dir = mkdtempSync(path.join(tmpdir(), "fleetd-clip-"));
  const poster = path.join(dir, "scroll");
  execFileSync("swiftc", ["-O", path.join(import.meta.dirname, "swipe", "scroll.swift"), "-o", poster]);
  log("poster built");
  const { app, page, close } = await launch("sidebar-many-hubs", undefined, { realClock: true });
  try {
    await setNativeView(app, page, "window", "dark");
    await show(page, "shell", "#/");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await settle(page);
    await app.evaluate(({ app: electron, BrowserWindow }) => {
      electron.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.moveTop();
    });
    const marks = page.locator("[role='group'][aria-label='Hubs'] button");
    const at = () => page.evaluate(() => [...document.querySelectorAll("[role='group'][aria-label='Hubs'] button")].findIndex((b) => b.hasAttribute("aria-current")));
    const still = () => expect.poll(() => page.evaluate(() => document.querySelector("nav[aria-label='Sidebar'] [data-moving]") === null), { timeout: 5_000 }).toBe(true);
    const box = await page.locator("nav[aria-label='Sidebar'] [data-reorder-row]").nth(3).boundingBox();
    const side = await page.locator("nav[aria-label='Sidebar']").boundingBox();
    if (box === null || side === null) throw new Error("no sidebar");
    const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    if (content === undefined) throw new Error("no window");
    const x = Math.round(content.x + box.x + box.width / 2);
    const y = Math.round(content.y + box.y + box.height / 2);
    log("app up");
    const cdp = await page.context().newCDPSession(page);
    const support = await page.evaluate(() => ({ momentum: "momentum" in WheelEvent.prototype, ua: navigator.userAgent }));
    for (const scene of scenes) {
      if ((await at()) !== scene.from) {
        await marks.nth(scene.from).click();
        await still();
      }
      log(`${scene.name}: on hub ${String(scene.from)}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(300);
      // Every frame from here: its time, where the list and the hub beside it stand, and whether it moves.
      await page.evaluate(() => {
        const w = window as Clip;
        w.__frames = [];
        w.__wheels = [];
        w.__longs = [];
        const num = (el: Element | null | undefined) => {
          const m = /translate3d\((-?[\d.]+)px/.exec((el as HTMLElement | null)?.style.transform ?? "");
          return m === null ? 0 : Number(m[1]);
        };
        // Read once the frame's callbacks (the swipe's own spring among them) have run, as it is drawn.
        const tick = (now: number) => {
          setTimeout(() => {
            const lists = document.querySelectorAll("nav[aria-label='Sidebar'] [class*='list']");
            const moving = document.querySelector("nav[aria-label='Sidebar'] [data-moving]") !== null;
            w.__frames?.push([now, num(lists[0]), lists.length > 1 ? num(lists[1]) : NaN, moving ? 1 : 0, w.__wheels?.length ?? 0]);
          }, 0);
          if (w.__frames !== undefined) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        if ((w as Window & { __listening?: boolean }).__listening === true) return;
        (w as Window & { __listening?: boolean }).__listening = true;
        document.addEventListener(
          "wheel",
          (e) => w.__wheels?.push([e.timeStamp, performance.now(), e.deltaX, e.deltaY, e.cancelable ? 1 : 0, (e as WheelEvent & { momentum?: boolean }).momentum === true ? 1 : 0]),
          { capture: true, passive: true },
        );
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__longs?.push([entry.startTime, entry.duration]);
        }).observe({ type: "long-animation-frame", buffered: false });
      });
      const out = path.join(resultsDir, "clip", scene.name);
      mkdirSync(out, { recursive: true });
      const shots: Array<{ t: number; file: string }> = [];
      const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        const file = `f${String(shots.length).padStart(4, "0")}.jpg`;
        writeFileSync(path.join(out, file), Buffer.from(f.data, "base64"));
        shots.push({ t: f.metadata.timestamp ?? 0, file });
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      };
      cdp.on("Page.screencastFrame", onFrame);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
      await page.waitForTimeout(250);
      const steps = path.join(dir, `${scene.name}.json`);
      writeFileSync(steps, JSON.stringify(scene.scrolls));
      log(`${scene.name}: recording`);
      const posted = Date.now();
      execFileSync(poster, [String(x), String(y), steps]);
      log(`${scene.name}: posted`);
      await still();
      await page.waitForTimeout(500);
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", onFrame);
      const got = await page.evaluate(() => {
        const w = window as Clip;
        const r = { frames: w.__frames ?? [], wheels: w.__wheels ?? [], longs: w.__longs ?? [], origin: performance.timeOrigin };
        delete w.__frames;
        return r;
      });
      writeFileSync(
        path.join(out, "clip.json"),
        JSON.stringify({ scene: scene.name, from: scene.from, to: await at(), posted, support, scale: 2, sidebar: side, scrolls: scene.scrolls, ...got, shots }),
      );
      console.log(`${scene.name}: ${String(got.frames.length)} frames, ${String(got.wheels.length)} wheels, ${String(shots.length)} shots, hub ${String(scene.from)} -> ${String(await at())}`);
    }
  } finally {
    await close();
  }
});
