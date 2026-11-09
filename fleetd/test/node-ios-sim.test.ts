// The agents' Mac's iOS simulators on a real one (mac.yml's `ios simulators`): the node makes its golden (a settling
// boot and agent-device's runner built with xcodebuild), the warm pool boots a clone and has agent-device start its
// XCTest runner on it, `mac sim start` lends it with the agent's jobs pointed at it, and `mac sim end` deletes it. Only
// on macOS with Xcode, and only when FLEETD_TEST_IOS_HOME names the node home to make them in; node-ios's tests cover
// the same code against a stand-in xcrun everywhere, the pool's refills among it.
//
// What the agent then does with agent-device (open, snapshot, screenshot) is agent-device's, and isn't run here: on
// GitHub's 3-vCPU Mac VM those commands ran past agent-device's own fixed limits (its 90 s daemon request, a
// screenshot's 15 s xcrun) in 4 of 5 runs (Nov 2026), while every step of fleetd's above held.
//
// Setup takes minutes, and longer on a busy CI runner, so the test waits on setup itself (the golden's prepare, the
// pool's boot, a clone's deletion), never a short timeout of its own: the job's timeout bounds it.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LENT, sessionDir } from "../src/node/device/agent_device.ts";
import { Simulators } from "../src/node/device/ios/index.ts";
import { MacSims, simConfig, simKey } from "../src/node/device/ios/sims.ts";
import { binDir } from "../src/node/device/ios/wrapper.ts";

const HOME = process.env.FLEETD_TEST_IOS_HOME;
const run = process.platform === "darwin" && HOME !== undefined;
/** Under mac.yml's 80-minute job: a golden took 5-25 minutes on GitHub's 3-vCPU Mac VM (Nov 2026). */
const WHOLE = 75 * 60_000;

let sims: MacSims | undefined;
afterAll(async () => {
  await sims?.shutdown();
});

const since = (t: number) => `${Math.round(performance.now() - t)} ms`;

/** `mac sim start` as the agent's waiting one does: asked again while it is queued, until its simulator is lent. */
async function simStart(agent: string): Promise<{ udid: string; device: string }> {
  for (;;) {
    const got = await sims!.start({ name: agent, project: "p1" }, undefined, true);
    if (got.step === "sim_start") return got;
    await Bun.sleep(1_000);
  }
}

/** A shell command in the agent's job, with what MacSims points it at, as mac_tool's jobEnv does. */
async function job(agent: string, script: string): Promise<string> {
  const env: Record<string, string> = { HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" };
  for (const [k, v] of sims!.env(agent, process.env.PATH) ?? []) env[k] = v;
  const proc = Bun.spawn(["/bin/sh", "-c", script], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return `${out}${err}`;
}

async function gone(simulators: Simulators, udid: string): Promise<void> {
  while ((await simulators.simctl.devices()).some((d) => d.udid === udid)) await Bun.sleep(1_000);
}

test.skipIf(!run)(
  "the Mac makes its golden, mac sim start lends a booted clone with agent-device's runner started, and mac sim end deletes it",
  async () => {
    const home = HOME!;
    mkdirSync(home, { recursive: true });
    const simulators = new Simulators(home, { enabled: true });
    sims = new MacSims(home, simulators, 1);

    let t = performance.now();
    await simulators.start();
    while (simulators.health()?.state === "preparing") await Bun.sleep(1_000);
    expect(simulators.health()).toMatchObject({ state: "ready" });
    console.info(`the golden, made: ${since(t)}; ${simulators.health()?.message}`);

    t = performance.now();
    const lent = await simStart("T1");
    console.info(`mac sim start, the pool's first clone: ${since(t)} (${lent.device})`);
    // One simulator at a time on GitHub's 3-vCPU Mac VM: draining the pool stops its refill; the lent clone stays.
    await simulators.shutdown();
    expect((await simulators.simctl.devices()).find((d) => d.udid === lent.udid)?.state).toBe("Booted");
    // The pool had agent-device start the clone's XCTest runner, and its daemon keeps it up for the agent.
    const clone = sims.held.get("T1")!.lent;
    expect(clone.runner).toBe(true);
    expect(clone.runnerUp()).toBe(true);

    // The agent's jobs: agent-device is the iOS wrapper, its config names the clone and its commands go to the clone's
    // own agent-device home, where that runner runs; plain simctl reaches the clone in the node's own set.
    expect((await job("T1", "command -v agent-device")).trim()).toBe(join(binDir(home), "agent-device"));
    expect(JSON.parse(readFileSync(simConfig(home, "T1"), "utf8"))).toEqual({ platform: "ios", udid: lent.udid });
    expect(readFileSync(join(sessionDir(home, simKey("T1")), LENT), "utf8")).toBe(clone.home);
    expect(await job("T1", 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" list devices | grep "$FLEETD_MAC_SIM"')).toContain("(Booted)");

    t = performance.now();
    expect(sims.end("T1")).toBe(true);
    await gone(simulators, lent.udid);
    console.info(`mac sim end, the clone deleted: ${since(t)}`);
    expect(clone.runnerUp()).toBe(false);
  },
  WHOLE,
);
