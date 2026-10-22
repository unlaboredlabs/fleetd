// One test per registered screen × fixture: every size and theme, screenshots kept, any DOM finding fails it.

import { expect, test } from "@playwright/test";
import { assertExpectedState, describeFindings, launch, reservedRegions, type Shot, setView, settle, shoot, show } from "./harness.ts";
import { defaultSizes, label, screens, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

const only = process.env.QA_SCREENS?.split(",").filter(Boolean);

for (const screen of screens) {
  if (only && !only.includes(screen.id)) continue;
  for (const fixture of screen.fixtures) {
    test(`${label(screen)} · ${fixture}`, async () => {
      test.fixme(screen.pending !== undefined, screen.pending);
      const { app, page, settled, close } = await launch(fixture);
      try {
        const reserved = await reservedRegions(app);
        const shots: Shot[] = [];
        const shotSizes = screen.sizes ?? defaultSizes;
        // Shown once, at the first size it is shot at (the sidebar hides itself in a narrow window), then resized: a
        // screen opened by an interaction stays open, as it would for a user.
        await settled();
        await setView(app, page, shotSizes[0] ?? "small", themes[0]);
        const { open } = screen;
        await show(page, screen.id, screen.route, open && ((p) => open(p, app)));
        await assertExpectedState(page, screen);
        for (const size of shotSizes) {
          for (const theme of themes) {
            await setView(app, page, size, theme);
            await settle(page);
            // Scrolling doesn't depend on the theme, so the steps run once per size.
            const meta = { screen: label(screen), fixture, size, theme };
            shots.push(await shoot(page, reserved, meta, { scroll: theme === themes[0] }));
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
