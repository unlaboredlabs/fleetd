// Writes the site's fixture shots (site.ts) into site/. Run through `pnpm site:shots`, which sets the 2x scale and
// points the harness at fixtures/recorded.
import path from "node:path";
import { test } from "@playwright/test";
import { desktopDir, launch, setView, show } from "./harness.ts";
import { type FixtureName, screens } from "./registry.ts";
import { siteShots } from "./site.ts";

const site = path.resolve(desktopDir, "../../site");
const only = process.env["SITE_SHOTS"]?.split(",");

for (const shot of siteShots.filter((s) => only === undefined || only.includes(s.file))) {
  test(shot.file, async () => {
    const entry = screens.find((s) => s.id === shot.screen);
    if (!entry) throw new Error(`${shot.screen} isn't a screen in qa/registry.ts`);
    // A recording isn't one of the gate's fixture names; the loader takes any file in the fixture directory.
    const { app, page, settled, close } = await launch(shot.recording as FixtureName);
    try {
      await setView(app, page, "medium", "light");
      await show(page, entry.id, shot.route ?? entry.route, entry.open);
      await settled();
      // The fixture banner keeps sample data from passing for a live hub inside the app; on the site the caption
      // says what the picture is.
      await page.getByRole("status").filter({ hasText: "Sample data, not connected" }).evaluate((el) => el.remove());
      await page.screenshot({ path: path.join(site, shot.file), animations: "disabled", caret: "hide" });
    } finally {
      await close();
    }
  });
}
