// The Bun node's Android sessions, against stand-ins: shell scripts in place of adb, the emulator and ffmpeg, and a
// local socket in place of scrcpy's server. Nothing here starts a real emulator.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { broker, start as startBrowser } from "../src/node/browser/index.ts";
import { type DeviceCall, type DeviceDone, openDone, PIECE, sealCall, Work } from "../src/node/device/work.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { Router, start as startRoute } from "../src/node/session_route/index.ts";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { agentEnv, controlPath, daemonPid, findAgentDevice, homeOf, LENT, makePlugin, PAUSED, release, sessionDir, VERSION, wrapperScript, writeConfig, entry, binDir } from "../src/node/device/agent_device.ts";
import { emulatorArgs, emulatorCommand, freePort, isLeftover } from "../src/node/device/emulator.ts";
import { capabilities, health, start as startDevices } from "../src/node/device/index.ts";
import { forget, start as startHosts } from "../src/node/hosts/index.ts";
import { deviceInput, Pump } from "../src/node/device/live.ts";
import { router } from "../src/node/device/router.ts";
import { Jpegs, keycode, messages, metaState, Packets, serverArgs } from "../src/node/device/scrcpy.ts";
import { stillArgs } from "../src/node/device/scrcpy_wire.ts";
import { AVD, findSdk, kvmAt, markers, packageUrls, PINS, quoted, SCRCPY_VERSION, sdkAt, writeAvd } from "../src/node/device/sdk.ts";
import { PASSTHROUGH_KBPS, recordingsDir } from "../src/node/device/session.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const until = async (what: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

/** scrcpy's video socket, as the node's own stream asks for it (serverArgs(…, true)): the codec's id, the encoder's
 * size, then each packet after its header (64 bits of time and flags, 32 of length). */
const H264_ID = [0x68, 0x32, 0x36, 0x34];
const sizeMeta = (w: number, h: number) => { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setUint32(0, 0x8000_0000); v.setUint32(4, w); v.setUint32(8, h); return [...b]; };
const packet = (kind: "config" | "key" | "delta", data: number[]) => {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  v.setUint32(0, kind === "config" ? 0x4000_0000 : kind === "key" ? 0x2000_0000 : 0);
  v.setUint32(4, 1234);
  v.setUint32(8, data.length);
  return [...b, ...data];
};
const CONFIG = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x29, 0, 0, 0, 1, 0x68, 0xce, 0x01];
const IDR = [0, 0, 0, 1, 0x65, 0x88, 0x84];
const P = [0, 0, 0, 1, 0x41, 0x9a];

