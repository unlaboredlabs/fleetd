// Platform bits the DOM checks can't see: bundled fonts, the macOS app menu, and a shot of the real window with
// its native traffic lights (a page screenshot leaves them out).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, resultsDir, scale, setView, type Shot, settle, show } from "./harness.ts";
import { platformChecks, themes } from "./registry.ts";

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
    for (const theme of themes) {
      await setView(app, page, "medium", theme);
      await settle(page);
      const source = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? "");
      // "window:<CGWindowID>:0"
      const windowId = source.split(":")[1];
      if (!windowId) throw new Error(`no window id in "${source}"`);
      const name = `window--typical--medium--${theme}--darwin@${scale}x`;
      const png = path.join("png", `${name}.png`);
      try {
        execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, path.join(resultsDir, png)]);
      } catch (error) {
        // Without the Screen Recording permission this is an extra picture lost, not a QA failure.
        test.skip(true, `screencapture failed: ${String(error)}`);
      }
      const shot: Shot = { screen: "window", fixture: "typical", size: "medium", theme, scale, platform: "darwin", png, scrolled: [], findings: [] };
      writeFileSync(path.join(resultsDir, "shots", `${name}.json`), JSON.stringify(shot, null, 2));
    }
  } finally {
    await close();
  }
});
