// The desktop app's four budgets, measured on the real chat (the chat-long fixture): `pnpm perf` after
// `pnpm build:test` (a release build refuses the DevTools port the harness drives it through). Prints one line per
// budget.
//
//   --json FILE          also write the numbers as JSON
//   --baseline FILE      exit 1 when a number regressed past budgets.ts's limit from FILE (the Linux CI job)
//   (CI gates first paint only over a bare Electron window, perf/reference, which moves with the runner too)
//
// First paint is timed from this script's spawn to the page's first contentful paint (FLEETD_PERF's stderr line),
// with no debugger attached. Memory is the RSS of every process in the app's tree after 10 s idle. Scroll and
// keypress drive the page over CDP (Playwright's connectOverCDP), with input going through Chromium's own pipeline;
// keypress latency is read from Chromium's EventLatency trace, which ends at presentation (perf/trace.ts).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { devtoolsPort, launch, type Memory, openChat, sleep } from "./app.ts";
import { frameStats, median, type Metric, METRICS, quantile, regressions, type Results, RULES, withinBudget } from "./budgets.ts";
import { keyLatencies, traced } from "./trace.ts";

const { values: flags } = parseArgs({ options: { json: { type: "string" }, baseline: { type: "string" } } });
/** Launches timed for first paint after an untimed first one; the median counts. */
const RUNS = 5;
const IDLE_MS = 10_000;
const SCROLL_MS = 4_000;
// About 160 keys a round: a p95 over fewer swings with two or three slow ones on a shared CI runner.
const KEYS = "the writer ran the tests again and asked for a review. ".repeat(3).trim();
/**
 * Rounds of KEYS timed after an untimed first one; the median round's p95 counts. A shared runner stalls now and then
 * for a second or two, and in a single round that put 16 slow keys into its p95 (17 ms against a usual 6-11).
 */
const KEY_ROUNDS = 5;

const REFERENCE = path.join(import.meta.dirname, "reference", "main.mjs");

/** From spawn until the window is shown and has painted its first content: the later of ready-to-show and FCP. */
const timeLaunch = async (entry?: string): Promise<number> => {
  const spawned = Date.now();
  const app = launch(entry === undefined ? {} : { entry });
  try {
    const line = await app.waitFor(/^FLEETD_PERF launch .*first_contentful_paint_epoch_ms=([\d.]+).* ready_to_show_epoch_ms=(\d+)/u, 30_000);
    return Math.max(Number(line[1]), Number(line[2])) - spawned;
  } finally {
    await app.stop();
  }
};

/**
 * The app and the bare reference, alternately, so both see the runner in the same state. One untimed launch of each
 * first (a fresh runner's first launch fills the OS page cache: 5-8 s on CI), then RUNS of each.
 */
