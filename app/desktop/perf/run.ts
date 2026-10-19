// The desktop app's four budgets, measured: `pnpm perf` (after `pnpm build`). Prints one line per budget.
//
//   --runs N             launches timed for first paint after an untimed first one (default 5; the median counts)
//   --json FILE          also write the numbers as JSON
//   --baseline FILE      exit 1 when a number regressed past budgets.ts's limit from FILE (the Linux CI job)
//   --strict             exit 1 when a number misses its budget (the Mac, where the budgets apply)
//   FLEETD_PERF_APP      a packaged app's executable instead of the built out/ (e.g. fleetd.app/Contents/MacOS/fleetd)
//   FLEETD_PERF_FIXTURE  a fixture (pnpm fixtures) to launch on, instead of an unpaired app
//
// First paint is timed from this script's spawn to the page's first contentful paint (FLEETD_PERF's stderr line),
// with no debugger attached. Memory is the RSS of every process in the app's tree after 10 s idle. Scroll and
// keypress drive the page over CDP (Playwright's connectOverCDP), with input going through Chromium's own pipeline.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import { devtoolsPort, launch, type Memory, sleep } from "./app.ts";
import { BUDGETS, frameStats, median, type Metric, METRICS, quantile, regressions, type Results, withinBudget } from "./budgets.ts";
import { COMPOSER, SCROLL } from "./targets.ts";

const { values: flags } = parseArgs({
  options: { runs: { type: "string", default: "5" }, json: { type: "string" }, baseline: { type: "string" }, strict: { type: "boolean", default: false } },
});
const RUNS = Number(flags.runs);
const IDLE_MS = 10_000;
const SCROLL_MS = 4_000;
const KEYS = "the writer ran the tests again and asked for a review";

/** One untimed launch first (a fresh runner's first one fills the font and shader caches, 8 s on CI), then RUNS. */
const firstPaint = async (): Promise<{ cold: number; warm: Array<number> }> => {
  const times: Array<number> = [];
  for (let i = 0; i <= RUNS; i++) {
    const spawned = Date.now();
    const app = launch();
    try {
      const line = await app.waitFor(/^FLEETD_PERF launch .*first_contentful_paint_epoch_ms=([\d.]+)/u, 30_000);
      times.push(Number(line[1]) - spawned);
    } finally {
      await app.stop();
    }
  }
  const [cold = Number.NaN, ...warm] = times;
  return { cold, warm };
};

