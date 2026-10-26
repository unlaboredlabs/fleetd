// The cost of the looping state marks (ui/DESIGN.md) with many agents at work: `pnpm perf:busy` after
// `pnpm build:test`. The live-20 fixture puts 20 agents to work, so the chat's strip and the panel's Agents list are
// full of working and thinking glyphs, with the dither scan over their words. Measured with all of it on screen:
//
//   animations      the page's running CSS animations (document.getAnimations)
//   CPU             the app's whole process tree over 10 s idle, % of one core (Linux: /proc/<pid>/stat)
//   frames          requestAnimationFrame rate and long frames over 5 s idle
//   keypress p95    Chromium's EventLatency per key press into the composer, as `pnpm perf` reads it
//   beats typing    how many times the loops stepped while those keys went in, out of the beats that fell due
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
import { keyLatencies, traced } from "./trace.ts";

const { values: flags } = parseArgs({ options: { entry: { type: "string" }, runs: { type: "string" }, fixture: { type: "string" }, route: { type: "string" } } });
const RUNS = Number(flags.runs ?? "3");
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const FIXTURE = flags.fixture ?? "live-20";
const ROUTE = flags.route === "chat" ? CHAT : (flags.route ?? `${CHAT}/agents`);
/** ui/lib/beat's step. */
const BEAT_MS = 120;
const KEYS = "the writer ran the tests again and asked for a review. ".repeat(2).trim();

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

interface Run {
  readonly animations: number;
  readonly cpu: number;
  readonly fps: number;
  readonly longFrames: number;
  readonly keyP95: number;
  readonly keyP50: number;
  readonly keys: number;
  readonly steps: number;
  readonly due: number;
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
      await page.evaluate((hash) => (window.location.hash = hash), ROUTE);
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
      // A step is one batch of the beat's writes: data-beat on :root (an older build), or the loops' cells and steps.
      await page.evaluate(() => {
        const w = window as { beatSteps?: number; beatObserver?: MutationObserver };
        w.beatSteps = 0;
        w.beatObserver = new MutationObserver(() => (w.beatSteps = (w.beatSteps ?? 0) + 1));
        w.beatObserver.observe(document.documentElement, { subtree: true, attributeFilter: ["data-beat", "data-lit", "data-step"] });
      });
      const typing = performance.now();
      const events = await traced(browser, async () => {
        await page.keyboard.type(KEYS, { delay: 60 });
        await sleep(500);
      });
      const due = Math.floor((performance.now() - typing) / BEAT_MS);
      const steps = await page.evaluate(() => {
        const w = window as { beatSteps?: number; beatObserver?: MutationObserver };
        w.beatObserver?.disconnect();
        return w.beatSteps ?? 0;
      });
      const keys = keyLatencies(events);
      return { animations, cpu, fps: frames.fps, longFrames: frames.dropped * 100, keyP95: quantile(keys, 0.95), keyP50: quantile(keys, 0.5), keys: keys.length, steps, due };
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
  console.log(`  beats while typing  ${m((r) => r.steps).toFixed(0)} steps of ${m((r) => r.due).toFixed(0)} due`);
};

await main();