const firstPaint = async () => {
  const app: Array<number> = [];
  const bare: Array<number> = [];
  for (let i = 0; i <= RUNS; i++) {
    app.push(await timeLaunch());
    bare.push(await timeLaunch(REFERENCE));
  }
  return { coldApp: app[0] ?? Number.NaN, app: app.slice(1), bare: bare.slice(1) };
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

const scroll = async (page: Page, list: Locator) => {
  await sleep(1000);
  // The display's refresh interval, from an idle second of frames.
  const idle = await frames(page, () => sleep(1000));
  const refreshMs = quantile(idle.slice(1).map((t, i) => t - (idle[i] ?? t)), 0.5);
  const box = await list.boundingBox();
  if (box === null) throw new Error("the chat has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Upward travel only: a page of older messages landing above shifts scrollTop down by its height, which isn't scrolling.
  await list.evaluate((el) => {
    const travel = { up: 0, last: el.scrollTop };
    el.addEventListener("scroll", () => {
      travel.up += Math.max(0, travel.last - el.scrollTop);
      travel.last = el.scrollTop;
    });
    Object.assign(el, { __perfTravel: travel });
  });
  const stamps = await frames(page, async () => {
    const end = performance.now() + SCROLL_MS;
    while (performance.now() < end) {
      // Up: a chat opens at its newest message, and reading back is the scroll that renders (and pages in) older ones.
      await page.mouse.wheel(0, -240);
      await sleep(16);
    }
  });
  const moved = await list.evaluate((el) => (el as unknown as { __perfTravel: { up: number } }).__perfTravel.up);
  if (moved < 5_000) throw new Error(`the chat scrolled only ${moved}px; the measurement would not mean anything`);
  return { ...frameStats(stamps, refreshMs), refreshHz: 1000 / refreshMs, moved };
};

/** Per key: Chromium's EventLatency for the key press, input timestamp to presentation (perf/trace.ts), by round. */
const keys = async (browser: Browser, page: Page, composer: Locator) => {
  await composer.click();
  const type = async () => {
    await page.keyboard.type(KEYS, { delay: 60 });
    await sleep(500);
  };
  // An untimed first round warms the composer up, as the untimed first launch does for first paint.
  await type();
  await composer.fill("");
  const rounds: Array<{ p95: number; p50: number; slow: number }> = [];
  for (let i = 0; i < KEY_ROUNDS; i++) {
    const latencies = keyLatencies(await traced(browser, type));
    await composer.fill("");
    if (latencies.length < KEYS.length * 0.9) throw new Error(`the trace has ${latencies.length} key presses for ${KEYS.length} keys`);
    rounds.push({ p95: quantile(latencies, 0.95), p50: quantile(latencies, 0.5), slow: latencies.filter((l) => l >= 16).length });
  }
  return { p95: median(rounds.map((r) => r.p95)), rounds };
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
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname.endsWith("/index.html"));
      if (page === undefined) throw new Error("no app window over CDP");
      const chat = await openChat(page);
      const scrolled = await scroll(page, chat.log);
      const typed = await keys(browser, page, chat.composer);
      const firstPaintMs = median(paints.app);
      const firstPaintRefMs = median(paints.bare);
      results = {
        firstPaintMs,
        firstPaintRefMs,
        firstPaintOverMs: firstPaintMs - firstPaintRefMs,
        idleMemoryMb: median(samples.map((m) => m.uniqueMb)),
        idleRssMb: median(samples.map((m) => m.rssMb)),
        scrollFps: scrolled.fps,
        keyP95Ms: typed.p95,
      };
      detail = {
        firstPaintMs: `median of ${paints.app.length} warm launches: ${paints.app.map((p) => p.toFixed(0)).join(", ")} ms (the untimed first: ${paints.coldApp.toFixed(0)} ms)`,
        firstPaintRefMs: `the same for a bare Electron window with one line of text, launched alternately: ${paints.bare.map((p) => p.toFixed(0)).join(", ")} ms`,
        firstPaintOverMs: "what the app adds to Electron's own start; CI gates this, not the runner-bound first paint",
        idleRssMb: "summed RSS of the same processes; counts the shared Electron pages once per process, never gated",
        idleMemoryMb: `${process.platform === "linux" ? "PSS" : "physical footprint"} summed over all ${samples[0]?.processes ?? 0} processes read (${[...new Set(samples[0]?.kinds ?? [])].join(", ")}) after ${IDLE_MS / 1000} s idle`,
        scrollFps: `the chat-long fixture's chat; ${(scrolled.dropped * 100).toFixed(1)}% long frames, ${(scrolled.moved / 1000).toFixed(0)}k px, display ${scrolled.refreshHz.toFixed(0)} Hz`,
        keyP95Ms: `the chat's composer; EventLatency, key press to presentation; median of ${typed.rounds.length} rounds of ${KEYS.length} keys, p95/p50 (keys at 16 ms or more): ${typed.rounds.map((r) => `${r.p95.toFixed(1)}/${r.p50.toFixed(1)} (${r.slow})`).join(", ")} ms`,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await app.stop();
  }

  const electron = `Electron ${electronVersion()}`;
  const header = `fleetd desktop budgets: ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model.trim() ?? "unknown cpu"}, ${electron}`;
  const rows = METRICS.map((metric) => {
    const rule = RULES[metric];
    const value = results[metric];
    const ok = withinBudget(metric, value);
    // Frame rates to a tenth: 56.7 fps misses a budget of 57, and printed whole it would read 57 next to MISS.
    const shown = metric === "keyP95Ms" || metric === "scrollFps" ? value.toFixed(1) : value.toFixed(0);
    const gate = rule.limit !== undefined ? `budget ${rule.higher ? "≥" : "<"} ${rule.limit} ${rule.unit}` : rule.regress !== undefined ? "CI regression" : "information";
    const verdict = ok === undefined ? "    " : ok ? "ok  " : "MISS";
    return { ok, line: `  ${rule.label.padEnd(19)} ${`${shown} ${rule.unit}`.padStart(8)}   ${gate.padEnd(17)} ${verdict}  ${detail[metric]}` };
  });
  const definitions = [
    "  first paint: from spawning the app until its window is shown and has painted its first content (the later of ready-to-show and FCP)",
    "  idle memory: deduplicated memory summed over every app process after 10 s idle: PSS on Linux, physical footprint (Activity Monitor's Memory) on macOS",
    "  chat scroll: requestAnimationFrame rate while wheel-scrolling back through the chat",
    `  keypress to screen: Chromium's EventLatency per key press, from the OS input timestamp to the presentation of the frame that shows it${process.platform === "linux" && process.env["WAYLAND_DISPLAY"] === undefined ? " (on X11/Xvfb, presentation is the swap, with no wait for a display's vsync)" : ""}`,
  ];
  const report = [header, ...rows.map((r) => r.line), ...definitions].join("\n");
  console.log(report);
  if (flags.json !== undefined) writeFileSync(flags.json, `${JSON.stringify(results, null, 2)}\n`);

  let failed = false;
  if (flags.baseline !== undefined) {
    const baseline = JSON.parse(readFileSync(flags.baseline, "utf8")) as Results;
    const worse = regressions(results, baseline);
    for (const r of worse) console.log(`REGRESSION ${RULES[r.metric].label}: ${r.value.toFixed(1)} past ${r.limit.toFixed(1)} (baseline ${baseline[r.metric]})`);
    failed ||= worse.length > 0;
    if (worse.length === 0) console.log(`no regression from ${flags.baseline}`);
  }
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined) appendFileSync(summary, `### Desktop budgets\n\n\`\`\`\n${report}\n\`\`\`\n`);
  process.exitCode = failed ? 1 : 0;
};

const electronVersion = () => (JSON.parse(readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8")) as { version: string }).version;

await main();
