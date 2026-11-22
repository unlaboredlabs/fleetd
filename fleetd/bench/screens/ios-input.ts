// A person's taps on an iOS simulator measured on the agents' Mac, through the node's own path (Hands and the live
// view's Shooter, src/node/device/ios/screen.ts): straight into the simulator through fleetd-frames, and through
// agent-device as before. Each tap is a press held 80 ms, timed from the press to the live view's first changed frame,
// on a switch in Settings › Search that flips at each tap. Prints one JSON line per way.
//
//   mac sim start; mac run -- 'cd fleetd && BUN_BE_BUN=1 ~/.fleetd/bin/fleetd bench/screens/ios-input.ts [taps]'
//
// It opens Settings › Search on the agent's simulator ($FLEETD_MAC_SIM in $FLEETD_MAC_SIM_SET) and taps where that
// switch sits on an iPhone 17 (1206×2622 at 3×). agent-device must be on the PATH, with a session open on the
// simulator (`agent-device open com.apple.Preferences`): the person's inputs go to the session holding it.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hands, type Runner, Shooter } from "../../src/node/device/ios/screen.ts";
import type { Frame, Input } from "../../src/node/device/scrcpy.ts";
import { stream } from "../../src/node/screen/mac_frames.ts";
import { round, spread } from "./meter.ts";

const sim = process.env.FLEETD_MAC_SIM;
const set = process.env.FLEETD_MAC_SIM_SET;
if (!sim || !set) throw new Error("no simulator: mac sim start first");
const taps = Number(process.argv[2] ?? 12);
const dir = join(process.env.TMPDIR ?? tmpdir(), "screens-bench");
const agentDevice = Bun.which("agent-device");
if (!agentDevice) throw new Error("no agent-device on the PATH");
const simctl = (...args: string[]) => Bun.spawn(["xcrun", "simctl", "--set", set, ...args], { stdout: "ignore", stderr: "ignore" }).exited;

// The switch, in the screen's pixels.
const at = { x: 1005, y: 1316 };

const frames: { at: number }[] = [];
const t0 = performance.now();
let ready: number | undefined;
const shooter = new Shooter(
  async () => new Uint8Array(0),
  t0,
  () => true,
  (_f: Frame) => frames.push({ at: performance.now() }),
  Bun.sleep,
  (onFrame) => stream(dir, ["sim", set, sim], onFrame),
);
shooter.run();
const first = async () => {
  while (!frames.length) await Bun.sleep(1);
  return performance.now() - t0;
};
const firstFrameMs = await first();
while (!shooter.direct() && performance.now() - t0 < 30_000) await Bun.sleep(2);
ready = shooter.direct() ? performance.now() - t0 : undefined;

const runner: Runner = { wrapper: agentDevice, env: process.env as Record<string, string>, udid: sim };

/** Waits until no frame came for `ms`. */
async function settle(ms = 700): Promise<void> {
  for (;;) {
    const last = frames.at(-1)?.at ?? 0;
    const wait = last + ms - performance.now();
    if (wait <= 0) return;
    await Bun.sleep(wait);
  }
}

async function bench(way: "direct" | "agent-device") {
  const commands: number[] = [];
  const hands = new Hands(runner, 3, (_args, ran, direct) => !direct && commands.push(ran.ms), undefined, way === "direct" ? () => shooter.direct() : () => undefined);
  const touch = (action: "down" | "up"): Input => ({ kind: "touch", action, ...at });
  const ms: number[] = [];
  for (let i = 0; i < taps; i++) {
    await settle();
    const n = frames.length;
    const pressed = performance.now();
    hands.send(touch("down"));
    await Bun.sleep(80);
    hands.send(touch("up"));
    while (frames.length === n && performance.now() - pressed < 5_000) await Bun.sleep(1);
    if (frames.length > n) ms.push(frames[n]!.at - pressed);
    await hands.idle();
  }
  return { way, tapToPixelMs: spread(ms.map((m) => Math.round(m))), each: ms.map((m) => round(m)), ...(commands.length ? { agentDeviceCommandMs: spread(commands) } : {}) };
}

await simctl("launch", sim, "com.apple.Preferences");
await Bun.sleep(1500);
console.log(JSON.stringify({ kind: "ios", startup: { firstFrameMs: round(firstFrameMs), inputReadyMs: ready === undefined ? null : round(ready) } }));
for (const way of ["direct", "agent-device"] as const) console.log(JSON.stringify({ kind: "ios", ...(await bench(way)) }));
shooter.stop();
process.exit(0);
