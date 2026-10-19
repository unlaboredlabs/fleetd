// Launches the built app on a fixture, sets the window to a size and theme, runs the DOM checks and writes the
// screenshots. Used by the screen suite, the platform suite and the self-test.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import type { Box, CheckOptions, Finding } from "./dom/checks.ts";
import { type FixtureName, type SizeName, sizes, type Theme } from "./registry.ts";

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
  close: () => Promise<void>;
}

// The fixture's "now", so relative times ("3 min ago") read the same on every run.
function fixtureNow(file: string) {
  if (!existsSync(file)) throw new Error(`Fixture ${file} not found: run \`pnpm fixtures\` in app/desktop first.`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "now" in parsed && typeof parsed.now === "string") return parsed.now;
  return undefined;
}

// `fixture` is required for the app; only the self-test's stand-in window runs without one.
export async function launch(fixture: FixtureName | undefined, main = appMain): Promise<Launched> {
  const now = fixture === undefined ? undefined : fixtureNow(path.join(fixturesDir, `${fixture}.json`));
  const userData = mkdtempSync(path.join(tmpdir(), "fleetd-qa-"));
  // Only what Electron needs: never the user's fleetd home, credentials or the agent's own session variables.
  const env: Record<string, string> = {
    ...(fixture === undefined ? {} : { FLEETD_FIXTURE: fixture, FLEETD_FIXTURE_DIR: fixturesDir }),
    FLEETD_HOME: path.join(userData, "fleetd"),
    HOME: process.env.HOME ?? userData,
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "TMPDIR"]) {
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
  const app = await electron.launch({ args, env, cwd: desktopDir, timeout: 30_000 });
  const page = await app.firstWindow();
  if (now) {
    await page.clock.setFixedTime(new Date(now));
    await page.reload();
  }
  return {
    app,
    page,
    close: async () => {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function setView(app: ElectronApplication, page: Page, size: SizeName, theme: Theme) {
  const { width, height } = sizes[size];
  await app.evaluate(
    ({ BrowserWindow, nativeTheme }, v) => {
      nativeTheme.themeSource = v.theme;
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("the app opened no window");
      win.setContentSize(v.width, v.height);
    },
    { width, height, theme },
  );
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.waitForFunction(
    (v) => window.innerWidth === v.width && window.innerHeight === v.height,
    { width, height },
    { timeout: 5_000 },
  );
}

export async function show(page: Page, screenId: string, route: string, open?: (page: Page) => Promise<void>) {
  await page.evaluate((r) => {
    window.location.hash = r;
  }, route);
  // A screen marks its sub-states as "<id>.<state>" (board.empty), so either form means it is up.
  await page
    .locator(`[data-screen="${screenId}"], [data-screen^="${screenId}."]`)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  if (open) await open(page);
  await settle(page);
}

// Fonts loaded, no skeletons, and two frames painted after the last layout change.
export async function settle(page: Page) {
  await page.waitForFunction(() => document.fonts.status === "loaded" && !document.querySelector("[aria-busy='true']"), undefined, {
    timeout: 10_000,
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
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

export async function check(page: Page, reserved: Box[]): Promise<Finding[]> {
  const opts: CheckOptions = { edgeInset: EDGE_INSET, reserved };
  return page.evaluate(`${checksScript()}\n;__fleetdQa.runChecks(${JSON.stringify(opts)})`);
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
  findings: Finding[];
}

// Screenshot, run the checks, and when they find anything, a second screenshot with the findings drawn on it.
export async function shoot(
  page: Page,
  reserved: Box[],
  meta: Pick<Shot, "screen" | "fixture" | "size" | "theme">,
): Promise<Shot> {
  const name = `${meta.screen}--${meta.fixture}--${meta.size}--${meta.theme}--${process.platform}@${scale}x`;
  const pngDir = path.join(resultsDir, "png");
  mkdirSync(pngDir, { recursive: true });
  mkdirSync(path.join(resultsDir, "shots"), { recursive: true });
  const findings = await check(page, reserved);
  const png = path.join("png", `${name}.png`);
  await page.screenshot({ path: path.join(resultsDir, png), animations: "disabled", caret: "hide" });
  const shot: Shot = { ...meta, scale, platform: process.platform, png, findings };
  if (findings.length > 0) {
    shot.overlay = path.join("png", `${name}.findings.png`);
    await page.evaluate(`${checksScript()}\n;__fleetdQa.annotate(${JSON.stringify(findings)})`);
    await page.screenshot({ path: path.join(resultsDir, shot.overlay), animations: "disabled", caret: "hide" });
    await page.evaluate(`${checksScript()}\n;__fleetdQa.clearAnnotations()`);
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
