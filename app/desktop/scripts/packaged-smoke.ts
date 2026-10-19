// `node scripts/packaged-smoke.ts <packaged binary> [electron args...]`: launches a PACKAGED test build
// (MAIN_VITE_FLEETD_TEST_BUILD=1, packed by electron-builder into dist-test/) on the "typical" fixture and requires
// the shell and its screens to come up with no error state and no uncaught page error. It catches what the QA suite,
// which runs out/ beside node_modules, can't: a module main or the preload needs that didn't make it into the asar.
//
// It attaches over Chromium's --remote-debugging-port, which only a test build accepts (a release build refuses it,
// see src/main/debug-switches.ts); Playwright's own Electron launcher needs Node's --inspect, which the packaged
// fuses keep off in every build. Run `pnpm fixtures` first.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9335;
const START_MS = 30_000;
/** The shell, the board, and an order view (markdown and code highlighting) on the typical fixture. */
const SCREENS: ReadonlyArray<{ id: string; route: string }> = [
  { id: "shell", route: "#/" },
  { id: "board", route: "#/board" },
  { id: "order", route: "#/order/W1" },
];

const [binary, ...extra] = process.argv.slice(2);
if (binary === undefined) throw new Error("usage: node scripts/packaged-smoke.ts <packaged binary> [electron args...]");

/** Everything the launch passes, in one place, so the opt-in for the debugging port is one line to change. */
const launchSpec = (home: string) => ({
  args: [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(home, "chromium")}`, ...extra],
  env: {
    FLEETD_FIXTURE: "typical",
    FLEETD_FIXTURE_DIR: path.join(ROOT, "fixtures"),
    FLEETD_HOME: path.join(home, "fleetd"),
    HOME: process.env["HOME"] ?? home,
    PATH: process.env["PATH"] ?? "",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    ...Object.fromEntries(["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  },
});

/** Opens a route and waits for its screen (or a sub-state of it, "board.empty") and for nothing to be busy. */
const show = async (page: Page, id: string, route: string): Promise<void> => {
  await page.evaluate(`window.location.hash = ${JSON.stringify(route)}`);
  await page.locator(`[data-screen="${id}"], [data-screen^="${id}."]`).first().waitFor({ state: "visible", timeout: 15_000 });
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

try {
  await waitForEndpoint();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await appPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  for (const screen of SCREENS) {
    await show(page, screen.id, screen.route);
    const states = await page.evaluate<string[]>(`[...document.querySelectorAll("[data-screen]")].map((e) => e.getAttribute("data-screen") ?? "")`);
    const broken = states.filter((s) => /\.(error|failed|missing|not-?found)$/u.test(s));
    if (broken.length > 0) throw new Error(`${screen.id} shows ${broken.join(", ")}`);
    console.log(`packaged smoke: ${screen.id} is up (${states.join(", ")})`);
  }
  if (errors.length > 0) throw new Error(`uncaught page errors: ${errors.join("; ")}`);
  await browser.close();
  console.log("packaged smoke: ok");
} finally {
  stop();
}