/** A minimal JPEG: SOI, an APP0 segment, SOF0 with height 1280 and width 576, then EOI. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x00, 0x02, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

test("kvm says what is wrong and how to fix it", () => {
  const home = tempHome();
  cleanups.push(home.done);
  const never = () => false;
  const none = kvmAt(join(home.dir, "kvm"), join(home.dir, "group"), never);
  expect("err" in none && none.err.why).toContain("no /dev/kvm");
  const dev = join(home.dir, "kvm");
  writeFileSync(dev, "");
  chmodSync(dev, 0o000);
  if (process.getuid?.() === 0) return; // root opens anything
  const user = process.env.USER || "$USER";
  const group = join(home.dir, "group");
  writeFileSync(group, "kvm:x:992:\n");
  // Not in the group: adding them is all it takes, never a restart that stops the agents.
  const out = kvmAt(dev, group, () => true);
  expect("err" in out && out.err).toEqual({ why: expect.stringContaining("no restart"), fix: `sudo usermod -aG kvm ${user}` });
  // Joined since the node started: `sg kvm` starts the emulator with the group.
  writeFileSync(group, `kvm:x:992:other,${user}\n`);
  expect(kvmAt(dev, group, () => true)).toEqual({ ok: "sg" });
  // Where sg can't, only a reboot gives it the group: said with what it stops, and no command to copy.
  const reboot = kvmAt(dev, group, never);
  expect("err" in reboot && reboot.err.why).toContain("the workspace");
  expect("err" in reboot && reboot.err.fix).toBeUndefined();
  expect(quoted("it's")).toBe("'it'\\''s'");
});

test("nothing is found until the pinned install and its snapshot are there; the device files name the pinned image", () => {
  const home = tempHome();
  cleanups.push(home.done);
  expect(findSdk(home.dir)).toBeUndefined();
  const sdk = sdkAt(home.dir);
  for (const file of [sdk.adb, sdk.emulator, sdk.scrcpyServer, sdk.ffmpeg]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  writeFileSync(markers(home.dir).installed, PINS);
  expect(findSdk(home.dir)).toBeUndefined();
  writeFileSync(markers(home.dir).snapshot, "an older pin");
  expect(findSdk(home.dir)).toBeUndefined();
  writeFileSync(markers(home.dir).snapshot, PINS);
  expect(findSdk(home.dir)).toEqual(sdk);

  writeAvd(sdk);
  expect(readFileSync(join(sdk.avdHome, `${AVD}.ini`), "utf8")).toContain(`${AVD}.avd`);
  expect(readFileSync(join(sdk.avdHome, `${AVD}.avd/config.ini`), "utf8")).toContain("image.sysdir.1=system-images/android-35/google_apis/x86_64/");
  expect(packageUrls().some((u) => u.includes("x86_64-35_r09"))).toBe(true);
  // Writing it again keeps what the device holds.
  writeFileSync(join(sdk.avdHome, `${AVD}.avd/userdata.img`), "x");
  writeAvd(sdk);
  expect(existsSync(join(sdk.avdHome, `${AVD}.avd/userdata.img`))).toBe(true);
});

test("a copy loads the snapshot and saves nothing; a user who joined kvm since runs it through sg; leftovers are ours", () => {
  const copy = emulatorArgs(5556, true);
  expect(copy.join(" ")).toContain(`-avd ${AVD}`);
  expect(copy.join(" ")).toContain("-port 5556");
  expect(copy).toContain("-read-only");
  expect(copy).toContain("-no-snapshot-save");
  expect(emulatorArgs(5554, false)).toContain("-no-snapshot-load");
  const sdk = { ...sdkAt("/nonexistent"), emulator: "/opt/sdk/emulator/emulator" };
  expect(emulatorCommand(sdk, ["-port", "5554"], "direct")).toEqual(["/opt/sdk/emulator/emulator", "-port", "5554"]);
  expect(emulatorCommand(sdk, ["-port", "5554"], "sg")).toEqual(["sg", "kvm", "-c", "exec '/opt/sdk/emulator/emulator' '-port' '5554'"]);
  const ours = "/n/device/sdk/emulator";
  const line = (args: string[]) => args.join("\0");
  expect(isLeftover(line(["/n/device/sdk/emulator/emulator", "-avd", AVD, "-read-only"]), ours)).toBe(true);
  expect(isLeftover(line(["/n/device/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64", "-avd", AVD]), ours)).toBe(true);
  expect(isLeftover(line(["/opt/android/emulator/emulator", "-avd", AVD]), ours)).toBe(false);
  expect(isLeftover(line(["/n/device/sdk/emulator/emulator", "-avd", "Pixel_9"]), ours)).toBe(false);
  expect(isLeftover(line(["/n/device/sdk/emulatorx/emulator", "-avd", AVD]), ours)).toBe(false);
  const first = freePort(new Set());
  expect(first).toBeDefined();
  expect(first! % 2).toBe(0);
  expect(freePort(new Set([first!]))).not.toBe(first);
});

test("a session finds the wrapper first and its own home, and release drops what named its device", () => {
  const env = new Map(agentEnv("/n", "s1", "/usr/bin"));
  expect(env.get("PATH")).toBe("/n/device/agent-device/bin:/usr/bin");
  expect(env.get("AGENT_DEVICE_HOME")).toBe("/n/sessions/s1/agent-device");
  expect(env.get("AGENT_DEVICE_STATE_DIR")).toBe("/n/sessions/s1/agent-device/state");
  expect(env.get("FLEETD_DEVICE_CONTROL")).toBe("/n/sessions/s1/device-control");
  expect(env.has("ANDROID_HOME")).toBe(false);

  const home = tempHome();
  cleanups.push(home.done);
  writeConfig(home.dir, "s1", "emulator-5556");
  expect(JSON.parse(readFileSync(join(sessionDir(home.dir, "s1"), "config.json"), "utf8"))).toEqual({ platform: "android", serial: "emulator-5556" });
  writeFileSync(controlPath(home.dir, "s1"), "human");
  release(home.dir, "s1");
  expect(existsSync(join(sessionDir(home.dir, "s1"), "config.json"))).toBe(false);
  expect(existsSync(controlPath(home.dir, "s1"))).toBe(false);
});

test("a session lent a clone's home uses it, and release stops its daemon", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  expect(homeOf(home.dir, "s1")).toBe(sessionDir(home.dir, "s1"));
  const lent = join(home.dir, "device/ios/clones/AAAA-1");
  const state = join(lent, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(sessionDir(home.dir, "s1"), { recursive: true });
  writeFileSync(join(sessionDir(home.dir, "s1"), LENT), lent);
  expect(homeOf(home.dir, "s1")).toBe(lent);
  const daemon = Bun.spawn(["sleep", "30"]);
  cleanups.push(() => void daemon.kill("SIGKILL"));
  writeFileSync(join(state, "daemon.json"), JSON.stringify({ pid: daemon.pid, stateDir: "/elsewhere" }));
  expect(daemonPid(state)).toBeUndefined();
  writeFileSync(join(state, "daemon.json"), JSON.stringify({ pid: daemon.pid, stateDir: state }));
  expect(daemonPid(state)).toBe(daemon.pid);
  release(home.dir, "s1");
  expect(await daemon.exited).not.toBe(0);
  expect(homeOf(home.dir, "s1")).toBe(sessionDir(home.dir, "s1"));
});

test("the wrapper refuses while a person has control, and gives agent-device alone the node's SDK and adb", () => {
  const home = tempHome();
  cleanups.push(home.done);
  const fake = join(home.dir, "fake's agent-device.mjs");
  writeFileSync(
    fake,
    "console.log('ran', process.argv.slice(2).join(' '), process.env.ANDROID_HOME, process.env.PATH.split(':')[0], process.env.ANDROID_ADB_SERVER_PORT)\n",
  );
  const wrapper = join(home.dir, "agent-device");
  writeFileSync(wrapper, wrapperScript(fake, sdkAt("/n")));
  chmodSync(wrapper, 0o755);
  const control = join(home.dir, "device-control");
  const run = () => Bun.spawnSync([wrapper, "open", "settings"], { env: { ...process.env, FLEETD_DEVICE_CONTROL: control, ANDROID_HOME: "/home/me/Android/Sdk" } });
  writeFileSync(control, "human");
  const paused = run();
  expect(paused.exitCode).toBe(75);
  expect(paused.stderr.toString()).toContain(PAUSED);
  if (!Bun.which("node")) return;
  rmFile(control);
  const ran = run();
  expect(ran.stdout.toString().trim()).toBe("ran open settings /n/device/sdk /n/device/sdk/platform-tools 15037");
});

const rmFile = (path: string) => Bun.spawnSync(["rm", "-f", path]);

test("its skill becomes a plugin sessions load", () => {
  const home = tempHome();
  cleanups.push(home.done);
  const plugin = join(home.dir, "plugin");
  makePlugin("---\nname: agent-device\n---\nagent-device open <app>\n", plugin);
  expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")).name).toBe("agent-device");
  expect(existsSync(join(plugin, "skills/agent-device/SKILL.md"))).toBe(true);
  expect(findAgentDevice(home.dir)).toBeUndefined();
});

test("the node's own stream asks scrcpy for each packet with its header, and reads them however the socket cuts them", () => {
  const args = serverArgs("1234abcd", true);
  expect(args).not.toContain("raw_stream=true");
  expect(args).toEqual(expect.arrayContaining(["send_frame_meta=true", "send_stream_meta=true", "send_device_meta=false", "send_dummy_byte=true", "video_bit_rate=2500000"]));
  // A hosted box's part still decodes the bare stream.
  expect(serverArgs("1234abcd")).toContain("raw_stream=true");
  const stream = Uint8Array.from([...H264_ID, ...sizeMeta(576, 1280), ...packet("config", CONFIG), ...packet("key", IDR), ...packet("delta", P)]);
  for (const cut of [1, 3, 7, 13, stream.length]) {
    const p = new Packets();
    const got: unknown[] = [];
    for (let i = 0; i < stream.length; i += cut) for (const k of p.push(stream.subarray(i, i + cut))) got.push(k.kind === "size" ? k : { ...k, data: [...k.data] });
    expect(got).toEqual([
      { kind: "size", width: 576, height: 1280 },
      { kind: "config", data: CONFIG },
      { kind: "frame", data: IDR, key: true },
      { kind: "frame", data: P, key: false },
    ]);
  }
  expect(() => new Packets().push(Uint8Array.from([0x68, 0x32, 0x36, 0x35]))).toThrow("not H.264");
  // A still decodes every frame kept since the keyframe and keeps the last.
  expect(stillArgs(5).join(" ")).toContain("select=eq(n\\,4)");
  expect(stillArgs(5).join(" ")).toContain("-frames:v 1");
});

test("a pump sends a still's JPEG before the H.264 that comes while it is fitted, and the newest JPEG alone", async () => {
  const sent: string[] = [];
  const frame = (seq: number, video?: boolean) => ({ seq, jpeg: JPEG, width: 576, height: 1280, atMs: seq, ...(video ? { video: { data: Uint8Array.of(0, 0, 0, 1, 0x65), key: seq === 2 } } : {}) });
  const pump = new Pump("s1", () => "agent", (f) => sent.push(`${f.seq}${f.h264B64 ? "v" : "j"}`), undefined);
  pump.offer(frame(1));
  pump.offer(frame(2, true));
  pump.offer(frame(3, true));
  await until(() => sent.length === 3);
  expect(sent).toEqual(["1j", "2v", "3v"]);
  pump.offer(frame(4, true));
  expect(sent.at(-1)).toBe("4v");
  pump.stop();
});

test("scrcpy's server gets a dummy byte after raw_stream, and input goes as its control messages", () => {
  const args = serverArgs("1234abcd");
  expect(args[4]).toBe(SCRCPY_VERSION);
  expect(args.indexOf("send_dummy_byte=true")).toBeGreaterThan(args.indexOf("raw_stream=true"));
  expect(args).toContain("scid=1234abcd");

  const [down] = messages({ kind: "touch", action: "down", x: 288, y: 640 }, [576, 1280]);
  const v = new DataView(down!.buffer);
  expect(down!.length).toBe(32);
  expect([down![0], down![1]]).toEqual([2, 0]);
  expect(v.getBigInt64(2)).toBe(-2n);
  expect([v.getInt32(10), v.getInt32(14), v.getUint16(18), v.getUint16(20), v.getUint16(22)]).toEqual([288, 640, 576, 1280, 0xffff]);
  const [up] = messages({ kind: "touch", action: "up", x: 9999, y: -5 }, [576, 1280]);
  const u = new DataView(up!.buffer);
  expect([up![1], u.getInt32(10), u.getInt32(14), u.getUint16(22)]).toEqual([1, 576, 0, 0]);

  const [enter] = messages({ kind: "key", down: true, key: "Enter", modifiers: 8 }, [576, 1280]);
  const e = new DataView(enter!.buffer);
  expect([enter![0], enter![1], e.getUint32(2), e.getUint32(10)]).toEqual([0, 0, 66, 0x01]);
  expect(keycode("BrowserBack")).toBe(4);
  expect(keycode("toString")).toBeUndefined();
  expect(messages({ kind: "key", down: true, key: "a", modifiers: 0 }, [1, 1])).toEqual([]);
  const long = "é".repeat(200);
  const pieces = messages({ kind: "text", text: long }, [1, 1]);
  expect(pieces.length).toBe(2);
  expect(new TextDecoder().decode(Buffer.concat(pieces.map((p) => p.subarray(5))))).toBe(long);
  expect(metaState(1 | 2 | 4)).toBe(0x02 | 0x1000 | 0x10000);

  const [wheel] = messages({ kind: "scroll", x: 10, y: 20, dx: 0, dy: 100 }, [576, 1280]);
  expect(wheel![0]).toBe(3);
  expect(wheel!.length).toBe(1 + 12 + 2 + 2 + 4);
  expect(new DataView(wheel!.buffer).getInt16(15)).toBeLessThan(0);
});

test("jpegs are split whole across reads", () => {
  const split = new Jpegs();
  const stream = Buffer.concat([JPEG, JPEG]);
  expect(split.push(stream.subarray(0, JPEG.length + 3))).toEqual([JPEG]);
  expect(split.push(stream.subarray(JPEG.length + 3))).toEqual([JPEG]);
});

test("the mouse is one finger, the wheel a scroll, and keys keys or text", () => {
  const p = { down: false };
  const mouse = (action: string, button: string) => ({ kind: "mouse", action, x: 10, y: 20, button }) as never;
  expect(deviceInput(mouse("moved", "none"), p)).toBeUndefined();
  expect(deviceInput(mouse("pressed", "right"), p)).toBeUndefined();
  expect(deviceInput(mouse("pressed", "left"), p)).toEqual({ kind: "touch", action: "down", x: 10, y: 20 });
  expect(p.down).toBe(true);
  expect(deviceInput(mouse("moved", "left"), p)).toEqual({ kind: "touch", action: "move", x: 10, y: 20 });
  expect(deviceInput(mouse("released", "left"), p)).toEqual({ kind: "touch", action: "up", x: 10, y: 20 });
  expect(deviceInput(mouse("released", "left"), p)).toBeUndefined();
  expect(deviceInput({ kind: "mouse", action: "wheel", x: 5, y: 6, deltaY: 120 }, p)).toEqual({ kind: "scroll", x: 5, y: 6, dx: 0, dy: 120 });
  expect(deviceInput({ kind: "key", action: "down", key: "a", text: "a" }, p)).toEqual({ kind: "text", text: "a" });
  expect(deviceInput({ kind: "key", action: "up", key: "a" }, p)).toBeUndefined();
  expect(deviceInput({ kind: "key", action: "down", key: "Enter" }, p)).toEqual({ kind: "key", down: true, key: "Enter", modifiers: 0 });
  expect(deviceInput({ kind: "key", action: "down", key: "a", modifiers: 2 }, p)).toEqual({ kind: "key", down: true, key: "a", modifiers: 2 });
  expect(deviceInput({ kind: "text", text: "hello there" }, p)).toEqual({ kind: "text", text: "hello there" });
  expect(deviceInput({ kind: "reload" }, p)).toBeUndefined();
});

test("a watched device's screen goes to the link, newest only while the link is busy", async () => {
  const sent: { seq: number }[] = [];
  const pump = new Pump("Bsession", () => "human", (f) => sent.push(f), 8);
  const frame = (seq: number) => ({ seq, jpeg: JPEG, width: 576, height: 1280, atMs: seq * 40 });
  pump.offer(frame(1));
  await until(() => sent.length === 1);
  expect(sent[0]).toMatchObject({ seq: 1, width: 576, height: 1280, control: "human", sessionId: "Bsession" });
  for (let seq = 2; seq <= 50; seq++) pump.offer(frame(seq));
  await until(() => sent.length === 2);
  expect(sent[1]!.seq).toBe(50);
  pump.stop();
});

/** A home with the pinned install there, its tools stand-ins; scrcpy's server is `scrcpy`, a local socket. */
function fakeInstall(home: string, scrcpyPort: number, log: string): void {
  const sdk = sdkAt(home);
  const script = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
  };
  script(
    sdk.adb,
    `echo "$@" >> '${log}'
shift 2
case "$1 $2" in
  "shell getprop") echo 1 ;;
  "forward tcp:0") echo ${scrcpyPort} ;;
  "shell CLASSPATH="*) exec sleep 30 ;;
esac
exit 0
`,
  );
  script(sdk.emulator, "exec sleep 60\n");
  script(
    sdk.ffmpeg,
    `for a in "$@"; do last="$a"; done
echo "ffmpeg $*" >> '${log}'
case "$*" in
  *image2pipe*) head -c 1 > /dev/null; printf '${[...JPEG].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("")}'; cat > /dev/null ;;
  *) cat > "$last" ;;
esac
`,
  );
  writeFileSync(sdk.scrcpyServer, "jar");
  writeFileSync(markers(home).installed, PINS);
  writeFileSync(markers(home).snapshot, PINS);
  mkdirSync(dirname(entry(home)), { recursive: true });
  writeFileSync(entry(home), "");
  script(join(binDir(home), "agent-device"), "exit 0\n");
  writeFileSync(join(dirname(binDir(home)), "VERSION"), VERSION);
}

