// Opening and closing the sidebar and the panel, on the real chat (the chat-long fixture): `pnpm perf:toggles` after
// `pnpm build:test`. Each toggle is clicked through Chromium's input pipeline, then for 400 ms it records the frames
// (rAF timestamps), the renderer's main thread (Chromium's trace) and each time the chat's log changed width. A frame
// counts as dropped past 1.5 refresh intervals. The toggle's own frame lays the window out once; a layout in a later
// frame of the motion, or the chat changing width after the click's frame, is the window reflowing mid-way.
//
//   --strip DIR   also write each toggle's frames (Chromium's screencast), each named by its time from the click
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import { devtoolsPort, launch, openChat, sleep } from "./app.ts";
import { frameStats, median } from "./budgets.ts";

const { values: flags } = parseArgs({ options: { strip: { type: "string" } } });
const ROUNDS = 10;
const WINDOW_MS = 400;
/** How long each motion runs (layout.module.css): past it a layout is its end (a side leaving the page), not mid-way. */
const MOTION_MS = { open: 180, close: 120 } as const;

interface Ev {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly args?: { readonly data?: { readonly type?: string } };
}

interface Round {
  readonly fps: number;
  readonly dropped: number;
  readonly longestMs: number;
  /** Layouts in the frames after the click's, while it moves (MOTION_MS). */
  readonly lateLayouts: number;
  /** Times the chat changed width. */
  readonly resizes: number;
  /** From the click to the chat's last change of width, ms. */
  readonly resizedAtMs: number;
  /** The click's own task, ms: the render that opens or closes it. */
  readonly clickMs: number;
  readonly mainMs: number;
}

const TOGGLES = [
  { name: "sidebar close", button: "Hide the sidebar" },
  { name: "sidebar open", button: "Show the sidebar" },
  { name: "panel close", button: "Hide the panel" },
  { name: "panel open", button: "Show the panel" },
] as const;

