// Launches the built app on a fixture, sets the window to a size and theme, runs the DOM checks and writes the
// screenshots. Used by the screen suite, the platform suite and the self-test.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CDPSession, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import type { Box, CheckOptions, Finding, ScrollStep } from "./dom/checks.ts";
import { type FixtureName, type Screen, type SizeName, sizes, type Theme } from "./registry.ts";

const qaDir = import.meta.dirname;
export const desktopDir = path.resolve(qaDir, "..");
export const fixturesDir = process.env.QA_FIXTURE_DIR ?? path.join(desktopDir, "fixtures");
export const resultsDir = process.env.QA_RESULTS ?? path.join(desktopDir, "qa-results");
export const appMain = process.env.QA_APP_MAIN ?? path.join(desktopDir, "out", "main", "index.js");
export const scale = Number(process.env.QA_SCALE ?? "1");
export const EDGE_INSET = 8;

// The checks run in the renderer over CDP (page.evaluate), which the app's CSP does not govern.
let checksSource: string | undefined;
function checksScript() {
  checksSource ??= buildSync({
    entryPoints: [path.join(qaDir, "dom", "checks.ts")],
    bundle: true,
    format: "iife",
    globalName: "__fleetdQa",
    target: "chrome140",
    write: false,
  }).outputFiles[0]?.text;
  if (!checksSource) throw new Error("bundling the DOM checks produced no output");
  return checksSource;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  // Resolves once the fixture's timed frames have all arrived and the page is stable.
  settled: () => Promise<void>;
  // Plays the fixture's timeline again on the screen now up (a reload resubscribes), and waits it out.
  replay: () => Promise<void>;
  // What the page threw or logged as an error so far, for a failure's message.
  errors: string[];
  close: () => Promise<void>;
}

