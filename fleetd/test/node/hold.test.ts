// `fleetd update-hold`: a held tool call waits while the hold lasts, marked held, and goes once it lapses or clears.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clear, held, hold, holdPath, hookCommand } from "../../src/node/hold.ts";

const SRC = join(import.meta.dir, "../../src/main.ts");

test("a held call waits, marked, until the hold clears; then nothing is held", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hold-"));
  try {
    hold(home);
    const hook = Bun.spawn([process.execPath, SRC, "update-hold", holdPath(home)], {
      stdin: new Blob([JSON.stringify({ tool_use_id: "toolu_01abc" })]),
      env: { ...process.env, FLEETD_HOME: home },
    });
    for (let i = 0; i < 50 && !held(home).has("toolu_01abc"); i++) await Bun.sleep(100);
    expect(held(home).has("toolu_01abc")).toBe(true);
    clear(home);
    expect(await hook.exited).toBe(0);
    expect(existsSync(holdPath(home))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without a hold the hook's shell test lets the call go at once", () => {
  const home = "/srv/it's here";
  expect(hookCommand("/opt/fleetd", home)).toBe(
    "test -e '/srv/it'\\''s here/update/hold' || exit 0; exec '/opt/fleetd' update-hold '/srv/it'\\''s here/update/hold'",
  );
});
