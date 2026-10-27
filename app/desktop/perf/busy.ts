// The cost of the looping state marks (ui/DESIGN.md) with many agents at work, and whether they keep moving while you
// type and click: `pnpm perf:busy` after `pnpm build:test`. The live-20 fixture puts 20 agents to work, so the chat's
// strip and the panel's Agents list are full of working and thinking glyphs, with the dither scan over their words.
// Measured with all of it on screen:
//
//   animations      the page's running CSS animations (document.getAnimations)
//   CPU             the app's whole process tree over 10 s idle, % of one core (Linux: /proc/<pid>/stat)
//   frames          requestAnimationFrame rate and long frames over 5 s idle, and long frames while typing and clicking
//   keypress p95    Chromium's EventLatency per key press into the composer, as `pnpm perf` reads it
//   beat            the loops' steps while you type (a key every 150 ms, a person's pace) and click (round the panel's
//                   tabs, the palette open and shut): the share of the beats that fell due that stepped, and the p95
//                   time between two steps
//   renders/key     React components rendered per key into the composer, read from React's DevTools hook
//
// Exits 1 when the beat slows or stutters while you type or click, frames drop while you type, or a key renders more
// than the composer: the BUDGET below.
//
//   --entry FILE    measure another build (another checkout's out/main/index.js) the same way, for a before/after
//   --runs N        launches to take the median of (default 3)
//   --fixture NAME  another fixture (default live-20), and --route HASH another screen of it (default its Agents);
//                   chat-long with its chat (--route chat) is what `pnpm perf` types into, for a like-for-like check
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import { devtoolsPort, launch, sleep } from "./app.ts";
import { frameStats, median, quantile } from "./budgets.ts";
import { parsePs, tree } from "./memory.ts";
import { keyLatencies, traced, type TraceEvent } from "./trace.ts";

const { values: flags } = parseArgs({ options: { entry: { type: "string" }, runs: { type: "string" }, fixture: { type: "string" }, route: { type: "string" } } });
const RUNS = Number(flags.runs ?? "3");
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const FIXTURE = flags.fixture ?? "live-20";
const ROUTE = flags.route === "chat" ? CHAT : (flags.route ?? `${CHAT}/agents`);
/** ui/lib/beat's step. */
const BEAT_MS = 120;
const KEYS = "the writer ran the tests again and asked for a review. ".repeat(2).trim();
/** A person's pace, slower than a beat: a beat that waited for your next key would show here. */
const KEY_DELAY_MS = 150;

/** What the exit code holds the medians to. */
const BUDGET = {
  /** Of the beats that fell due while typing or clicking, the share that stepped. */
  stepped: 0.9,
  /** p95 time between two steps while typing or clicking, ms: a beat and a half. */
  stepP95Ms: BEAT_MS * 1.5,
  /** Long frames (over 1.5 refresh intervals) while typing, %. */
  longTyping: 2,
  /** React components rendered per key: the composer and its words, never the chat or the panel. */
  rendersPerKey: 3,
};

/**
 * Counts React's component renders from its DevTools hook, which React calls after each commit: a component that
 * mounted or did work (its PerformedWork flag), skipping the subtrees whose children React kept. The DOM tests count
 * them the same way (src/renderer/ui/lib/renders.test-util.ts).
 */
const RENDER_HOOK = `(() => {
  const counter = { renders: 0 };
  window.__perfRenders = counter;
  const walk = (first) => {
    const stack = [first];
    while (stack.length > 0)
      for (let f = stack.pop(); f; f = f.sibling) {
        if ([0, 1, 11, 14, 15].includes(f.tag) && (f.alternate === null || (f.flags & 1) !== 0)) counter.renders += 1;
        if (f.child && (f.alternate === null || f.child !== f.alternate.child)) stack.push(f.child);
      }
  };
  let ids = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject: () => ++ids, checkDCE() {}, onScheduleFiberRoot() {},
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onCommitFiberRoot: (_id, root) => walk(root.current.child),
  };
})();`;

