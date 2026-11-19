// An agent's Android emulator in its own hosted box, as its browser and Linux desktop are (./box_screens.ts): a
// provider stays in fleetd only where its boxes run the emulator with KVM (D576), so a hosted agent's phone is beside
// its files, on its network. The box gets fleetd's pinned emulator, its image and platform-tools once (about 1.2 GB,
// a minute or so; ../device/sdk.ts PACKAGES, checked by digest), boots the device cold, and runs the adb server the
// emulator registers with. Everything the node does with an emulator stays as on a machine: its own adb client (the
// pinned platform-tools, ../device/sdk.ts installClient) talks to the box's adb server through a port of this
// machine's that the box's link carries (`pull`), and so does scrcpy's stream, which the node decodes, records and
// streams to the live view. The agent's agent-device runs in the box, from the node's own pinned copy mirrored there,
// with a wrapper at the same path as on the node pointed at the box's SDK; the person's takeover reaches it as the
// control file the wrapper checks.
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { entry, installDir as agentDeviceDir, binDir, controlPath, sessionDir, wrapperScript } from "../device/agent_device.ts";
import type { Lent } from "../device/emulator.ts";
import { ADB_SERVER_PORT, AVD, AVD_CONFIG, EMULATOR_PACKAGES, type Sdk } from "../device/sdk.ts";
import { mirror } from "../sandbox/remote/files.ts";
import type { Box } from "../sandbox/box.ts";

/** What the emulator needs of its box. */
export type AndroidBox = Pick<Box, "run" | "write" | "read" | "dial">;

/** Where the box keeps the SDK, the device and their logs: on its disk, never a /tmp that may be memory. */
export const BOX_ROOT = "/var/tmp/fleetd-android";
/** The emulator's console port in the box, and so its serial. */
export const CONSOLE = 5554;
export const SERIAL = `emulator-${CONSOLE}`;
/** How long the emulator may take to boot once the SDK is in the box (fetching it has its own 900 s, prepareScript). */
export const timing = { upMs: 300_000 };

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const enc = (s: string) => new TextEncoder().encode(s);

/** The SDK as the box has it: what the agent's wrapper and the box's own adb run with. */
export const boxSdk = (): Sdk => ({
  root: `${BOX_ROOT}/sdk`,
  adb: `${BOX_ROOT}/sdk/platform-tools/adb`,
  emulator: `${BOX_ROOT}/sdk/emulator/emulator`,
  avdHome: `${BOX_ROOT}/avd`,
  emulatorHome: `${BOX_ROOT}/emulator-home`,
  scrcpyServer: "",
  ffmpeg: "",
});

/** The environment adb and the emulator run with in the box. */
const boxEnv = (): Record<string, string> => {
  const s = boxSdk();
  return {
    PATH,
    ANDROID_HOME: s.root,
    ANDROID_SDK_ROOT: s.root,
    ANDROID_AVD_HOME: s.avdHome,
    ANDROID_EMULATOR_HOME: s.emulatorHome,
    ANDROID_TMP: `${s.emulatorHome}/tmp`,
    ANDROID_ADB_SERVER_PORT: String(ADB_SERVER_PORT),
  };
};

async function sh(box: AndroidBox, script: string, timeoutSec = 60): Promise<string> {
  const out = await box.run({ argv: ["sh", "-c", script], cwd: "/", env: boxEnv(), timeoutSec });
  if (out.notRun) throw new Error(out.notRun);
  if (out.exitCode !== 0) throw new Error(out.outputTail.trim().slice(-600) || `exit ${out.exitCode}`);
  return out.outputTail;
}

/** Why the box can't run the emulator, in plain words, or undefined when it can: KVM must open for the box's user. */
export async function kvmIn(box: AndroidBox): Promise<string | undefined> {
  const said = await sh(
    box,
    'if [ ! -e /dev/kvm ]; then echo "this sandbox has no /dev/kvm"; elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then echo "this sandbox\'s /dev/kvm doesn\'t open for $(id -un)"; else echo ok; fi',
  );
  const line = said.trim().split("\n").at(-1) ?? "";
  return line === "ok" ? undefined : line;
}

/** Fetches what the box hasn't of the pinned SDK, checked by digest, and writes the device's files (as the node's
 * own install does, ../device/sdk.ts writeAvd). Run again, it does nothing. */
