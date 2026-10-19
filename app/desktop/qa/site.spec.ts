// Writes the site's fixture shots (site.ts) into site/. Run through `pnpm site:shots`, which sets the 2x scale.
import path from "node:path";
import { test } from "@playwright/test";
import { desktopDir, launch, setView, show } from "./harness.ts";
import { type FixtureName, screens } from "./registry.ts";
import { siteShots } from "./site.ts";

const site = path.resolve(desktopDir, "../../site");
const only = process.env["SITE_SHOTS"]?.split(",");

for (const shot of siteShots.filter((s) => only === undefined || only.includes(s.file))) {
  test(shot.file, async () => {
    const entry = screens.find((s) => s.id === shot.screen && s.fixtures.some((f) => f === shot.fixture));
    if (!entry) throw new Error(`${shot.screen} × ${shot.fixture} isn't registered in qa/registry.ts`);
    const { app, page, settled, close } = await launch(shot.fixture as FixtureName);
    try {
      await setView(app, page, "medium", "light");
      await show(page, entry.id, entry.route, entry.open);
      await settled();
      // The fixture banner keeps sample data from passing for a live hub inside the app; on the site the caption
      // says what the picture is.
      // By CSS, not role: an open sheet hides the page behind it from the accessibility tree.
      await page.locator('[role="status"]', { hasText: "Sample data, not connected" }).evaluateAll((els) => {
        for (const el of els) el.remove();
      });
      await page.screenshot({ path: path.join(site, shot.file), animations: "disabled", caret: "hide" });
    } finally {
      await close();
    }
  });
}
