// The agents' Mac's screens measured on the Mac: its own display and an iOS simulator, as the node reads them today
// (a ScreenCaptureKit screenshot or `simctl io screenshot` per frame, then JPEG) and as fleetd-frames does
// (src/node/screen: read when it changes, JPEG or the Mac's hardware H.264). Prints one JSON line per way.
//
//   mac run -- 'cd fleetd && BUN_BE_BUN=1 ~/.fleetd/bin/fleetd bench/screens/mac.ts [sim] [--fps N]'
//
// `--fps` is the H.264 frame rate at most (the node's is 60, VideoToolbox's: src/node/screen/live.ts HARDWARE_FPS).
// With `sim`, the simulator is the agent's own (`mac sim start`: $FLEETD_MAC_SIM in $FLEETD_MAC_SIM_SET). The Mac's
// display changes while measured only if something moves on it; a simulator's shows a moving page in Safari.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureHelper, type MacFrame, MacFrames } from "../../src/node/screen/mac_frames.ts";
import { round, spread } from "./meter.ts";

const which = process.argv[2] === "sim" ? "sim" : "screen";
const sim = process.env.FLEETD_MAC_SIM;
const set = process.env.FLEETD_MAC_SIM_SET;
if (which === "sim" && (!sim || !set)) throw new Error("no simulator: mac sim start first");
const dir = join(process.env.TMPDIR ?? tmpdir(), "screens-bench");
const fpsAt = process.argv.indexOf("--fps");
const h264Fps = fpsAt < 0 ? undefined : Number(process.argv[fpsAt + 1]);

/** CPU of `pids` and their children, in ms, by ps (macOS has no /proc). */
async function cpuMs(pids: number[]): Promise<number> {
  if (!pids.length) return 0;
  const p = Bun.spawn(["ps", "-o", "time=", "-p", pids.join(",")], { stdout: "pipe" });
  const text = await new Response(p.stdout).text();
  let ms = 0;
  for (const line of text.trim().split("\n")) {
    const m = line.trim().match(/^(?:(\d+):)?(\d+)\.(\d+)$/);
    if (m) ms += (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number(m[3]!.padEnd(2, "0").slice(0, 2)) * 10;
  }
  return ms;
}

const simctl = (...args: string[]) => Bun.spawn(["xcrun", "simctl", "--set", set!, ...args], { stdout: "ignore", stderr: "ignore" }).exited;

/** A page whose boxes move without end, served here and opened in the simulator's Safari: something always changing
 * on its screen. */
const page = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(
      `<meta name=viewport content="width=device-width"><body style="margin:0"><canvas id=c width=400 height=800></canvas><script>
const c=document.getElementById('c').getContext('2d');const f=t=>{c.fillStyle='#fff';c.fillRect(0,0,400,800);c.fillStyle='#c33';
for(let i=0;i<12;i++)c.fillRect((t/4+i*37)%400,(i*61+t/7)%800,50,50);requestAnimationFrame(f)};requestAnimationFrame(f)</script>`,
      { headers: { "content-type": "text/html" } },
    ),
});

/** Something moving on the screen for `ms`: on a simulator, the moving page (its callers open Settings, still, after). */
async function motion(ms: number): Promise<void> {
  if (which !== "sim") return void (await Bun.sleep(ms));
  await simctl("openurl", sim!, `http://127.0.0.1:${page.port}/`);
  await Bun.sleep(1000);
  await Bun.sleep(ms);
}