/** rAF timestamps while `during` runs. */
const frames = async (page: Page, during: () => Promise<unknown>): Promise<Array<number>> => {
  await page.evaluate(() => {
    const stamps: Array<number> = [];
    Object.assign(window, { __perfStamps: stamps, __perfRun: true });
    const tick = (t: number) => {
      stamps.push(t);
      if ((window as unknown as { __perfRun: boolean }).__perfRun) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await during();
  return page.evaluate(() => {
    const w = window as unknown as { __perfRun: boolean; __perfStamps: Array<number> };
    w.__perfRun = false;
    return w.__perfStamps;
  });
};

const scroll = async (page: Page) => {
  await SCROLL.open(page);
  const list = page.locator(SCROLL.selector);
  await list.waitFor({ state: "visible" });
  await sleep(1000);
  // The display's refresh interval, from an idle second of frames.
  const idle = await frames(page, () => sleep(1000));
  const refreshMs = quantile(idle.slice(1).map((t, i) => t - (idle[i] ?? t)), 0.5);
  const box = await list.boundingBox();
  if (box === null) throw new Error("the log has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const from = await list.evaluate((el) => el.scrollTop);
  const stamps = await frames(page, async () => {
    const end = performance.now() + SCROLL_MS;
    while (performance.now() < end) {
      // Up: a conversation opens at its newest line, and reading back is the scroll that renders new rows.
      await page.mouse.wheel(0, -240);
      await sleep(16);
    }
  });
  const moved = Math.abs((await list.evaluate((el) => el.scrollTop)) - from);
  if (moved < 5_000) throw new Error(`the log scrolled only ${moved}px; the measurement would not mean anything`);
  return { ...frameStats(stamps, refreshMs), refreshHz: 1000 / refreshMs, moved };
};

/**
 * Per key: from the keydown's timestamp (when Chromium received it) to the frame that shows it. The page measures
 * to just after the next frame's rendering work (a message posted from requestAnimationFrame); the Event Timing API,
 * which ends at presentation but reports only events of 16 ms and more, overrides that for any slow key.
 */
const keys = async (page: Page) => {
  await COMPOSER.open(page);
  const field = page.locator(COMPOSER.selector);
  await field.click();
  await page.evaluate((selector) => {
    const latencies: Array<{ start: number; frame: number }> = [];
    const slow: Array<{ start: number; duration: number }> = [];
    Object.assign(window, { __perfKeys: latencies, __perfSlow: slow });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === "keydown") slow.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    document.querySelector(selector)?.addEventListener("keydown", (event) => {
      const start = event.timeStamp;
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => latencies.push({ start, frame: performance.now() });
        channel.port2.postMessage(null);
      });
    });
  }, COMPOSER.selector);
  await page.keyboard.type(KEYS, { delay: 60 });
  await sleep(500);
  const { measured, slow } = await page.evaluate(() => {
    const w = window as unknown as { __perfKeys: Array<{ start: number; frame: number }>; __perfSlow: Array<{ start: number; duration: number }> };
    return { measured: w.__perfKeys, slow: w.__perfSlow };
  });
  const latencies = measured.map((k) => Math.max(k.frame - k.start, slow.find((s) => Math.abs(s.start - k.start) < 1)?.duration ?? 0));
  return { p95: quantile(latencies, 0.95), p50: quantile(latencies, 0.5), count: latencies.length, slow: slow.length };
};

const main = async () => {
  const paints = await firstPaint();

  const app = launch({ debug: true });
  let results: Results;
  let detail: Record<Metric, string>;
  try {
    const port = await devtoolsPort(app);
    await app.waitFor(/^FLEETD_PERF launch /u, 30_000);
    await sleep(IDLE_MS);
    const samples: Array<Memory> = [];
    for (let i = 0; i < 3; i++) {
      samples.push(app.memory());
      await sleep(1000);
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith("/index.html"));
      if (page === undefined) throw new Error("no app window over CDP");
      const scrolled = await scroll(page);
      const typed = await keys(page);
      results = {
        firstPaintMs: median(paints.warm),
        idleMemoryMb: median(samples.map((m) => m.uniqueMb)),
        idleRssMb: median(samples.map((m) => m.rssMb)),
        scrollFps: scrolled.fps,
        keyP95Ms: typed.p95,
      };
      detail = {
        firstPaintMs: `median of ${paints.warm.length} launches: ${paints.warm.map((p) => p.toFixed(0)).join(", ")} ms (the untimed first: ${paints.cold.toFixed(0)} ms)`,
        idleMemoryMb: `${process.platform === "linux" ? "PSS" : "physical footprint"} summed over ${samples[0]?.processes ?? 0} processes after ${IDLE_MS / 1000} s idle`,
        scrollFps: `${SCROLL.label}; ${(scrolled.dropped * 100).toFixed(1)}% long frames, ${(scrolled.moved / 1000).toFixed(0)}k px, display ${scrolled.refreshHz.toFixed(0)} Hz`,
        keyP95Ms: `${COMPOSER.label}; p50 ${typed.p50.toFixed(1)} ms over ${typed.count} keys, ${typed.slow} at 16 ms or more`,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await app.stop();
  }

  const electron = process.env["FLEETD_PERF_APP"] ? "packaged app" : `Electron ${electronVersion()}`;
  const header = `fleetd desktop budgets: ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model.trim() ?? "unknown cpu"}, ${electron}`;
  const rows = METRICS.map((metric) => {
    const b = BUDGETS[metric];
    const value = results[metric];
    const ok = withinBudget(metric, value);
    const shown = metric === "keyP95Ms" ? value.toFixed(1) : value.toFixed(0);
    const budget = `budget ${b.higher ? "≥" : "<"} ${b.limit} ${b.unit}`;
    return { metric, ok, line: `  ${b.label.padEnd(21)} ${`${shown} ${b.unit}`.padStart(8)}   ${budget.padEnd(17)} ${ok ? "ok  " : "MISS"}  ${detail[metric]}` };
  });
  const rss = `  ${"(summed RSS)".padEnd(21)} ${`${results.idleRssMb.toFixed(0)} MB`.padStart(8)}   ${"not gated".padEnd(17)}       counts the shared Electron pages once per process`;
  const definition =
    "  idle memory = deduplicated memory summed over every app process: PSS on Linux, physical footprint (Activity Monitor's Memory) on macOS";
  const report = [header, ...rows.map((r) => r.line), rss, definition].join("\n");
  console.log(report);
  if (flags.json !== undefined) writeFileSync(flags.json, `${JSON.stringify(results, null, 2)}\n`);

  let failed = false;
  if (flags.baseline !== undefined) {
    const baseline = JSON.parse(readFileSync(flags.baseline, "utf8")) as Results;
    const worse = regressions(results, baseline);
    for (const r of worse) console.log(`REGRESSION ${BUDGETS[r.metric].label}: ${r.value.toFixed(1)} past ${r.limit.toFixed(1)} (baseline ${baseline[r.metric]})`);
    failed ||= worse.length > 0;
    if (worse.length === 0) console.log(`no regression from ${flags.baseline}`);
  }
  if (flags.strict && rows.some((r) => !r.ok)) failed = true;
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined) appendFileSync(summary, `### Desktop budgets\n\n\`\`\`\n${report}\n\`\`\`\n`);
  process.exitCode = failed ? 1 : 0;
};

const electronVersion = () => (JSON.parse(readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8")) as { version: string }).version;

await main();
