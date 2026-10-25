// Writes the site's fixture shots (site.ts) into the repo. Run through `pnpm site:shots`, which sets the 2x scale.
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { desktopDir, launch, settle, setView, show } from "./harness.ts";
import { type FixtureName, screens } from "./registry.ts";
import { siteShots } from "./site.ts";

const repo = path.resolve(desktopDir, "../..");

const hideByClass = async (page: Page, selector: string, text: string, how: "display: none" | "visibility: hidden") => {
  const target = page.locator(selector, { hasText: text }).first();
  await target.waitFor({ state: "attached", timeout: 10_000 });
  const rule = await target.evaluate((el) => [...el.classList].map((c) => `.${CSS.escape(c)}`).join(""));
  if (rule === "") throw new Error(`"${text}" has no class to hide it by`);
  await page.addStyleTag({ content: `${rule} { ${how} !important; }` });
};

const only = process.env["SITE_SHOTS"]?.split(",");

for (const shot of siteShots.filter((s) => only === undefined || only.includes(s.file))) {
  test(shot.file, async () => {
    const entry = screens.find((s) => s.id === shot.screen && s.variant === shot.variant && s.fixtures.some((f) => f === shot.fixture));
    if (!entry) throw new Error(`${shot.screen}${shot.variant === undefined ? "" : `~${shot.variant}`} × ${shot.fixture} isn't registered in qa/registry.ts`);
    const { app, page, settled, close } = await launch(shot.fixture as FixtureName);
    try {
      await setView(app, page, "medium", "light");
      const { open } = entry;
      await show(page, entry.id, entry.route, open && ((p) => open(p, app)));
      await settled();
      // The fixture chrome (the banner, and the sidebar's "Sample data" chip) keeps sample data from passing
      // for a live hub inside the app; on the site the caption says what the picture is. Hidden by a stylesheet rule on
      // each one's class, so a re-render can't bring it back; found by CSS, since an open sheet hides the page from the
      // accessibility tree.
      // The banner takes its row with it; the sidebar chip keeps its place.
      await hideByClass(page, '[role="status"]', "Sample data, not connected", "display: none");
      await hideByClass(page, "[data-hub-status]", "Sample data", "visibility: hidden");
      await settle(page);
      await page.screenshot({ path: path.join(repo, shot.file), animations: "disabled", caret: "hide" });
    } finally {
      await close();
    }
  });
}
