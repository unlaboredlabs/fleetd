// `node scripts/packaged-smoke.ts <packaged binary> [electron args...]`: launches a PACKAGED test build
// (MAIN_VITE_FLEETD_TEST_BUILD=1, packed by electron-builder into dist-test/) on the "typical" fixture and requires
// the shell and its screens to come up with no error state and no uncaught page error. It catches what the QA suite,
// which runs out/ beside node_modules, can't: a module main or the preload needs that didn't make it into the asar.
//
// It attaches over Chromium's --remote-debugging-port, which only a test build accepts (a release build refuses it,
// see src/main/debug-switches.ts); Playwright's own Electron launcher needs Node's --inspect, which the packaged
// fuses keep off in every build. Run `pnpm fixtures` first.
//
// `--record` before the binary also sets FLEETD_RECORD, quits the app with SIGTERM after the screens (which finishes
// the recording, as quitting does) and requires a non-empty fleetd.mp4: the packaged app loads the recorder page from
// the asar, which `pnpm perf:record` (out/ beside node_modules) can't catch.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9335;
const START_MS = 30_000;
/**
 * On the typical fixture: the project lead chat the app opens on, then Status, Time and Settings, each a chunk of its
 * own loaded from the asar when first opened. Ids are the QA registry's (qa/registry.ts). `ready` is the screen's
 * loaded state, so a screen stuck on a sub-state (chat.loading, Status's skeleton) fails; it defaults to the exact id.
 */
const SCREENS: ReadonlyArray<{ id: string; route: string; ready?: string }> = [
  { id: "chat", route: "#/" },
  { id: "status.fleet", route: "#/status", ready: '[data-screen="status.fleet"][data-phase="live"]' },
  { id: "time.breakdown", route: "#/factory/time" },
  { id: "settings.general", route: "#/settings/general" },
];

const argv = process.argv.slice(2);
const record = argv[0] === "--record";
const [binary, ...extra] = record ? argv.slice(1) : argv;
if (binary === undefined) throw new Error("usage: node scripts/packaged-smoke.ts [--record] <packaged binary> [electron args...]");

/** Everything the launch passes, in one place, so the opt-in for the debugging port is one line to change. */
const launchSpec = (home: string) => ({
  args: [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(home, "chromium")}`, ...extra],
  env: {
    FLEETD_FIXTURE: "typical",
    FLEETD_FIXTURE_DIR: path.join(ROOT, "fixtures"),
    FLEETD_HOME: path.join(home, "fleetd"),
    ...(record ? { FLEETD_RECORD: path.join(home, "record") } : {}),
    HOME: process.env["HOME"] ?? home,
    PATH: process.env["PATH"] ?? "",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    ...Object.fromEntries(["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  },
});

/** Opens a route and waits for its screen's loaded state and for nothing to be busy. */
const show = async (page: Page, { id, route, ready }: (typeof SCREENS)[number]): Promise<void> => {
  await page.evaluate(`window.location.hash = ${JSON.stringify(route)}`);
  await page.locator(ready ?? `[data-screen="${id}"]`).first().waitFor({ state: "visible", timeout: 15_000 });
  // Polled with page.evaluate (CDP's Runtime.evaluate): waitForFunction evaluates its predicate with eval in the page,
  // which the app's CSP (no 'unsafe-eval') refuses.
  const until = Date.now() + 15_000;
  while (!(await page.evaluate<boolean>("!document.querySelector(\"[aria-busy='true']\")"))) {
    if (Date.now() > until) throw new Error(`${id} stayed busy`);
    await new Promise((done) => setTimeout(done, 100));
  }
};

const waitForEndpoint = async (): Promise<void> => {
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`the packaged app didn't open its debugging port within ${START_MS / 1000}s (did it start? is it a test build?)`);
};

const appPage = async (browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>): Promise<Page> => {
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("app://fleetd/"));
    if (page !== undefined) return page;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("the packaged app never showed its page");
};

const home = mkdtempSync(path.join(tmpdir(), "fleetd-smoke-"));
const { args, env } = launchSpec(home);
const child = spawn(binary, args, { env, stdio: ["ignore", "inherit", "inherit"], detached: true });
const stop = (): void => {
  // Its own process group: the helpers (and an AppImage runtime's child) go too.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(home, { recursive: true, force: true });
};

