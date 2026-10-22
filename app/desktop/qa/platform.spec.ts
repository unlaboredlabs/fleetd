// Platform bits the DOM checks can't see: bundled fonts, the macOS app menu, and a shot of the real window with
// its native traffic lights (a page screenshot leaves them out).

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, pngSize, resultsDir, setNativeView, type Shot, settle, show } from "./harness.ts";
import { platformChecks, sizes, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-monospace", "ui-sans-serif"]);

// On macOS the sans face is the system's own (tokens.css), named by the generic system-ui.
test("every text face is a font the app bundles or the system face, never a fallback", async () => {
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
  test.skip(process.platform !== "darwin" || !platformChecks.appMenu, "macOS only, on once F1's menu lands");
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
    // The largest QA size every runner's screen holds (the smallest is 1024×768), shown as the real window lays it
    // out: no viewport override, which would lay out a wider page than the window and crop it.
    const size = "small";
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
