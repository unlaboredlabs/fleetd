// One test per registered screen × fixture: every size and theme, screenshots kept, any DOM finding fails it.

import { expect, test } from "@playwright/test";
import { assertAlive, assertExpectedState, describeFindings, launch, type Launched, reservedRegions, type Shot, setView, settle, shoot, show } from "./harness.ts";
import { defaultSizes, label, screens, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

// The app the running test launched. It closes after the test, not in it: a test that hits its timeout never runs
// its own finally, and a failed one keeps first what it is read by (its trace, last screenshots and log, in its
// test-results folder, which CI uploads), where a timeout said nothing of where it hung.
let running: Launched | undefined;
test.afterEach(async () => {
  const info = test.info();
  const launched = running;
  running = undefined;
  if (!launched) return;
  if (info.status !== info.expectedStatus) await launched.keep(info.outputPath("kept"));
  await launched.close();
});

const only = process.env.QA_SCREENS?.split(",").filter(Boolean);

for (const screen of screens) {
  if (only && !only.includes(screen.id)) continue;
  for (const fixture of screen.fixtures) {
    test(`${label(screen)} · ${fixture}`, async () => {
      running = await launch(fixture, undefined, { realClock: screen.realClock === true, trace: true });
      const { app, page, settled, replay, errors, note } = running;
      const reserved = screen.frameless ? [] : await reservedRegions(app);
      const shots: Shot[] = [];
      const shotSizes = screen.sizes ?? defaultSizes;
      // Shown once, at the first size it is shot at (the sidebar hides itself in a narrow window), then resized: a
      // screen opened by an interaction stays open, as it would for a user.
      note("waiting for the fixture to settle");
      await settled();
      note(`opening at ${shotSizes[0] ?? "small"}`);
      await setView(app, page, shotSizes[0] ?? "small", themes[0]);
      const { open } = screen;
      // A blank window never shows the screen, so say that rather than time out waiting for it.
      const up = async () => {
        await show(page, screen.id, screen.route, open && ((p) => open(p, app))).catch(async (error: unknown) => {
          await assertAlive(page, screen, errors);
          throw error;
        });
        await assertAlive(page, screen, errors);
      };
      await up();
      if (screen.replay) {
        await replay();
        await up();
      }
      await assertExpectedState(page, screen);
      for (const size of shotSizes) {
        for (const theme of themes) {
          note(`${size} ${theme}: sizing`);
          await setView(app, page, size, theme);
          note(`${size} ${theme}: settling`);
          await settle(page);
          await screen.check?.(page);
          // Scrolling doesn't depend on the theme, so the steps run once per size.
          const meta = { screen: label(screen), fixture, size, theme };
          note(`${size} ${theme}: shooting`);
          shots.push(await shoot(page, reserved, meta, { scroll: theme === themes[0] }));
        }
      }
      note("done");
      const found = shots.reduce((n, s) => n + s.findings.length, 0);
      expect(found, `DOM findings (see the contact sheet):\n${describeFindings(shots)}`).toBe(0);
    });
  }
}
