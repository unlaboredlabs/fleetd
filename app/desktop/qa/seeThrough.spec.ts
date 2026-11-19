// The Mac's see-through sidebar and the switch that turns it solid (Settings › You › General, ui/seeThrough.ts).
// QA has no Mac window to look through, so this runs on the stand-in platform.spec.ts uses for it (the dialog backdrop
// check): the page's data-vibrancy set, as main.tsx sets it on macOS, and the page shot with its background left out
// (omitBackground), so whatever the page leaves clear is where the window's material, and the desktop behind it, shows.
// On, the sidebar is clear, as today; off, every pixel of it is painted, in both themes, at once and after a reload.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launch, resultsDir, setView, settle, show } from "./harness.ts";
import { themes } from "./registry.ts";

// The fixtures' storefront chat, open, so the sidebar shows its selected row too.
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
// The window's material in each theme, under the clear sidebar, for the shots people look at: a desktop seen through it.
const MATERIAL = { light: 226, dark: 44 } as const;

const standIn = (page: Page) => page.evaluate(() => (document.documentElement.dataset["vibrancy"] = ""));

/** The page shot over the stand-in material, and how much of the sidebar the page left clear (0 to 1). */
async function seeThrough(page: Page, ground: number): Promise<{ clear: number; png: Buffer }> {
  await settle(page);
  const shot = await page.screenshot({ omitBackground: true, animations: "disabled", caret: "hide" });
  const { clear, b64 } = await page.evaluate(
    async ({ b64, ground }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bitmap, 0, 0);
      const k = bitmap.width / window.innerWidth;
      const r = document.getElementById("sidebar")?.getBoundingClientRect();
      if (!r) throw new Error("#sidebar is gone");
      const [x0, y0, x1, y1] = [r.left, r.top, r.right - 1, r.bottom].map((v) => Math.round(v * k)) as [number, number, number, number];
      const side = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let clear = 0;
      for (let i = 3; i < side.length; i += 4) if ((side[i] ?? 0) < 255) clear++;
      // The same shot over the material, as the window server would show it.
      const out = new OffscreenCanvas(bitmap.width, bitmap.height);
      const o = out.getContext("2d");
      if (!o) throw new Error("no 2d context");
      // A muted desktop under the material, so what shows through the sidebar reads in the shot.
      const desk = o.createLinearGradient(0, 0, out.width * 0.3, out.height);
      desk.addColorStop(0, `rgb(${ground - 30},${ground - 10},${ground + 10})`);
      desk.addColorStop(1, `rgb(${ground + 10},${ground - 20},${ground - 40})`);
      o.fillStyle = desk;
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(bitmap, 0, 0);
      const blob = await out.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const b of buf) bin += String.fromCharCode(b);
      return { clear: clear / (side.length / 4), b64: btoa(bin) };
    },
    { b64: shot.toString("base64"), ground },
  );
  return { clear, png: Buffer.from(b64, "base64") };
}

const toggle = (page: Page) => page.getByRole("switch", { name: "See-through sidebar" });

test("the see-through sidebar turns solid and back from Settings, in both themes, and stays as set", async () => {
  const { app, page, close } = await launch("typical");
  try {
    const dir = path.join(resultsDir, "png");
    mkdirSync(dir, { recursive: true });
    const save = (name: string, png: Buffer) => writeFileSync(path.join(dir, `see-through--${name}.png`), png);
    for (const theme of themes) {
      await setView(app, page, "large", theme);
      await show(page, "chat", CHAT);
      await standIn(page);

      const on = await seeThrough(page, MATERIAL[theme]);
      save(`on--${theme}`, on.png);
      expect(on.clear, `${theme}: with the switch on (the default), the sidebar is see-through`).toBeGreaterThan(0.5);

      await show(page, "settings.general", "#/settings/general");
      await expect(toggle(page)).toBeChecked();
      await toggle(page).click();
      await expect(toggle(page)).not.toBeChecked();
      save(`settings--${theme}`, (await seeThrough(page, MATERIAL[theme])).png);

      await show(page, "chat", CHAT);
      const off = await seeThrough(page, MATERIAL[theme]);
      save(`off--${theme}`, off.png);
      expect(off.clear, `${theme}: with the switch off, nothing of the desktop shows through the sidebar`).toBe(0);

      // A restart: the page starts again from the choice it kept.
      await page.reload();
      await show(page, "chat", CHAT);
      await standIn(page);
      expect((await seeThrough(page, MATERIAL[theme])).clear, `${theme}: the solid sidebar holds after a restart`).toBe(0);

      await show(page, "settings.general", "#/settings/general");
      await toggle(page).click();
      await expect(toggle(page)).toBeChecked();
      await show(page, "chat", CHAT);
      expect((await seeThrough(page, MATERIAL[theme])).clear, `${theme}: turned back on, the sidebar is see-through again`).toBeGreaterThan(0.5);
      await page.evaluate(() => delete document.documentElement.dataset["vibrancy"]);
    }
  } finally {
    await close();
  }
});