export function prepareScript(): string {
  const s = boxSdk();
  const avdDir = `${s.avdHome}/${AVD}.avd`;
  const lines = [
    "set -e",
    `R=${shq(BOX_ROOT)}`,
    'mkdir -p "$R/dl" "$R/emulator-home/tmp"',
    'unz() { if command -v unzip >/dev/null; then unzip -q -o "$1" -d "$2"; else python3 -c "import zipfile,sys,os\nz=zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist():\n  p=z.extract(i,sys.argv[2]); m=(i.external_attr>>16)&0o777\n  if m: os.chmod(p,m)" "$1" "$2"; fi; }',
  ];
  for (const p of EMULATOR_PACKAGES()) {
    const name = p.url.split("/").at(-1) ?? "pkg";
    const done = `$R/.${name}.done`;
    const check = p.sha1 ? `echo "${p.sha1}  $R/dl/${name}" | sha1sum -c - >/dev/null` : `echo "${p.sha256}  $R/dl/${name}" | sha256sum -c - >/dev/null`;
    lines.push(
      `if [ ! -e "${done}" ]; then`,
      `  curl -fsSL -o "$R/dl/${name}" ${shq(p.url)}`,
      `  ${check}`,
      `  mkdir -p "$R/${p.dest}" && unz "$R/dl/${name}" "$R/${p.dest}" && rm -f "$R/dl/${name}" && touch "${done}"`,
      "fi",
    );
  }
  lines.push(
    `mkdir -p ${shq(avdDir)}`,
    `printf %s ${shq(`avd.ini.encoding=UTF-8\npath=${avdDir}\ntarget=android-35\n`)} > ${shq(`${s.avdHome}/${AVD}.ini`)}`,
    `printf %s ${shq(`AvdId=${AVD}\navd.ini.displayname=${AVD}\n${AVD_CONFIG}`)} > ${shq(`${avdDir}/config.ini`)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Starts the box's adb server, then the emulator in a process session of its own (its pid in `pidFile`). */
export function startScript(pidFile: string): string {
  const s = boxSdk();
  return [
    `${shq(s.adb)} start-server >/dev/null 2>&1`,
    `setsid ${shq(s.emulator)} -avd ${AVD} -no-window -no-audio -no-boot-anim -no-metrics -no-snapshot -accel on -port ${CONSOLE} </dev/null >${shq(`${BOX_ROOT}/emulator.log`)} 2>&1 &`,
    `echo $! > ${shq(pidFile)}`,
    "",
  ].join("\n");
}

/** A port of this machine's whose connections the box's guest makes to `port` on the box's loopback. */
export async function pull(box: Pick<Box, "dial">, port: number): Promise<{ port: number; close(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.pause();
    void box.dial("127.0.0.1", port).then(
      (there: Duplex) => {
        sock.pipe(there);
        there.pipe(sock);
        const end = () => {
          sock.destroy();
          there.destroy();
        };
        sock.once("close", end);
        there.once("close", end);
        there.once("error", end);
        sock.once("error", end);
        sock.resume();
      },
      () => sock.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const here = typeof address === "object" && address ? address.port : 0;
  return {
    port: here,
    close: () => {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}

export type BoxedEmulator = { lent: Lent; sdk: Sdk };

/**
 * The agent's emulator in its box, booted: what a session drives as one the node lent (../device/index.ts), with the
 * node's client SDK pointed at the box's adb server. `client` is the node's own adb, scrcpy server and ffmpeg.
 */
export async function startInBox(box: AndroidBox, o: { home: string; thread: string; client: Sdk }): Promise<BoxedEmulator> {
  const why = await kvmIn(box);
  if (why) throw new Error(`${why}, and the Android emulator needs KVM`);
  await sh(box, prepareScript(), 900);
  // The agent's agent-device: the node's pinned copy at the same path, its wrapper pointed at the box's SDK.
  await mirror(box, [join(agentDeviceDir(o.home), "node_modules"), join(agentDeviceDir(o.home), "plugin")]);
  await box.write(join(binDir(o.home), "agent-device"), enc(wrapperScript(entry(o.home), boxSdk())), 0o755);
  await box.write(join(sessionDir(o.home, o.thread), "config.json"), enc(`${JSON.stringify({ platform: "android", serial: SERIAL })}\n`), 0o600);
  const pidFile = `${BOX_ROOT}/emulator.pid`;
  await sh(box, startScript(pidFile));
  const deadline = Date.now() + timing.upMs;
  for (;;) {
    const said = await sh(box, `${shq(boxSdk().adb)} -s ${SERIAL} shell getprop sys.boot_completed 2>/dev/null || true`, 30).catch(() => "");
    if (said.trim() === "1") break;
    if (Date.now() > deadline) {
      const log = await sh(box, `tail -c 800 ${shq(`${BOX_ROOT}/emulator.log`)} 2>/dev/null || true`).catch(() => "");
      await stopIn(box, pidFile);
      throw new Error(`the emulator in the sandbox didn't boot within ${timing.upMs / 1000} s${log.trim() ? `: ${log.trim()}` : ""}`);
    }
    await Bun.sleep(2_000);
  }
  // Settled for automation, as the node's own device is (../device/sdk.ts snapshot).
  await sh(box, ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"].map((k) => `${shq(boxSdk().adb)} -s ${SERIAL} shell settings put global ${k} 0`).join("; "), 60).catch(() => "");
  const adbHere = await pull(box, ADB_SERVER_PORT);
  const forwards: { close(): void }[] = [adbHere];
  const sdk: Sdk = {
    ...o.client,
    adbPort: adbHere.port,
    reach: async (port) => {
      const p = await pull(box, port);
      forwards.push(p);
      return p.port;
    },
  };
  const control = controlPath(o.home, o.thread);
  const lent: Lent = {
    emulator: { serial: SERIAL, pushed: false },
    release: () => {
      for (const f of forwards.splice(0)) f.close();
      void stopIn(box, pidFile);
    },
    control: (human) => void (human ? box.write(control, enc("human\n"), 0o600) : sh(box, `rm -f ${shq(control)}`)).catch(() => {}),
  };
  return { lent, sdk };
}

/** Kills the emulator's process session, and the box's adb server. */
const stopIn = (box: AndroidBox, pidFile: string) =>
  sh(box, `[ -f ${shq(pidFile)} ] && kill -KILL -- "-$(cat ${shq(pidFile)})" 2>/dev/null; rm -f ${shq(pidFile)}; ${shq(boxSdk().adb)} kill-server >/dev/null 2>&1; true`).catch(() => "");