/** One toggle: its frames, the renderer's layouts and long tasks, and the chat log's widths, over WINDOW_MS. */
const once = async (browser: Browser, page: Page, button: string): Promise<Round> => {
  const cdp = await browser.newBrowserCDPSession();
  const events: Array<Ev> = [];
  cdp.on("Tracing.dataCollected", (data) => events.push(...(data.value as unknown as Array<Ev>)));
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] } });
  await page.evaluate((ms) => {
    const w = window as unknown as { __frames: Array<number>; __resized: Array<number>; __clicked: number };
    w.__frames = [];
    w.__resized = [];
    w.__clicked = 0;
    window.addEventListener("click", () => (w.__clicked = performance.now()), { capture: true, once: true });
    const log = document.querySelector('[aria-label="Conversation with the lead"]');
    let first = true;
    // Its first call is the width it has now; each after it is a change.
    const ro = new ResizeObserver(() => {
      if (!first) w.__resized.push(performance.now());
      first = false;
    });
    if (log !== null) ro.observe(log);
    const start = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t);
      if (t - start < ms) requestAnimationFrame(tick);
      else ro.disconnect();
    };
    requestAnimationFrame(tick);
  }, WINDOW_MS);
  const clickedAt = Date.now();
  await page.getByRole("button", { name: button, exact: true }).click();
  await sleep(Math.max(0, WINDOW_MS + 150 - (Date.now() - clickedAt)));
  const { frames, resized, clicked } = await page.evaluate(() => {
    const w = window as unknown as { __frames: Array<number>; __resized: Array<number>; __clicked: number };
    return { frames: w.__frames, resized: w.__resized, clicked: w.__clicked };
  });
  await cdp.send("Tracing.end");
  await complete;
  await cdp.detach();

  // The app window's renderer main thread: the one that ran the click.
  const click = events.find((e) => e.name === "EventDispatch" && e.ph === "X" && e.args?.data?.type === "click");
  if (click === undefined) throw new Error("no click in the trace");
  const main = events.filter((e) => e.pid === click.pid && e.tid === click.tid && e.ph === "X");
  const from = click.ts;
  const inWindow = main.filter((e) => e.ts >= from && e.ts < from + WINDOW_MS * 1000);
  // The click's frame ends at its first commit; a layout in a frame after it, while the side moves, is mid-way.
  const firstFrameEnd = inWindow.find((e) => e.name === "Commit" && e.ts > from + (click.dur ?? 0))?.ts ?? from;
  const motionMs = button.startsWith("Show") ? MOTION_MS.open : MOTION_MS.close;
  const late = inWindow.filter((e) => e.name === "Layout" && e.ts > firstFrameEnd && e.ts < firstFrameEnd + motionMs * 1000);
  const tasks = inWindow.filter((e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask");
  const stats = frameStats(frames, 1000 / 60);
  let longest = 0;
  for (let i = 1; i < frames.length; i++) longest = Math.max(longest, (frames[i] ?? 0) - (frames[i - 1] ?? 0));
  return {
    ...stats,
    longestMs: longest,
    lateLayouts: late.length,
    resizes: resized.length,
    resizedAtMs: Math.max(0, ...resized.map((t) => t - clicked)),
    clickMs: (click.dur ?? 0) / 1000,
    mainMs: tasks.reduce((n, e) => n + (e.dur ?? 0), 0) / 1000,
  };
};

/** A strip of one toggle at its real speed: the frames Chromium's screencast hands over, each named by its time from
 * the click. */
const strip = async (page: Page, button: string, dir: string, name: string) => {
  const cdp = await page.context().newCDPSession(page);
  const shots: Array<{ at: number; data: string }> = [];
  let start = 0;
  cdp.on("Page.screencastFrame", (f) => {
    // Its swap time, not its arrival: encoding it takes a while.
    const swapped = f.metadata.timestamp === undefined ? Date.now() : f.metadata.timestamp * 1000;
    if (start > 0 && swapped >= start) shots.push({ at: Math.round(swapped - start), data: f.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await sleep(200);
  start = Date.now();
  await page.getByRole("button", { name: button, exact: true }).click();
  await sleep(MOTION_MS.open + 200);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  for (const { at, data } of shots) writeFileSync(path.join(dir, `${name.replace(" ", "-")}-${String(at).padStart(3, "0")}ms.png`), Buffer.from(data, "base64"));
};

const app = launch({ debug: true });
try {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${await devtoolsPort(app)}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname.endsWith("/index.html"));
  if (page === undefined) throw new Error("no app window over CDP");
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChat(page);
  await sleep(1500);
  const results = new Map<string, Array<Round>>(TOGGLES.map((t) => [t.name, []]));
  // One untimed round first: the panel's chunk loads with its first opening.
  for (let r = 0; r <= ROUNDS; r++) {
    for (const t of TOGGLES) {
      const round = await once(browser, page, t.button);
      if (r > 0) results.get(t.name)?.push(round);
      await sleep(300);
    }
  }
  for (const [name, rounds] of results) {
    const m = (k: keyof Round) => median(rounds.map((x) => x[k]));
    const worst = (k: keyof Round) => Math.max(...rounds.map((x) => x[k]));
    console.log(
      `${name.padEnd(14)} dropped ${(m("dropped") * 100).toFixed(1)}% (worst ${(worst("dropped") * 100).toFixed(1)}%)  longest frame ${m("longestMs").toFixed(1)} ms (worst ${worst("longestMs").toFixed(1)})  click ${m("clickMs").toFixed(1)} ms  layouts mid-way ${m("lateLayouts")} (worst ${worst("lateLayouts")})  chat resized ${m("resizes")}x, at +${m("resizedAtMs").toFixed(0)} ms (worst +${worst("resizedAtMs").toFixed(0)})  main thread ${m("mainMs").toFixed(1)} ms`,
    );
  }
  if (flags.strip !== undefined) {
    mkdirSync(flags.strip, { recursive: true });
    for (const t of TOGGLES) {
      await strip(page, t.button, flags.strip, t.name);
      await sleep(500);
    }
  }
  await browser.close();
} finally {
  await app.stop();
}