test("an android session: lent a warm copy, recorded, watched, taken over and handed back, then uploaded", async () => {
  // scrcpy's server: the video socket gets the dummy byte and a little stream, its packets cut anywhere; the control
  // socket keeps what came, and a reset there starts the encoder again: its size, its parameter sets, a keyframe.
  const control: Uint8Array[] = [];
  let connections = 0;
  let video: { write(b: Uint8Array): number } | undefined;
  const restart = () => [...sizeMeta(576, 1280), ...packet("config", CONFIG), ...packet("key", IDR)];
  const scrcpy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        if (connections++ > 0) return;
        video = s;
        const stream = Uint8Array.from([0, ...H264_ID, ...restart(), ...packet("delta", P)]);
        s.write(stream.subarray(0, 9));
        setTimeout(() => s.write(stream.subarray(9)), 20);
      },
      data(_s, chunk) {
        control.push(Uint8Array.from(chunk));
        if (chunk.includes(17)) video?.write(Uint8Array.from([...restart(), ...packet("delta", P)]));
      },
    },
  });
  cleanups.push(() => scrcpy.stop(true));
  const t = testNode("devbox");
  cleanups.push(t.done);
  const log = join(t.node.home, "adb.log");
  fakeInstall(t.node.home, scrcpy.port, log);
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  t.link.answer = async (op, args) => {
    calls.push({ op, args });
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    return {};
  };
  const kvm = () => ({ ok: "direct" as const });
  const devices = startDevices(t.node, { kvm, warm: 1 })!;
  cleanups.push(async () => {
    await devices.shutdown();
    await broker(t.node).shutdown();
  });
  expect(health(t.node.home, kvm)?.state).toBe("ready");
  expect(capabilities(t.node.home, kvm)).toEqual(["session_android"]);
  await until(() => devices.warm() === 1);
  expect(t.node.area("caps").list()).toContain("session_android");
  // An agent's claude launches with agent-device's wrapper first on its PATH, pointed at its own home and control file.
  const launched = new Map(t.node.area("launch").env("t1", "/usr/bin"));
  expect(launched.get("PATH")).toBe(`${t.node.home}/device/agent-device/bin:/usr/bin`);
  expect(launched.get("AGENT_DEVICE_HOME")).toBe(sessionDir(t.node.home, "t1"));
  expect(launched.get("FLEETD_DEVICE_CONTROL")).toBe(controlPath(t.node.home, "t1"));

  const r = router(t.node);
  const started = await r.handle("t1", { id: "1", cwd: "/w", call: { op: "session_start", purpose: "Settings", kind: "android" } });
  const id = String(started.sessionId);
  const serial = String(started.serial);
  expect(serial).toMatch(/^emulator-\d+$/);
  expect(started.op).toBe("session_start");
  expect(r.open("t1")).toEqual({ kind: "android", id });
  expect(JSON.parse(readFileSync(join(sessionDir(t.node.home, "t1"), "config.json"), "utf8")).serial).toBe(serial);
  await expect(r.handle("t1", { id: "2", cwd: "/w", call: { op: "session_start", purpose: "again", kind: "android" } })).rejects.toThrow("is open");
  // Recorded from its first keyframe: the device's own H.264, copied into MP4.
  const mp4 = join(recordingsDir(t.node.home), id, "video.mp4");
  await until(() => existsSync(mp4));
  expect(readFileSync(log, "utf8")).toContain("push");
  expect(readFileSync(log, "utf8")).toContain("send_frame_meta=true");

  // Watched for a moment in JPEG (the Screens page's picture): its first frame is a still of the screen now, the last
  // of the frames kept since the keyframe, not the keyframe the decoder starts from.
  const frames = () => t.link.sent.filter((f) => f.t === "browser_frame") as unknown as { jpegB64?: string; h264B64?: string; key?: boolean; seq: number }[];
  await until(() => readFileSync(log, "utf8").includes("-c:v copy"));
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true });
  await until(() => frames().length > 0);
  expect(frames()[0]).toMatchObject({ jpegB64: expect.any(String), width: 576, height: 1280 });
  expect(readFileSync(log, "utf8")).toContain("select=eq(n\\,1)");
  await Bun.sleep(100);
  // The decoder's one picture so far is of the frames it started from: the still stands for it.
  expect(frames().length).toBe(1);
  t.link.deliver({ t: "browser_watch", sessionId: id, on: false });
  t.link.sent.length = 0;

  // Watched by an app that decodes H.264: the screen now as a JPEG (from the frames kept since the keyframe), then the
  // H.264 from a keyframe, the device's encoder reset for it.
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true, video: true, key: true });
  await until(() => frames().some((f) => f.h264B64 !== undefined));
  expect(frames()[0]).toMatchObject({ sessionId: id, width: 576, height: 1280, control: "agent", jpegB64: expect.any(String) });
  const keyframe = frames().find((f) => f.h264B64 !== undefined)!;
  expect(keyframe.key).toBe(true);
  expect([...Buffer.from(keyframe.h264B64!, "base64")]).toEqual([...CONFIG, ...IDR]);
  expect(keyframe.seq).toBeGreaterThan(frames()[0]!.seq);
  expect(control.some((c) => c[0] === 17)).toBe(true);
  // A link just under the bar keeps H.264 (KEEP_SHARE), so one that wavers around it doesn't flip each time.
  const nearBar = Math.round(PASSTHROUGH_KBPS * 0.9);
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true, video: true, kbps: nearBar });
  await Bun.sleep(50);
  expect(devices.session("t1")?.wantsVideo()).toBe(true);
  // A link too slow for the device's bit rate: JPEGs, decoded on the node, and no more H.264.
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true, video: true, kbps: 500 });
  const sent = frames().length;
  await until(() => devices.session("t1")?.wantsVideo() === false);
  await until(() => frames().length > sent);
  expect(frames().slice(sent).every((f) => f.jpegB64 !== undefined)).toBe(true);
  expect(readFileSync(log, "utf8")).not.toContain("raw_stream");
  // Back just under the bar: still JPEG, until the link carries the whole of it.
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true, video: true, kbps: nearBar });
  await Bun.sleep(50);
  expect(devices.session("t1")?.wantsVideo()).toBe(false);

  // A person takes over: the wrapper's control file is there, and their tap reaches scrcpy as a finger.
  t.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "a person" });
  expect(existsSync(controlPath(t.node.home, "t1"))).toBe(true);
  t.link.deliver({ t: "browser_input", sessionId: id, input: { kind: "mouse", action: "pressed", x: 100, y: 200, button: "left" } });
  // A finger (touch, 2), after the reset (17) the watch asked for.
  await until(() => control.some((c) => c[0] === 2));
  // Handed back: the agent's next agent-device command gives it the device again, and is logged.
  t.link.deliver({ t: "browser_control", sessionId: id, control: "agent", by: "a person" });
  expect(devices.session("t1")?.control()).toBe("handing_back");
  expect(existsSync(controlPath(t.node.home, "t1"))).toBe(false);
  const at = new Date().toISOString();
  devices.item("t1", { id: "i", status: "completed", title: "", startedAt: at, completedAt: at, updatedAt: at, kind: { type: "command", command: "agent-device snapshot", output: "ok", exitCode: 0 } } as never);
  expect(devices.session("t1")?.control()).toBe("agent");

  const hb = { load: { cpus: 1 } as never, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb);
  expect(hb.busy.screens).toBe(1);
  expect((hb.load as { android?: { state: string } }).android?.state).toBe("ready");
  expect(hb.steps.length).toBeGreaterThan(0);

  const ended = await r.handle("t1", { id: "3", cwd: "/w", call: { op: "session_end" } });
  expect(ended).toMatchObject({ op: "session_end", sessionId: id, kind: "android" });
  const files = (ended.files as { file: string }[]).map((f) => f.file).sort();
  expect(files).toEqual(["actions", "video_mp4"]);
  expect(r.open("t1")).toBeUndefined();
  await until(() => !existsSync(join(recordingsDir(t.node.home), id)));
  const states = calls.filter((c) => c.op === "browser_session").map((c) => c.args.state);
  expect(states).toContain("live");
  expect(states.at(-1)).toBe("recorded");
  const actions = calls.filter((c) => c.op === "browser_recording_part" && c.args.file === "actions");
  const log2 = Buffer.from(String(actions[0]!.args.dataB64), "base64").toString().trim().split("\n").map((l) => JSON.parse(l).tool);
  expect(log2).toEqual(["session_start", "takeover", "handback", "agent-device", "session_end"]);
  expect(existsSync(join(sessionDir(t.node.home, "t1"), "config.json"))).toBe(false);
});

