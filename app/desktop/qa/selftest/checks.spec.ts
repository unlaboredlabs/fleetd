// The DOM checks against planted violations in a real Electron window: each one must be reported, and clean text
// (wrapped, ellipsized, clamped, code, scrolling lists) must not be.

import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { CheckId } from "../dom/allowlist.ts";
import { assertExpectedState, check, type Launched, launch, pngSize, resultsDir, scale, setView, shoot, show } from "../harness.ts";
import { readShots } from "../report.ts";
import { sizes, themes } from "../registry.ts";

const standIn = path.join(import.meta.dirname, "app", "main.js");

test.describe.configure({ mode: "serial" });

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch(undefined, standIn);
});
test.afterAll(async () => {
  await launched.close();
});

const checkFor: Record<string, CheckId> = { overflow: "overflow", overlap: "overlap", edge: "edge", raw: "raw-text", drag: "drag" };

test("every planted violation is reported, and nothing else", async () => {
  const { app, page } = launched;
  await setView(app, page, "medium", "light");
  await show(page, "bad", "#/bad");
  const inView = await check(page, []);
  expect(inView.some((f) => f.where.includes("exp-overlap-scrolled")), "below the fold, before scrolling").toBe(false);

  // shoot() checks the view, then steps the scroll containers and checks again at each step.
  const shot = await shoot(page, [], { screen: "bad", fixture: "empty", size: "medium", theme: "light" });
  const findings = shot.findings;
  const planted = await page
    .locator("[data-testid^='exp-']")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
  // exp-<check>-<case>[-<part>]: an overlap's two parts share one case.
  const cases = new Set(planted.map((id) => id.split("-").slice(0, 3).join("-")));
  for (const id of cases) {
    const kind = checkFor[id.split("-")[1] ?? ""];
    const hit = findings.some((f) => f.check === kind && f.where.includes(`data-testid=${id}`));
    expect(hit, `${id} should be reported as ${String(kind)}; got:\n${JSON.stringify(findings, null, 1)}`).toBe(true);
  }
  const stray = findings.filter((f) => !f.where.includes("data-testid=exp-"));
  expect(stray, "findings on elements that were not planted").toEqual([]);

  // The findings reach the shot record, the annotated screenshots and the report.
  expect(shot.overlay && existsSync(path.join(resultsDir, shot.overlay))).toBe(true);
  expect(shot.scrolled.some((s) => s.png.endsWith(".findings.png") && existsSync(path.join(resultsDir, s.png)))).toBe(true);
  expect(readShots().map((s) => s.screen)).toContain("bad");
  expect(await page.locator("#fleetd-qa-overlay").count(), "the overlay is removed after its screenshot").toBe(0);
});

for (const route of ["#/", "#/good"]) {
  test(`clean text has no findings (${route}) at every size and theme`, async () => {
    const { app, page } = launched;
    for (const size of Object.keys(sizes) as (keyof typeof sizes)[]) {
      for (const theme of themes) {
        await setView(app, page, size, theme);
        const screen = route === "#/" ? "shell" : "good";
        await show(page, screen, route);
        const shot = await shoot(page, [], { screen, fixture: "empty", size, theme });
        expect(shot.findings, `${route} ${size} ${theme}, scroll steps included`).toEqual([]);
      }
    }
  });
}

test("a screen brought up by an interaction is shown and checked", async () => {
  const { app, page } = launched;
  await setView(app, page, "small", "dark");
  await show(page, "palette", "#/", (p) => p.keyboard.press("ControlOrMeta+K"));
  expect(await check(page, [])).toEqual([]);
});

test("a route landing on a not-found state fails unless the entry expects it", async () => {
  const { app, page } = launched;
  await setView(app, page, "medium", "light");
  await show(page, "order", "#/order/W2");
  await expect(assertExpectedState(page, { id: "order" })).rejects.toThrow(/order\.not-found/);
  await assertExpectedState(page, { id: "order", expect: "error" });
  await show(page, "good", "#/good");
  await assertExpectedState(page, { id: "good" });
  await expect(assertExpectedState(page, { id: "good", expect: "error" })).rejects.toThrow(/expects an error/);
});

test("screenshots are the viewport times the scale, at every size", async () => {
  const { app, page } = launched;
  for (const size of Object.keys(sizes) as (keyof typeof sizes)[]) {
    await setView(app, page, size, "light");
    await show(page, "shell", "#/");
    const shot = await shoot(page, [], { screen: "scale", fixture: "empty", size, theme: "light" }, { scroll: false });
    expect(pngSize(path.join(resultsDir, shot.png))).toEqual({ width: sizes[size].width * scale, height: sizes[size].height * scale });
  }
});

test("a native resize after setView doesn't change what is checked and shot", async () => {
  const { app, page } = launched;
  await setView(app, page, "medium", "light");
  await show(page, "shell", "#/");
  // What macOS does when it clamps an oversized window: the native size changes under the viewport override, and
  // lands with the next frame (here a throwaway screenshot), knocking the page off its set size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 720));
  await page.screenshot();
  expect(await page.evaluate(() => window.innerWidth)).toBe(1100);
  const shot = await shoot(page, [], { screen: "resized", fixture: "empty", size: "medium", theme: "light" }, { scroll: false });
  expect(pngSize(path.join(resultsDir, shot.png))).toEqual({ width: sizes.medium.width * scale, height: sizes.medium.height * scale });
  expect(await page.evaluate(() => window.innerWidth)).toBe(sizes.medium.width);
});

test("content under the macOS window controls is reported", async () => {
  const { app, page } = launched;
  await setView(app, page, "medium", "light");
  await show(page, "shell", "#/");
  const findings = await check(page, [{ x: 0, y: 0, width: 400, height: 80 }]);
  expect(findings.map((f) => f.message)).toContain("content sits under the window controls");
});
