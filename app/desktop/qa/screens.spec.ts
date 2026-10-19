// One test per registered screen × fixture: every size and theme, screenshots kept, any DOM finding fails it.

import { expect, test } from "@playwright/test";
import { describeFindings, launch, reservedRegions, type Shot, setView, settle, shoot, show } from "./harness.ts";
import { screens, sizes, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

const only = process.env.QA_SCREENS?.split(",").filter(Boolean);

for (const screen of screens) {
  if (only && !only.includes(screen.id)) continue;
  for (const fixture of screen.fixtures) {
    test(`${screen.id} · ${fixture}`, async () => {
      const { app, page, close } = await launch(fixture);
      try {
        const reserved = await reservedRegions(app);
        const shots: Shot[] = [];
        // Shown once, then resized: a screen opened by an interaction stays open, as it would for a user.
        await show(page, screen.id, screen.route, screen.open);
        for (const size of screen.sizes ?? (Object.keys(sizes) as (keyof typeof sizes)[])) {
          for (const theme of themes) {
            await setView(app, page, size, theme);
            await settle(page);
            shots.push(await shoot(page, reserved, { screen: screen.id, fixture, size, theme }));
          }
        }
        const found = shots.reduce((n, s) => n + s.findings.length, 0);
        expect(found, `DOM findings (see the contact sheet):\n${describeFindings(shots)}`).toBe(0);
      } finally {
        await close();
      }
    });
  }
}
