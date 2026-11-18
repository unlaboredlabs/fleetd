// `fleetd update-hold`: a held tool call waits while the hold lasts, marked held, and goes once it lapses or clears.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const canUnshare = process.platform === "linux" && Bun.spawnSync(["unshare", "-rm", "true"], { stdout: "ignore", stderr: "ignore" }).success;

// A VM's view binds update/held at its boot and keeps that bind through node restarts: every way the node ends a hold
// must empty the dir in place, or the VM's marks land on a removed dir (read-only to it) and each update's drain
// waits out its 10 minutes.
test.skipIf(!canUnshare)("each way the node ends a hold keeps update/held in place, so a VM's bind of it still marks calls held", async () => {
  const { clearHold } = await import("../../src/node/index.ts");
  const { holdForScreens, releaseScreens } = await import("../../src/node/restart.ts");
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-held-bind-"));
  try {
    const dir = join(home, "update", "held");
    mkdirSync(dir, { recursive: true });
    const view = join(home, "view");
    mkdirSync(view);
    // The VM's side: held bound as its view binds it, marking a call held through the bind on each line it reads.
    const box = Bun.spawn(["unshare", "-rm", "sh", "-c", `mount --bind '${dir}' '${view}' && echo ready && while read id; do touch '${view}'/"$id" && echo marked; done`], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const out = box.stdout.getReader();
    const line = async () => new TextDecoder().decode((await out.read()).value);
    expect(await line()).toContain("ready");
    const mark = async (id: string) => {
      box.stdin.write(`${id}\n`);
      await box.stdin.flush();
      expect(await line()).toContain("marked");
      expect(existsSync(join(dir, id))).toBe(true);
    };
    try {
      await mark("tu_1");
      // The node's start ends the last node's hold.
      clearHold(home);
      expect(held(home).size).toBe(0);
      await mark("tu_2");
      // A screens restart's hold, and its release.
      holdForScreens(home);
      releaseScreens(home);
      await mark("tu_3");
      // hold.ts's own clear.
      hold(home);
      clear(home);
      await mark("tu_4");
    } finally {
      box.kill();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