test("a machine where KVM opens installs on the first android start with no opt-in, and one with no KVM says how to fix it", async () => {
  // An older node.json's switch turns nothing off.
  const t = testNode("devbox", { device: { enabled: false } });
  cleanups.push(t.done);
  // agent-device is there; the emulator's install waits, as a 2 GB download would.
  mkdirSync(dirname(entry(t.node.home)), { recursive: true });
  writeFileSync(entry(t.node.home), "");
  mkdirSync(binDir(t.node.home), { recursive: true });
  writeFileSync(join(binDir(t.node.home), "agent-device"), "");
  writeFileSync(join(dirname(binDir(t.node.home)), "VERSION"), VERSION);
  let installs = 0;
  const devices = startDevices(t.node, { kvm: () => ({ ok: "direct" }), install: () => (installs++, new Promise(() => {})) })!;
  cleanups.push(async () => {
    await devices.shutdown();
    await broker(t.node).shutdown();
  });
  expect(devices.offered()).toBe(true);
  // The heartbeat's Android line, as the hub places by it.
  startHosts(t.node, () => ({ ok: "direct" }));
  const android = async () => {
    forget(t.node.home);
    const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
    await t.node.area("hb").fill(hb as never);
    return ((hb.load as { hosts?: { host: string; ready: boolean; off?: string }[] }).hosts ?? []).find((c) => c.host === "android");
  };
  // Nothing installed yet: placeable, so the hub sends the first start here.
  if (process.platform === "linux" && process.arch === "x64") expect(await android()).toMatchObject({ ready: true });
  const start = { id: "1", cwd: "/w", call: { op: "session_start", purpose: "p", kind: "android" } };
  await expect(router(t.node).handle("t1", start)).rejects.toThrow("still installing its Android emulator");
  expect(installs).toBe(1);
  // Installing: the hub places elsewhere meanwhile, and the machine's page says nothing (it needs no one).
  if (process.platform === "linux" && process.arch === "x64") expect(await android()).toMatchObject({ ready: false, off: "installing" });
  expect(health(t.node.home, () => ({ ok: "direct" }))?.state).toBe("installing");
  expect(t.node.area("caps").list()).not.toContain("session_android");
  const off = testNode("devbox", { device: {} });
  cleanups.push(off.done);
  const noKvm = startDevices(off.node, { kvm: () => ({ err: { why: "no /dev/kvm here", fix: "sudo usermod -aG kvm me" } }) })!;
  cleanups.push(async () => {
    await noKvm.shutdown();
    await broker(off.node).shutdown();
  });
  await expect(router(off.node).handle("t1", start)).rejects.toThrow("can't run the Android emulator: no /dev/kvm here");
  expect(noKvm.offered()).toBe(false);
  expect(health(off.node.home, () => ({ err: { why: "no /dev/kvm here" } }))?.state).toBe("unavailable");
  expect(health(off.node.home, () => ({ ok: "direct" }))?.state).toBe("wanted");
});