// From the fixture file: its "now", so relative times ("3 min ago") read the same on every run, and its "settleMs",
// how long after a subscribe its timed frames keep arriving.
export function fixtureMeta(file: string) {
  if (!existsSync(file)) throw new Error(`Fixture ${file} not found: run \`pnpm fixtures\` in app/desktop first.`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return {};
  return {
    now: "now" in parsed && typeof parsed.now === "string" ? parsed.now : undefined,
    settleMs: "settleMs" in parsed && typeof parsed.settleMs === "number" ? parsed.settleMs : 0,
  };
}

// Retries only a launch that never started (the binary busy or missing for a moment), never a test outcome.
const LAUNCH_RACE = /ETXTBSY|ENOENT|EAGAIN|spawn|Process failed to launch/;
async function launchElectron(options: Parameters<typeof electron.launch>[0], attempts = 3): Promise<ElectronApplication> {
  try {
    return await electron.launch(options);
  } catch (error) {
    if (attempts <= 1 || !LAUNCH_RACE.test(String(error))) throw error;
    await new Promise((done) => setTimeout(done, 500));
    return launchElectron(options, attempts - 1);
  }
}

// `fixture` is required for the app; only the self-test's stand-in window runs without one.
// Without a fixture, `hub` connects the app to a real hub for one run (the site's lab captures); nothing is saved.
// `realClock` skips the fixture's fixed clock (see Screen.realClock).
export async function launch(
  fixture: FixtureName | undefined,
  main = appMain,
  hub?: { url: string; key: string },
  { realClock = false } = {},
): Promise<Launched> {
  if (!existsSync(main)) throw new Error(`${main} is missing: run \`pnpm qa:build\` in app/desktop first.`);
  const meta = fixture === undefined ? {} : fixtureMeta(path.join(fixturesDir, `${fixture}.json`));
  const now = realClock ? undefined : meta.now;
  const settleMs = meta.settleMs ?? 0;
  const userData = mkdtempSync(path.join(tmpdir(), "fleetd-qa-"));
  // Only what Electron needs: never the user's fleetd home, credentials or the agent's own session variables.
  const env: Record<string, string> = {
    ...(fixture === undefined ? {} : { FLEETD_FIXTURE: fixture, FLEETD_FIXTURE_DIR: fixturesDir }),
    ...(hub === undefined ? {} : { FLEETD_HUB_URL: hub.url, FLEETD_AGENT_KEY: hub.key }),
    FLEETD_HOME: path.join(userData, "fleetd"),
    HOME: process.env.HOME ?? userData,
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
  for (const key of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const args = [main, `--user-data-dir=${userData}`, `--force-device-scale-factor=${scale}`, "--lang=en-US"];
  if (process.platform === "linux") {
    // Chromium's process sandbox needs a SUID helper or unprivileged user namespaces, which neither GitHub's Ubuntu
    // runners nor a dev box without root setup allow. The renderer sandbox the app sets in webPreferences is a
    // separate switch and stays on.
    args.push("--no-sandbox");
    // No display (CI, an ssh session): render offscreen. Layout, fonts and screenshots are the same.
    if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) args.push("--ozone-platform=headless");
  }
  const app = await launchElectron({ args, env, cwd: desktopDir, timeout: 30_000 });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().split("\n")[0] ?? "");
  });
  // Entry animations of the first screen play reduced too.
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (now) {
    await page.clock.setFixedTime(new Date(now));
    await page.reload();
  }
  // The renderer subscribed on this load, so the fixture's timeline runs from here.
  const settledAt = Date.now() + settleMs;
  return {
    app,
    page,
    settled: async () => {
      const left = settledAt - Date.now();
      if (left > 0) await new Promise((done) => setTimeout(done, left));
      await settle(page);
    },
    replay: async () => {
      await page.reload();
      await new Promise((done) => setTimeout(done, settleMs));
    },
    errors,
    close: async () => {
      // A window stuck on a dead page can hold app.close() forever, and the test's timeout then hides its own error.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<boolean>((done) => (timer = setTimeout(() => done(true), 15_000)));
      if (await Promise.race([app.close().then(() => false, () => false), stuck])) app.process().kill("SIGKILL");
      clearTimeout(timer);
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function setView(app: ElectronApplication, page: Page, size: SizeName, theme: Theme) {
  const { width, height } = sizes[size];
  // The native window must be done resizing before the viewport override below: a native resize that lands after it
  // (macOS clamping a window larger than the screen, or showing it late on ready-to-show) resets the page's visible
  // size to the window's, so the checks measured one size and the screenshot was another. That raced on the macOS
  // runners, whose screens are as small as 1024×768. So: wait until the window is shown, size it only within the
  // display's work area (where nothing clamps it), and let the override supply the rest of the size.
  await app.evaluate(
    async ({ BrowserWindow, nativeTheme, screen }, v) => {
      nativeTheme.themeSource = v.theme;
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("the app opened no window");
      if (!win.isVisible()) await new Promise((shown) => win.once("show", () => shown(null)));
      const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
      const [frameW = 0, frameH = 0] = win.getSize();
      const [contentW = 0, contentH = 0] = win.getContentSize();
      win.setContentSize(Math.min(v.width, area.width - (frameW - contentW)), Math.min(v.height, area.height - (frameH - contentH)));
      // macOS applies a frame change asynchronously (and may still clamp it): wait until the size stops changing.
      let last = win.getContentSize().join("x");
      for (let i = 0; i < 25; i++) {
        await new Promise((tick) => setTimeout(tick, 20));
        const now = win.getContentSize().join("x");
        if (now === last) break;
        last = now;
      }
    },
    { width, height, theme },
  );
  // A window can't outgrow its screen (macOS runners have small ones), so the page's viewport is set too: layout,
  // the checks and the screenshot all see exactly the size asked for. Not with page.setViewportSize: on an Electron
  // page it sends a device scale factor of 1, which overrides --force-device-scale-factor and makes every @2x shot
  // a 1x one. The override below carries the scale, and is re-sent on every resize.
  views.set(page, { width, height });
  await applyView(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await holdView(page);
}

// For a picture of the real window (the macOS traffic lights are native, so a page screenshot can't show them): no
// viewport override, the window itself at the size, and the page laid out in it. Throws when the screen can't hold
// that size, rather than labelling a cropped or shrunk window with it.
export async function setNativeView(app: ElectronApplication, page: Page, size: SizeName, theme: Theme) {
  const { width, height } = sizes[size];
  views.delete(page);
  await (await cdp(page)).send("Emulation.clearDeviceMetricsOverride");
  const real = await app.evaluate(
    async ({ BrowserWindow, nativeTheme }, v) => {
      nativeTheme.themeSource = v.theme;
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("the app opened no window");
      if (!win.isVisible()) await new Promise((shown) => win.once("show", () => shown(null)));
      win.setContentSize(v.width, v.height);
      for (let i = 0; i < 25; i++) {
        await new Promise((tick) => setTimeout(tick, 20));
        const [w = 0, h = 0] = win.getContentSize();
        if (w === v.width && h === v.height) break;
      }
      const [w = 0, h = 0] = win.getContentSize();
      return { width: w, height: h };
    },
    { width, height, theme },
  );
  if (real.width !== width || real.height !== height) {
    throw new Error(`the window is ${real.width}×${real.height}: this screen can't hold ${size} (${width}×${height})`);
  }
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.waitForFunction((v) => window.innerWidth === v.width && window.innerHeight === v.height, { width, height });
}

// The viewport each page was last set to.
const views = new WeakMap<Page, { width: number; height: number }>();

async function applyView(page: Page) {
  const view = views.get(page);
  if (!view) throw new Error("setView() has not run on this page");
  const session = await cdp(page);
  await session.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: scale, mobile: false });
  return view;
}

// Waits until the page is at its set viewport and scale; if a late native resize knocked it off, applies the
// override again once. Run before checking and before every screenshot, so both see the size that was asked for.
async function holdView(page: Page) {
  const view = views.get(page);
  if (!view) return;
  const at = (timeout: number) =>
    page
      .waitForFunction(
        (v) => window.innerWidth === v.width && window.innerHeight === v.height && window.devicePixelRatio === v.scale,
        { ...view, scale },
        { timeout },
      )
      .then(
        () => true,
        () => false,
      );
  if (await at(2_000)) return;
  await applyView(page);
  if (!(await at(3_000))) {
    const got = await page.evaluate(() => `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`);
    throw new Error(`the page is ${got}, not the ${view.width}×${view.height} @${scale} it was set to`);
  }
}

const sessions = new WeakMap<Page, Promise<CDPSession>>();
function cdp(page: Page) {
  let session = sessions.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  return session;
}

// A PNG's size from its IHDR chunk.
export function pngSize(file: string) {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

export async function show(page: Page, screenId: string, route: string, open?: (page: Page) => Promise<void>) {
  await page.evaluate((r) => {
    window.location.hash = r;
  }, route);
  if (open) {
    // The route is up once any screen is; then the interaction brings up this one.
    await page.locator("[data-screen]").first().waitFor({ state: "visible", timeout: 10_000 });
    await settle(page);
    await open(page);
  }
  // A screen marks its sub-states as "<id>.<state>" (chat.loading), so either form means it is up.
  await page
    .locator(`[data-screen="${screenId}"], [data-screen^="${screenId}."]`)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await settle(page);
}

// A sub-state ending in one of these is an error page, whether the screen's own or one of its panels'.
const ERROR_STATES = new Set(["error", "not-found", "notfound", "missing", "failed"]);

// Fails when the view shows an error or not-found state the registry entry doesn't expect, or expects one and
// shows none.
export async function assertExpectedState(page: Page, screen: Pick<Screen, "id" | "expect">) {
  const states = await page.locator("[data-screen]").evaluateAll((els) => els.map((e) => e.getAttribute("data-screen") ?? ""));
  const errors = states.filter((s) => ERROR_STATES.has(s.split(".").pop() ?? ""));
  if (screen.expect === "error" && errors.length === 0) {
    throw new Error(`${screen.id} expects an error state but shows ${states.join(", ")}`);
  }
  if (screen.expect !== "error" && errors.length > 0) {
    throw new Error(
      `${screen.id} shows ${errors.join(", ")}: fix the route or fixture (an id the fixture doesn't have?), or register the entry with expect: "error"`,
    );
  }
}

// Fonts loaded, no skeletons, and the layout unchanged for three frames in a row. Components that fit themselves to
// their measured size (a ResizeObserver, then a re-render, sometimes twice) settle a frame or more after the last
// font or resize, more often on the slower macOS runners; a fixed two frames shot them mid-fit. `fonts.ready` waits
// for the faces the current layout asked for; `fonts.status` alone is "loaded" before any face has been requested.
// A page that never holds still (a running animation) is shot after 3 s rather than hanging the run.
export async function settle(page: Page) {
  await page.waitForFunction(() => !document.querySelector("[aria-busy='true']"), undefined, { timeout: 10_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
    const layout = () => {
      let sig = `${document.body.scrollWidth}x${document.body.scrollHeight}`;
      for (const el of document.body.getElementsByTagName("*")) {
        const r = el.getBoundingClientRect();
        sig += `|${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      }
      return sig;
    };
    const until = performance.now() + 3_000;
    let last = layout();
    let still = 0;
    while (still < 3 && performance.now() < until) {
      await frame();
      const now = layout();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  });
}

// On macOS the sidebar is the window's own vibrancy under a clear page (main/index.ts), which a page screenshot
// can't see: it would come out empty, or Chromium's dark canvas in the dark theme. Page shots drop the page's
// data-vibrancy, so the sidebar paints its --sidebar tone: how it looks with Reduce transparency and on Linux. The
// native window shot (platform.spec.ts) never comes through here, so it shows the real material.
async function opaqueSidebar(page: Page) {
  if (process.platform !== "darwin") return;
  await page.evaluate(() => delete document.documentElement.dataset["vibrancy"]);
}

// Fails when the window is blank (React rendered nothing) or an error card is up (src/renderer/src/Boundary.tsx), unless
// the entry is there to show the card. A card means a part threw; the page's errors say what.
export async function assertAlive(page: Page, screen: Pick<Screen, "id" | "expect">, errors: readonly string[]) {
  const { rendered, cards } = await page.evaluate(() => ({
    rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
    cards: [...document.querySelectorAll("[data-crashed]")].map((e) => e.getAttribute("data-crashed") ?? ""),
  }));
  const thrown = errors.length > 0 ? `\nThe page's errors:\n  ${errors.slice(0, 10).join("\n  ")}` : "";
  if (!rendered) throw new Error(`${screen.id}: the window is blank${thrown}`);
  if (screen.expect === "card" && cards.length === 0) throw new Error(`${screen.id} expects an error card but shows none`);
  if (screen.expect !== "card" && cards.length > 0) throw new Error(`${screen.id}: an error card is up in ${cards.join(", ")}${thrown}`);
}

// macOS draws the traffic lights over the page; nothing of ours may sit under them.
export async function reservedRegions(app: ElectronApplication): Promise<Box[]> {
  if (process.platform !== "darwin") return [];
  const pos = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition() ?? null);
  // The app sets trafficLightPosition; without one, hiddenInset puts the buttons at about (20, 18).
  const x = pos?.x ?? 20;
  const y = pos?.y ?? 18;
  // Three ~14 px buttons 20 px apart, plus 4 px of margin all round.
  return [{ x: x - 4, y: y - 4, width: 62, height: 22 }];
}

// Calls one export of the checks bundle in the page.
const run = <T>(page: Page, call: string) => page.evaluate<T>(`${checksScript()}\n;__fleetdQa.${call}`);

export async function check(page: Page, reserved: Box[]): Promise<Finding[]> {
  const opts: CheckOptions = { edgeInset: EDGE_INSET, reserved };
  return run<Finding[]>(page, `runChecks(${JSON.stringify(opts)})`);
}

export interface Shot {
  screen: string;
  fixture: string;
  size: SizeName;
  theme: Theme;
  scale: number;
  platform: NodeJS.Platform;
  png: string;
  overlay?: string;
  // Screenshots taken while stepping through scroll containers: each container's last step, and any step with
  // findings (annotated).
  scrolled: { png: string; label: string }[];
  findings: Finding[];
}

async function capture(page: Page, file: string, findings: Finding[]) {
  await holdView(page);
  if (findings.length > 0) await run(page, `annotate(${JSON.stringify(findings)})`);
  await page.screenshot({ path: path.join(resultsDir, file), animations: "disabled", caret: "hide" });
  if (findings.length > 0) await run(page, "clearAnnotations()");
  // An "@2x" shot that is really 1x hides exactly what scale 2 is for (Retina text, hairlines, canvases), and a shot
  // of another size than the checks measured hides what they found. Compared with the size that was set, not one
  // read afterwards, which a later resize could have changed.
  const viewport = views.get(page) ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  const got = pngSize(path.join(resultsDir, file));
  const want = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  if (got.width !== want.width || got.height !== want.height) {
    throw new Error(`${file} is ${got.width}×${got.height}, not the viewport × ${scale} (${want.width}×${want.height})`);
  }
}

// Screenshot and check the view; with `scroll`, also step every scroll container through its range and check at
// each step. Any findings get an annotated screenshot.
export async function shoot(
  page: Page,
  reserved: Box[],
  meta: Pick<Shot, "screen" | "fixture" | "size" | "theme">,
  { scroll = true } = {},
): Promise<Shot> {
  const name = `${meta.screen}--${meta.fixture}--${meta.size}--${meta.theme}--${process.platform}@${scale}x`;
  mkdirSync(path.join(resultsDir, "png"), { recursive: true });
  mkdirSync(path.join(resultsDir, "shots"), { recursive: true });
  await holdView(page);
  await opaqueSidebar(page);
  const findings = await check(page, reserved);
  const png = path.join("png", `${name}.png`);
  await capture(page, png, []);
  const shot: Shot = { ...meta, scale, platform: process.platform, png, scrolled: [], findings };
  if (findings.length > 0) {
    shot.overlay = path.join("png", `${name}.findings.png`);
    await capture(page, shot.overlay, findings);
  }

  if (scroll) {
    // The same problem on every row of a list is one finding.
    const key = (f: Finding) => `${f.check}|${f.where}|${f.message}`;
    const seen = new Set(findings.map(key));
    const steps = await run<ScrollStep[]>(page, "scrollSteps()");
    for (const [i, step] of steps.entries()) {
      await run(page, `scrollToStep(${JSON.stringify(step)})`);
      await settle(page);
      const fresh = (await check(page, reserved)).filter((f) => !seen.has(key(f)));
      const at = step.top > 0 ? `${step.top}px down` : `${step.left}px across`;
      for (const f of fresh) {
        seen.add(key(f));
        findings.push({ ...f, where: `${f.where} (with ${step.where} scrolled ${at})` });
      }
      if (fresh.length > 0 || step.last) {
        const file = path.join("png", `${name}.scroll-${i}${fresh.length > 0 ? ".findings" : ""}.png`);
        await capture(page, file, fresh);
        shot.scrolled.push({ png: file, label: `${step.where} scrolled ${at}` });
      }
    }
    if (steps.length > 0) {
      await run(page, "restoreScroll()");
      await settle(page);
    }
  }
  writeFileSync(path.join(resultsDir, "shots", `${name}.json`), JSON.stringify(shot, null, 2));
  return shot;
}

export function describeFindings(shots: Shot[]) {
  return shots
    .flatMap((s) =>
      s.findings.map((f) => `[${s.size} ${s.theme}] ${f.check}: ${f.message}\n    at ${f.where}\n    "${f.text}"`),
    )
    .join("\n");
}
