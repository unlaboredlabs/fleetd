// One test per registered screen × fixture: every size and theme, screenshots kept, any DOM finding fails it.

import { expect, test } from "@playwright/test";
import { assertAlive, assertExpectedState, describeFindings, launch, type Launched, reservedRegions, type Shot, setView, shoot, show } from "./harness.ts";
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

// --shard gives each job an equal count of tests, a run of them in the order they are declared. In the registry's
// order neighbours are alike (a page's screens, a list's fixtures), so a run of them was all heavy or all light: the
// macOS shard 3/3 got every Settings and factory screen and ran past its 30 minutes, where 1/3 took 13. Declared at
// golden-ratio steps through the registry instead, any run of them, for any shard count, takes an even share of it.
const STEP = (Math.sqrt(5) - 1) / 2;
const cases = screens
  .filter((screen) => !only || only.includes(screen.id))
  .flatMap((screen) => screen.fixtures.map((fixture) => ({ screen, fixture })))
  .map((c, i) => ({ ...c, at: (i * STEP) % 1 }))
  .sort((a, b) => a.at - b.at);

for (const { screen, fixture } of cases) {
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
        // setView leaves the page settled at the size and theme.
        note(`${size} ${theme}: sizing and settling`);
        await setView(app, page, size, theme);
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