test("an Android screen hosted for another machine runs only sealed device steps, in order, and its recording is scrubbed", async () => {
  const scrcpy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  cleanups.push(() => scrcpy.stop(true));
  const t = testNode("box2");
  cleanups.push(t.done);
  fakeInstall(t.node.home, scrcpy.port, join(t.node.home, "adb.log"));
  // The node's agent-device wrapper: what it ran, where, and an install's app copied back out.
  writeFileSync(
    join(binDir(t.node.home), "agent-device"),
    '#!/bin/sh\necho "ran $* as ${AGENT_DEVICE_HOME:-nobody}"\nif [ "$1" = install ]; then cat "$2" > out/9-copy.bin; fi\nexit 3\n',
  );
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  t.link.answer = async (op, args) => {
    calls.push({ op, args });
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    return {};
  };
  const devices = startDevices(t.node, { kvm: () => ({ ok: "direct" as const }), warm: 1 })!;
  const b = startBrowser(t.node);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const route = startRoute(t.node, new Router(t.node, b, new NodeBoxKey(secret)));
  cleanups.push(async () => {
    await devices.shutdown();
    await b.shutdown();
  });
  await until(() => devices.warm() === 1);

  const key = `H${"cd".repeat(16)}`;
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const plain = JSON.stringify({ secrets: [["TOKEN", "hunter2-value"]], relayKey: Buffer.from(relayKey).toString("base64") });
  const sealed = Buffer.from(seal(publicKeyOf(secret), new TextEncoder().encode(plain))).toString("base64");
  const started = await route.host({ hostKey: key, sealed, frame: { id: "1", cwd: "/", call: { op: "session_start", purpose: "PR build", kind: "android" } } } as never);
  expect(started.error).toBeUndefined();
  const id = String(started.result?.sessionId);

  let count = 0;
  const step = async (call: DeviceCall, n = ++count) => {
    const answer = await route.host({ hostKey: key, frame: { id: `s${n}`, cwd: "/", call: { op: "device", ...sealCall(relayKey, n, call) } } } as never);
    if (answer.error) return answer.error;
    const { op: _, ...done } = answer.result!;
    return openDone(relayKey, n, done as DeviceDone);
  };
  const app = Buffer.alloc(PIECE + 10, 7);
  expect(await step({ step: "put", name: "1-app.zip", offset: 0, dataB64: app.subarray(0, PIECE).toString("base64") })).toEqual({ step: "put", bytes: PIECE });
  await step({ step: "put", name: "1-app.zip", offset: PIECE, dataB64: app.subarray(PIECE).toString("base64") });
  const ran = (await step({ step: "run", args: ["install", "in/1-app.zip"] })) as DeviceDone & { step: "run" };
  expect(ran.exitCode).toBe(3);
  expect(ran.stdout).toContain(`ran install in/1-app.zip as ${sessionDir(t.node.home, key)}`);
  expect(ran.files).toEqual([{ name: "9-copy.bin", bytes: app.length }]);
  const back: Buffer[] = [];
  for (let got = 0; got < app.length; ) {
    const piece = (await step({ step: "get", name: "9-copy.bin", offset: got })) as { dataB64: string; total: number };
    back.push(Buffer.from(piece.dataB64, "base64"));
    got += back.at(-1)!.length;
  }
  expect(Buffer.concat(back).equals(app)).toBe(true);
  // A command that isn't the screen's, a step played again or one the hub made up runs nothing.
  expect(await step({ step: "run", args: ["shell", "id"] })).toMatchObject({ message: expect.stringContaining("doesn't run here") });
  expect(await step({ step: "run", args: ["home"] }, count)).toMatchObject({ message: expect.stringContaining("came again") });
  const unsealed = await route.host({ hostKey: key, frame: { id: "x", cwd: "/", call: { op: "device", step: "run", args: ["home"] } } } as never);
  expect(unsealed.error?.message).toBe("device steps come sealed by the agent's node");
  await step({ step: "run", args: ["type", "hunter2-value"] });
  // Only a screen hosted for another machine takes them.
  await expect(devices.device("t-own", { step: "run", args: ["home"] })).rejects.toThrow("hosted for another machine");

  const ended = await route.host({ hostKey: key, frame: { id: "e", cwd: "/", call: { op: "session_end" } } } as never);
  expect(ended.error).toBeUndefined();
  expect(existsSync(new Work(t.node.home, key).dir)).toBe(false);
  expect(route.hosted.has(key)).toBe(false);
  await until(() => !existsSync(join(recordingsDir(t.node.home), id)));
  const log = calls
    .filter((c) => c.op === "browser_recording_part" && c.args.file === "actions")
    .map((c) => Buffer.from(String(c.args.dataB64), "base64").toString())
    .join("");
  expect(log).toContain("agent-device install in/1-app.zip");
  expect(log).toContain("***TOKEN***");
  expect(log).not.toContain("hunter2");
}, 20_000);