/**
 * --record: waits for the first still in frames/, which the app writes only once the capture has delivered a frame: a
 * quit before that finishes an empty recording, and a hosted macOS runner can take seconds to deliver one. (fleetd.mp4
 * itself can stay empty until the quit: a fragment closes on the next frame, and an idle page sends none.) SIGTERM
 * then finishes the recording as quitting does, and fleetd.mp4 must hold an MP4 (an ftyp box first).
 */
const checkRecording = async (): Promise<void> => {
  const dir = path.join(home, "record");
  const until = Date.now() + START_MS;
  while (!existsSync(path.join(dir, "frames")) || !readdirSync(path.join(dir, "frames")).some((f) => f.endsWith(".png"))) {
    if (Date.now() > until || child.exitCode !== null) throw new Error(`the capture delivered no frame within ${START_MS / 1000}s`);
    await new Promise((done) => setTimeout(done, 250));
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((done, fail) => {
      const late = setTimeout(() => fail(new Error("the app didn't quit within 20s of SIGTERM")), 20_000);
      child.once("exit", () => {
        clearTimeout(late);
        done();
      });
      child.kill("SIGTERM");
    });
  }
  const file = path.join(dir, "fleetd.mp4");
  const bytes = readFileSync(file);
  if (bytes.length === 0 || bytes.toString("latin1", 4, 8) !== "ftyp") throw new Error(`${file} isn't an MP4 (${bytes.length} bytes)`);
  console.log(`packaged smoke: recorded ${bytes.length} bytes to fleetd.mp4`);
};

/** Where a failed run leaves its screenshot; CI uploads the directory. */
const RESULTS = path.join(ROOT, "smoke-results");

/**
 * What the page was showing when a check failed: each data-screen with its box (0x0 or hidden reads as not visible to
 * the waits), the route, whether the page thinks it is visible, its console errors and page errors, and a screenshot.
 */
const diagnose = async (page: Page, consoleErrors: readonly string[], pageErrors: readonly string[]): Promise<void> => {
  const state = await page
    .evaluate<string>(
      `JSON.stringify({
        hash: location.hash,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        viewport: innerWidth + "x" + innerHeight,
        screens: [...document.querySelectorAll("[data-screen]")].map((e) => {
          const r = e.getBoundingClientRect();
          return e.getAttribute("data-screen") + " " + Math.round(r.width) + "x" + Math.round(r.height) + (e.checkVisibility() ? "" : " hidden");
        }),
      }, null, 2)`,
    )
    .catch((error: unknown) => `(the page didn't answer: ${String(error)})`);
  console.error(`packaged smoke: the page at failure: ${state}`);
  console.error(`packaged smoke: console errors: ${consoleErrors.length === 0 ? "none" : `\n  ${consoleErrors.join("\n  ")}`}`);
  console.error(`packaged smoke: page errors: ${pageErrors.length === 0 ? "none" : `\n  ${pageErrors.join("\n  ")}`}`);
  mkdirSync(RESULTS, { recursive: true });
  const shot = path.join(RESULTS, "failure.png");
  await page
    .screenshot({ path: shot, timeout: 10_000 })
    .then(() => console.error(`packaged smoke: screenshot at ${shot}`))
    .catch((error: unknown) => console.error(`packaged smoke: no screenshot: ${String(error)}`));
};

try {
  await waitForEndpoint();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await appPage(browser);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.reload();
  // `#/` set again just as the home redirect replaces it with a project, before React reads the hash: the app must
  // still show the project's chat (it once stayed blank; macOS runners hit that timing on their own).
  await page.evaluate(`navigation.addEventListener("navigate", function reset(e) {
    if (!e.destination.url.includes("#/project/")) return;
    navigation.removeEventListener("navigate", reset);
    queueMicrotask(() => { location.hash = "#/"; });
  })`);
  try {
    for (const screen of SCREENS) {
      await show(page, screen);
      const states = await page.evaluate<string[]>(`[...document.querySelectorAll("[data-screen]")].map((e) => e.getAttribute("data-screen") ?? "")`);
      const broken = states.filter((s) => /\.(error|failed|missing|not-?found)$/u.test(s));
      if (broken.length > 0) throw new Error(`${screen.id} shows ${broken.join(", ")}`);
      console.log(`packaged smoke: ${screen.id} is up (${states.join(", ")})`);
    }
    if (errors.length > 0) throw new Error(`uncaught page errors: ${errors.join("; ")}`);
  } catch (error) {
    await diagnose(page, consoleErrors, errors);
    throw error;
  }
  await browser.close();
  if (record) await checkRecording();
  console.log("packaged smoke: ok");
} finally {
  stop();
}