/** CPU seconds the process tree under `root` has used so far (utime + stime, Linux). */
const cpuSeconds = (root: number): number => {
  const procs = tree(parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8" })), root);
  const hz = 100;
  let ticks = 0;
  for (const p of procs) {
    try {
      // Fields after the command's closing paren: state is the 1st, utime the 12th, stime the 13th.
      const rest = readFileSync(`/proc/${p.pid}/stat`, "utf8").split(") ").pop()?.split(" ") ?? [];
      ticks += Number(rest[11] ?? 0) + Number(rest[12] ?? 0);
    } catch {
      // Gone between ps and the read: it used nothing more.
    }
  }
  return ticks / hz;
};

const rafStamps = async (page: Page, ms: number): Promise<number[]> =>
  page.evaluate(
    (span) =>
      new Promise<number[]>((done) => {
        const stamps: number[] = [];
        const end = performance.now() + span;
        const tick = (t: number) => {
          stamps.push(t);
          if (t < end) requestAnimationFrame(tick);
          else done(stamps);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

interface Watched {
  /** Long frames, %. */
  readonly long: number;
  /** Steps over the beats that fell due, at most 1. */
  readonly stepped: number;
  /** p95 ms between two steps. */
  readonly stepP95: number;
}

type Watch = { frames: number[]; steps: number[]; run: boolean; observer: MutationObserver };

/** Frames and the beat's steps while `during` runs. A step is one batch of the loops' writes (data-lit, data-step). */
const watch = async (page: Page, refreshMs: number, during: () => Promise<unknown>): Promise<Watched> => {
  await page.evaluate(() => {
    const watched: Watch = { frames: [], steps: [], run: true, observer: new MutationObserver(() => watched.steps.push(performance.now())) };
    (window as { perfWatch?: Watch }).perfWatch = watched;
    watched.observer.observe(document.documentElement, { subtree: true, attributeFilter: ["data-lit", "data-step"] });
    const tick = (t: number) => {
      watched.frames.push(t);
      if (watched.run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const start = performance.now();
  await during();
  const due = Math.floor((performance.now() - start) / BEAT_MS);
  const { frames, steps } = await page.evaluate(() => {
    const watched = (window as { perfWatch?: Watch }).perfWatch;
    if (watched === undefined) throw new Error("not watching");
    watched.run = false;
    watched.observer.disconnect();
    return { frames: watched.frames, steps: watched.steps };
  });
  const gaps = steps.slice(1).map((t, i) => t - (steps[i] ?? t));
  return { long: frameStats(frames, refreshMs).dropped * 100, stepped: Math.min(steps.length / due, 1), stepP95: quantile(gaps, 0.95) };
};

/** Round the panel's tabs and the palette open and shut, twice. */
const clickAround = async (page: Page) => {
  for (let i = 0; i < 2; i++) {
    for (const tab of ["Shipping", "Plan", "History", "Agents"]) {
      await page.getByRole("tab", { name: new RegExp(tab, "u") }).click();
      await sleep(300);
    }
    await page.keyboard.press("Control+k");
    await sleep(400);
    await page.keyboard.press("Escape");
    await sleep(300);
  }
};

interface Run {
  readonly animations: number;
  readonly cpu: number;
  readonly fps: number;
  readonly longFrames: number;
  readonly keyP95: number;
  readonly keyP50: number;
  readonly keys: number;
  readonly typing: Watched;
  readonly clicking: Watched;
  readonly rendersPerKey: number;
}

const once = async (): Promise<Run> => {
  const app = launch({ debug: true, env: { FLEETD_FIXTURE: FIXTURE }, ...(flags.entry === undefined ? {} : { entry: flags.entry }) });
  try {
    const port = await devtoolsPort(app);
    await app.waitFor(/^FLEETD_PERF launch /u, 30_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname.endsWith("/index.html"));
      if (page === undefined) throw new Error("no app window over CDP");
      // Loaded again with the hook in place, which React looks for as it starts.
      await page.context().addInitScript(RENDER_HOOK);
      await page.evaluate((hash) => (window.location.hash = hash), ROUTE);
      await page.reload();
      await page.getByLabel("Message the lead").waitFor({ state: "visible", timeout: 30_000 });
      await sleep(3000);
      const animations = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      const pid = app.child.pid ?? -1;
      const before = cpuSeconds(pid);
      await sleep(10_000);
      const cpu = ((cpuSeconds(pid) - before) / 10) * 100;
      const idle = await rafStamps(page, 1000);
      const refreshMs = quantile(idle.slice(1).map((t, i) => t - (idle[i] ?? t)), 0.5);
      const frames = frameStats(await rafStamps(page, 5000), refreshMs);
      const composer = page.getByLabel("Message the lead");
      await composer.click();
      const rendered = () => page.evaluate(() => (window as { __perfRenders?: { renders: number } }).__perfRenders?.renders ?? Number.NaN);
      const renderedBefore = await rendered();
      let events: TraceEvent[] = [];
      const typing = await watch(page, refreshMs, async () => {
        events = await traced(browser, async () => {
          await page.keyboard.type(KEYS, { delay: KEY_DELAY_MS });
          await sleep(500);
        });
      });
      const rendersPerKey = ((await rendered()) - renderedBefore) / KEYS.length;
      const clicking = await watch(page, refreshMs, () => clickAround(page));
      const keys = keyLatencies(events);
      return { animations, cpu, fps: frames.fps, longFrames: frames.dropped * 100, keyP95: quantile(keys, 0.95), keyP50: quantile(keys, 0.5), keys: keys.length, typing, clicking, rendersPerKey };
    } finally {
      await browser.close();
    }
  } finally {
    await app.stop();
  }
};

const main = async () => {
  const runs: Run[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once());
  const m = (pick: (r: Run) => number) => median(runs.map(pick));
  console.log(`busy (${FIXTURE}, ${ROUTE}), median of ${RUNS}${flags.entry === undefined ? "" : ` for ${flags.entry}`}:`);
  console.log(`  running animations  ${m((r) => r.animations).toFixed(0)}`);
  console.log(`  CPU, 10 s idle      ${m((r) => r.cpu).toFixed(1)} % of a core (runs: ${runs.map((r) => r.cpu.toFixed(1)).join(", ")})`);
  console.log(`  frames, 5 s idle    ${m((r) => r.fps).toFixed(0)} fps, ${m((r) => r.longFrames).toFixed(1)}% long`);
  console.log(`  keypress to screen  p95 ${m((r) => r.keyP95).toFixed(1)} ms, p50 ${m((r) => r.keyP50).toFixed(1)} ms over ${m((r) => r.keys).toFixed(0)} keys`);
  const over: string[] = [];
  const row = (label: string, shown: string, ok?: boolean) => {
    if (ok === false) over.push(label);
    console.log(`  ${label.padEnd(19)} ${shown.padEnd(46)} ${ok === undefined ? "" : ok ? "ok" : "OVER"}`);
  };
  for (const [label, of] of [["typing", (r: Run) => r.typing], ["clicking", (r: Run) => r.clicking]] as const) {
    const stepped = m((r) => of(r).stepped);
    const p95 = m((r) => of(r).stepP95);
    const long = m((r) => of(r).long);
    row(`beat, ${label}`, `${(stepped * 100).toFixed(0)}% of due beats stepped, p95 ${p95.toFixed(0)} ms apart`, stepped >= BUDGET.stepped && p95 <= BUDGET.stepP95Ms);
    row(`frames, ${label}`, `${long.toFixed(1)}% long`, label === "typing" ? long <= BUDGET.longTyping : undefined);
  }
  const perKey = m((r) => r.rendersPerKey);
  row("renders per key", `${perKey.toFixed(1)} components`, perKey <= BUDGET.rendersPerKey);
  if (over.length > 0) console.log(`over budget: ${over.join(", ")}`);
  process.exitCode = over.length > 0 ? 1 : 0;
};

await main();