async function helper(kind: "jpeg" | "h264") {
  const t0 = performance.now();
  const bin = await ensureHelper(dir);
  const tBuilt = performance.now();
  const frames: { at: number; bytes: number; key: boolean }[] = [];
  let first: MacFrame | undefined;
  const h = new MacFrames(bin, which === "sim" ? ["sim", set!, sim!] : ["screen"], (f) => {
    first ??= f;
    frames.push({ at: performance.now(), bytes: f.data.length, key: f.key });
  });
  h.tell(kind);
  if (kind === "h264" && h264Fps !== undefined) h.tell(`fps ${h264Fps}`);
  const pid = (h as unknown as { proc: { pid: number } }).proc.pid;
  while (!first && performance.now() - tBuilt < 10_000) await Bun.sleep(5);
  const tFirst = performance.now();
  await Bun.sleep(1500);
  let from = performance.now();
  let cpu0 = await cpuMs([pid]);
  await Bun.sleep(4000);
  const idleSecs = (performance.now() - from) / 1000;
  const idle = frames.filter((f) => f.at >= from);
  const idleCpu = ((await cpuMs([pid])) - cpu0) / 10 / idleSecs;
  from = performance.now();
  cpu0 = await cpuMs([pid]);
  await motion(5000);
  const activeSecs = (performance.now() - from) / 1000;
  const active = frames.filter((f) => f.at >= from);
  const activeCpu = ((await cpuMs([pid])) - cpu0) / 10 / activeSecs;
  // A still on demand, as a new watcher asks: how soon it comes.
  const stills: number[] = [];
  for (let i = 0; i < 5; i++) {
    const n = frames.length;
    const at = performance.now();
    h.tell("still");
    while (frames.length === n && performance.now() - at < 2000) await Bun.sleep(1);
    stills.push(performance.now() - at);
    await Bun.sleep(200);
  }
  h.stop();
  if (which === "sim") await simctl("launch", sim!, "com.apple.Preferences");
  await Bun.sleep(1500);
  const bytes = (fs: typeof frames, secs: number) => round(fs.reduce((n, f) => n + f.bytes, 0) / secs);
  return {
    way: `fleetd-frames ${kind}${kind === "h264" && h264Fps !== undefined ? ` at ${h264Fps} fps` : ""}`,
    screen: first?.screen,
    picture: first?.picture,
    startup: { buildMs: round(tBuilt - t0), firstFrameMs: round(tFirst - tBuilt) },
    idle: { fps: round(idle.length / idleSecs, 1), bytesPerSec: bytes(idle, idleSecs), cpu: round(idleCpu, 1) },
    active: { fps: round(active.length / activeSecs, 1), kbPerFrame: round(active.reduce((n, f) => n + f.bytes, 0) / Math.max(active.length, 1) / 1024, 1), bytesPerSec: bytes(active, activeSecs), cpu: round(activeCpu, 1), cpuMsPerFrame: round((activeCpu * 10) / Math.max(active.length / activeSecs, 0.1), 2) },
    stillMs: spread(stills),
  };
}

/** Today's live view of a simulator: `simctl io screenshot` in a loop, a frame each 100 ms at most. */
async function screenshots() {
  const frames: { at: number; bytes: number }[] = [];
  const to = join(dir, "shot.jpg");
  let going = true;
  const loop = (async () => {
    while (going) {
      const began = performance.now();
      await simctl("io", sim!, "screenshot", "--type=jpeg", to);
      frames.push({ at: performance.now(), bytes: Bun.file(to).size });
      await Bun.sleep(Math.max(0, 100 - (performance.now() - began)));
    }
  })();
  await Bun.sleep(1000);
  const from = performance.now();
  await motion(5000);
  const secs = (performance.now() - from) / 1000;
  going = false;
  await loop;
  const active = frames.filter((f) => f.at >= from);
  return { way: "simctl screenshots", active: { fps: round(active.length / secs, 1), kbPerFrame: round(active.reduce((n, f) => n + f.bytes, 0) / Math.max(active.length, 1) / 1024, 1), bytesPerSec: round(active.reduce((n, f) => n + f.bytes, 0) / secs) } };
}

if (which === "sim") {
  await simctl("launch", sim!, "com.apple.Preferences");
  console.log(JSON.stringify({ kind: "ios", ...(await screenshots()) }));
  await simctl("launch", sim!, "com.apple.Preferences");
  await Bun.sleep(1500);
}
for (const kind of ["jpeg", "h264"] as const) console.log(JSON.stringify({ kind: which === "sim" ? "ios" : "mac", ...(await helper(kind)) }));
process.exit(0);
