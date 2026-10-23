// Platform bits the DOM checks can't see: bundled fonts, the macOS app menu, and a shot of the real window with
// its native traffic lights (a page screenshot leaves them out).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, pngSize, resultsDir, setNativeView, type Shot, settle, show } from "./harness.ts";
import { sizes, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-monospace", "ui-sans-serif"]);

test("every text face is a font the app bundles, never a system fallback", async () => {
  const { page, close } = await launch("typical");
  try {
    await show(page, "shell", "#/");
    const missing = await page.evaluate((generic) => {
      const loaded = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")));
      const used = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        const first = getComputedStyle(el).fontFamily.split(",")[0]?.trim().replace(/["']/g, "");
        if (first) used.add(first);
      }
      return [...used].filter((f) => !generic.includes(f) && !loaded.has(f));
    }, [...GENERIC_FAMILIES]);
    expect(missing, "font families used for text but not bundled and loaded").toEqual([]);
  } finally {
    await close();
  }
});

test("the macOS app menu has an Edit menu wired to the text actions", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  const { app, close } = await launch("typical");
  try {
    const roles = await app.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()?.items.find((i) => i.role?.toLowerCase() === "editmenu" || i.label === "Edit");
      return (edit?.submenu?.items ?? []).map((i) => i.role?.toLowerCase() ?? "");
    });
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"]) expect(roles).toContain(role);
  } finally {
    await close();
  }
});

test("the macOS window, traffic lights included, for the contact sheet", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  const { app, page, close } = await launch("typical");
  try {
    await show(page, "shell", "#/");
    const dir = path.join(resultsDir, "png");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(resultsDir, "shots"), { recursive: true });
    // A size every runner's screen holds (the smallest is 1024×768), shown as the real window lays it out: no
    // viewport override, which would lay out a wider page than the window and crop it.
    const size = "window";
    for (const theme of themes) {
      await setNativeView(app, page, size, theme);
      await settle(page);
      await page.waitForFunction((t) => document.documentElement.dataset["theme"] === t, theme, { timeout: 5_000 });
      const source = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? "");
      // "window:<CGWindowID>:0"
      const windowId = source.split(":")[1];
      if (!windowId) throw new Error(`no window id in "${source}"`);
      const file = path.join(resultsDir, "png", `window--typical--${size}--${theme}.png`);
      // screencapture takes what the window server last got from the window, which can be a frame from before the
      // theme switched: bring the window up, make it paint, and accept the picture only when its background
      // matches the theme.
      let luminance = -1;
      for (let attempt = 0; attempt < 3 && (luminance < 0 || luminance < 128 !== (theme === "dark")); attempt++) {
        await app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return;
          win.moveTop();
          win.webContents.invalidate();
          await win.webContents.capturePage();
        });
        await settle(page);
        try {
          execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, file]);
        } catch (error) {
          // Without the Screen Recording permission this is an extra picture lost, not a QA failure.
          test.skip(true, `screencapture failed: ${String(error)}`);
        }
        luminance = await app.evaluate(({ nativeImage }, f) => {
          // The median of a grid over the lower half: the page background, whatever panels sit on it.
          const image = nativeImage.createFromPath(f);
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          const samples: number[] = [];
          for (let gx = 1; gx < 10; gx++) {
            for (let gy = 5; gy < 10; gy++) {
              const i = (Math.floor((height * gy) / 10 - 1) * width + Math.floor((width * gx) / 10)) * 4;
              // BGRA
              samples.push(0.0722 * (bitmap[i] ?? 0) + 0.7152 * (bitmap[i + 1] ?? 0) + 0.2126 * (bitmap[i + 2] ?? 0));
            }
          }
          samples.sort((a, b) => a - b);
          return samples[Math.floor(samples.length / 2)] ?? -1;
        }, file);
      }
      expect(luminance < 128, `the ${theme} window shot's background has luminance ${Math.round(luminance)}`).toBe(theme === "dark");
      // screencapture writes at the display's own scale, whatever the app was told; the label says what the file is.
      const real = pngSize(file).width / sizes[size].width;
      expect(Number.isInteger(real) && pngSize(file).height === sizes[size].height * real, `window shot is ${JSON.stringify(pngSize(file))}`).toBe(true);
      const name = `window--typical--${size}--${theme}--darwin@${real}x`;
      const png = path.join("png", `${name}.png`);
      renameSync(file, path.join(resultsDir, png));
      const shot: Shot = { screen: "window", fixture: "typical", size, theme, scale: real, platform: "darwin", png, scrolled: [], findings: [] };
      writeFileSync(path.join(resultsDir, "shots", `${name}.json`), JSON.stringify(shot, null, 2));
    }
  } finally {
    await close();
  }
});

test("a window whose page dies reloads at its route and logs why; crash dumps go beside the log", async () => {
  const { app, page, close } = await launch("typical");
  try {
    await show(page, "status.fleet", "#/status");
    const { logs, dumps } = await app.evaluate(({ app: a }) => ({ logs: a.getPath("logs"), dumps: a.getPath("crashDumps") }));
    const log = () => (existsSync(path.join(logs, "app.log")) ? readFileSync(path.join(logs, "app.log"), "utf8") : "(no app.log)");
    // Playwright's page stays on the dead renderer, so the reloaded one is read through main. A MutationObserver,
    // not requestAnimationFrame, which a window in the background may never run. The renderer is killed rather than
    // crashed with forcefullyCrashRenderer: on the Linux runners that one logged "Crashing because hung" and then never
    // went (no render-process-gone), so the reload this checks never had a cause.
    const screen = await app
      .evaluate(async ({ BrowserWindow }) => {
        const page = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!page) throw new Error("the app opened no window");
        const within = <T,>(what: string, p: Promise<T>) =>
          Promise.race([p, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`no ${what} within 20 s`)), 20_000))]);
        const gone = new Promise((done) => page.once("render-process-gone", () => done(null)));
        const reloaded = new Promise((done) => page.once("did-finish-load", () => done(null)));
        process.kill(page.getOSProcessId(), "SIGKILL");
        await within("render-process-gone", gone);
        await within("reload", reloaded);
        return within(
          "status screen",
          page.executeJavaScript(
            `new Promise((done) => { const found = () => document.querySelector('[data-screen="status.fleet"]'); if (found()) return done("status.fleet"); new MutationObserver((_, o) => { if (found()) { o.disconnect(); done("status.fleet"); } }).observe(document, { subtree: true, childList: true, attributes: true }); })`,
          ) as Promise<string>,
        );
      })
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\napp.log:\n${log()}`);
      });
    expect(screen).toBe("status.fleet");
    expect(log()).toMatch(/main v\S+ #\/status: The window's page died \((?:crashed|killed), exit code -?\d+\); reloading it/u);
    // crashReporter is on, with its database beside the log (a killed renderer leaves no dump).
    expect(dumps).toBe(path.join(logs, "crashes"));
    expect(existsSync(path.join(dumps, "settings.dat"))).toBe(true);
  } finally {
    await close();
  }
});
