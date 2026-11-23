// An agent's Android emulator in its hosted box, driven from outside it with nothing run where it is driven from: the
// box gets fleetd's pinned emulator, its image and platform-tools (../device/pins.ts, checked by digest), boots the
// device cold, and runs the adb server it registers with, as ./box_android.ts has it. For a holder with no node (fleetd
// cloud, ../device/devices.ts) the rest goes into the box too: scrcpy's server and an ffmpeg that decodes its H.264
// (the pinned ones), and agent-device with its skill (npm's tarball checked by its integrity digest), its wrapper and
// the session's config. A small part (../device/android_part.mjs, run by the box's own Bun in a process session of its
// own) streams the screen as JPEGs to one connection at a time on the box's loopback, which the box's guest dials for
// the holder (../sandbox/box.ts `dial`), and takes a person's input back as scrcpy's control messages. So what crosses
// the box's edge is frames out, input in, and the box's own calls (run, write, read).
//
// The part outlives a dropped connection for GRACE_MS (box_chrome.ts): a holder redialled, or another instance that
// took the session over (`snapshot`/`adopt`), dials it again with the session's token and gets the newest frame at
// once. The emulator outlives the part: a later start in the same box finds it booted (`bootIn` reattaches).
//
// What holds, and against whom. The agent is root in its box: every guard here holds only against the agent's own
// driver, never against other processes in the box. A person's takeover is a control file the agent's agent-device
// wrapper checks (../device/pins.ts wrapperScript): it keeps an honest agent from fighting the person, but adb is the
// agent's to reach, and the part's token and port are readable to anything root in the box, which could also feed
// or read the screen itself. The video's frames come from the box, so a process there could alter them. What the box
// never gets: the session's action log (scrubbed outside it, ../device/devices.ts), its secrets, or any credential; a
// person's keys reach it only as the keystrokes themselves, which is what driving the phone is.
// Box side (docs/CONTRIBUTING.md "The package"): what it does in the box goes through the box's own calls.
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import part from "../device/android_part.mjs" with { type: "text" };
import {
  ADB_SERVER_PORT,
  AGENT_DEVICE_INTEGRITY,
  AGENT_DEVICE_SKILL_SHA256,
  AGENT_DEVICE_SKILL_URL,
  AGENT_DEVICE_URL,
  AVD,
  AVD_CONFIG,
  CLIENT_PACKAGES,
  EMULATOR_PACKAGES,
  type Package,
  type Sdk,
  wrapperScript,
} from "../device/pins.ts";
import { DECODER_ARGS, SERVER_PATH, serverArgs } from "../device/scrcpy_wire.ts";
import type { Box } from "../sandbox/box.ts";

/** What the emulator needs of its box. */
export type AndroidBox = Pick<Box, "run" | "write" | "read" | "dial">;

/** Where the box keeps the SDK, the device and their logs: on its disk, never a /tmp that may be memory. */
export const BOX_ROOT = "/var/tmp/fleetd-android";
/** The emulator's console port in the box, and so its serial. */
export const CONSOLE = 5554;
export const SERIAL = `emulator-${CONSOLE}`;
/** How long a box's part waits for a new connection once one dropped, as a box's Chrome does (./box_chrome.ts). */
export const GRACE_MS = 60_000;
/** The stream's size: the device's 720×1600 screen at scrcpy's longer side of 1280 (../device/scrcpy_wire.ts). */
export const ANDROID_SIZE: [number, number] = [576, 1280];
/** How long the emulator may take to boot once the SDK is in the box (fetching it has its own 900 s, prepareScript);
 * how long the part waits for a new connection once one dropped; how long a new holder tries to reach a part that
 * should be listening (a test's own, each). */
export const timing = { upMs: 300_000, graceMs: GRACE_MS, reachMs: 10_000, pollMs: 2_000 };

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (n: number) => randomBytes(n).toString("hex");
/** Kills the process session whose leader's pid `file` names: dash's own `kill` takes no negative pid, so procps'
 * pkill by session id, never with an empty or zero id (pkill's own session). */
const killSession = (file: string) => `p=$(cat ${shq(file)} 2>/dev/null); case "$p" in ''|*[!0-9]*|0) ;; *) pkill -KILL -s "$p" 2>/dev/null ;; esac`;

/** A stream to `at` on the box's loopback once something listens there, trying again until `ms` is up. */
async function dialUntil(box: Pick<Box, "dial">, at: number, ms: number): Promise<Duplex> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await box.dial("127.0.0.1", at);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`nothing answered in the box within ${ms / 1000} s: ${(e as Error).message}`);
    }
    await Bun.sleep(100);
  }
}

/** The SDK as the box has it: what the agent's wrapper, the box's own adb and its part run with. */
export const boxSdk = (): Sdk => ({
  root: `${BOX_ROOT}/sdk`,
  adb: `${BOX_ROOT}/sdk/platform-tools/adb`,
  emulator: `${BOX_ROOT}/sdk/emulator/emulator`,
  avdHome: `${BOX_ROOT}/avd`,
  emulatorHome: `${BOX_ROOT}/emulator-home`,
  scrcpyServer: `${BOX_ROOT}/scrcpy-server.jar`,
  ffmpeg: `${BOX_ROOT}/ffmpeg/ffmpeg-6.0.1-amd64-static/ffmpeg`,
});

/** The environment adb and the emulator run with in the box. */
export const boxEnv = (): Record<string, string> => {
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

/** Runs `script` with `sh` in the box; throws what it printed when it fails. */
export async function sh(box: Pick<Box, "run">, script: string, timeoutSec = 60): Promise<string> {
  const out = await box.run({ argv: ["sh", "-c", script], cwd: "/", env: boxEnv(), timeoutSec });
  if (out.notRun) throw new Error(out.notRun);
  if (out.exitCode !== 0) throw new Error(out.outputTail.trim().slice(-600) || `exit ${out.exitCode}`);
  return out.outputTail;
}

/** Why the box can't run the emulator, in plain words, or undefined when it can: KVM must open for the box's user. */
export async function kvmIn(box: Pick<Box, "run">): Promise<string | undefined> {
  const said = await sh(
    box,
    'if [ ! -e /dev/kvm ]; then echo "this sandbox has no /dev/kvm"; elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then echo "this sandbox\'s /dev/kvm doesn\'t open for $(id -un)"; else echo ok; fi',
  );
  const line = said.trim().split("\n").at(-1) ?? "";
  return line === "ok" ? undefined : line;
}

const HEAD = [
  "set -e",
  `R=${shq(BOX_ROOT)}`,
  'mkdir -p "$R/dl" "$R/emulator-home/tmp"',
  'unz() { if command -v unzip >/dev/null; then unzip -q -o "$1" -d "$2"; else python3 -c "import zipfile,sys,os\nz=zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist():\n  p=z.extract(i,sys.argv[2]); m=(i.external_attr>>16)&0o777\n  if m: os.chmod(p,m)" "$1" "$2"; fi; }',
];

/** Lines that fetch `p` once into `$R/<dest>`, checked by digest; a marker the next run skips it by. */
function fetchLines(p: Package): string[] {
  const name = p.url.split("/").at(-1) ?? "pkg";
  const done = `$R/.${name}.done`;
  const check = p.sha1 ? `echo "${p.sha1}  $R/dl/${name}" | sha1sum -c - >/dev/null` : `echo "${p.sha256}  $R/dl/${name}" | sha256sum -c - >/dev/null`;
  const unpack =
    p.unpack === "zip"
      ? `mkdir -p "$R/${p.dest}" && unz "$R/dl/${name}" "$R/${p.dest}"`
      : p.unpack === "tar.xz"
        ? `mkdir -p "$R/${p.dest}" && tar -xJf "$R/dl/${name}" -C "$R/${p.dest}"`
        : `cp "$R/dl/${name}" "$R/${p.dest}"`;
  return [
    `if [ ! -e "${done}" ]; then`,
    `  curl -fsSL -o "$R/dl/${name}" ${shq(p.url)}`,
    `  ${check}`,
    `  ${unpack} && rm -f "$R/dl/${name}" && touch "${done}"`,
    "fi",
  ];
}

/** Fetches what the box hasn't of the pinned SDK, checked by digest, and writes the device's files (as the node's
 * own install does, ../device/sdk.ts writeAvd). Run again, it does nothing. */
export function prepareScript(): string {
  const s = boxSdk();
  const avdDir = `${s.avdHome}/${AVD}.avd`;
  const lines = [...HEAD];
  for (const p of EMULATOR_PACKAGES()) lines.push(...fetchLines(p));
  lines.push(
    `mkdir -p ${shq(avdDir)}`,
    `printf %s ${shq(`avd.ini.encoding=UTF-8\npath=${avdDir}\ntarget=android-35\n`)} > ${shq(`${s.avdHome}/${AVD}.ini`)}`,
    `printf %s ${shq(`AvdId=${AVD}\navd.ini.displayname=${AVD}\n${AVD_CONFIG}`)} > ${shq(`${avdDir}/config.ini`)}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---- agent-device in the box ----

/** agent-device's install in the box, the wrapper's folder (first on the agent's PATH) and its skill's plugin. */
export const AGENT_DEVICE_DIR = `${BOX_ROOT}/agent-device`;
export const BOX_BIN_DIR = `${AGENT_DEVICE_DIR}/bin`;
export const BOX_PLUGIN_DIR = `${AGENT_DEVICE_DIR}/plugin`;
const ENTRY = `${AGENT_DEVICE_DIR}/node_modules/agent-device/bin/agent-device.mjs`;

/** An agent session's own folder in the box, by a name safe in a path whatever its id. */
const sessionHome = (thread: string) =>
  `${BOX_ROOT}/sessions/${/^[A-Za-z0-9._-]{1,128}$/.test(thread) && !/^\.+$/.test(thread) ? thread : createHash("sha256").update(thread).digest("hex").slice(0, 32)}`;
/** Its agent-device home (config, and its daemon's state below it), and the file that says a person has control. */
export const boxSessionDir = (thread: string) => `${sessionHome(thread)}/agent-device`;
export const boxControlPath = (thread: string) => `${sessionHome(thread)}/device-control`;

/**
 * What the agent's claude in the box gets in its environment for its phone: agent-device's wrapper first on PATH, its
 * own agent-device home and state, and the control file the wrapper checks (../device/agent_device.ts agentEnv).
 */
export function boxAgentEnv(thread: string, path?: string): [string, string][] {
  const dir = boxSessionDir(thread);
  return [
    ["PATH", path ? `${BOX_BIN_DIR}:${path}` : BOX_BIN_DIR],
    ["AGENT_DEVICE_HOME", dir],
    ["AGENT_DEVICE_STATE_DIR", `${dir}/state`],
    ["FLEETD_DEVICE_CONTROL", boxControlPath(thread)],
  ];
}

/**
 * Fetches what drives the emulator from inside the box, checked by digest, once: scrcpy's server and the ffmpeg that
 * decodes its stream, agent-device (npm's tarball, its integrity digest) with its skill as a plugin, and the wrapper.
 */
export function toolsScript(): string {
  const lines = [...HEAD];
  for (const p of CLIENT_PACKAGES()) if (p.dest !== "sdk") lines.push(...fetchLines(p));
  const sha512 = Buffer.from(AGENT_DEVICE_INTEGRITY.replace(/^sha512-/, ""), "base64").toString("hex");
  const manifest = JSON.stringify({
    name: "agent-device",
    description: "agent-device's skill, for the Android session fleetd opens with session_start kind android.",
  });
  lines.push(
    `A=${shq(AGENT_DEVICE_DIR)}`,
    'if [ ! -e "$A/.done" ]; then',
    '  rm -rf "$A" && mkdir -p "$A/node_modules/agent-device" "$A/plugin/skills/agent-device" "$A/plugin/.claude-plugin" "$A/bin"',
    `  curl -fsSL -o "$R/dl/agent-device.tgz" ${shq(AGENT_DEVICE_URL)}`,
    `  echo "${sha512}  $R/dl/agent-device.tgz" | sha512sum -c - >/dev/null`,
    '  tar -xzf "$R/dl/agent-device.tgz" -C "$A/node_modules/agent-device" --strip-components=1 && rm -f "$R/dl/agent-device.tgz"',
    `  curl -fsSL -o "$A/plugin/skills/agent-device/SKILL.md" ${shq(AGENT_DEVICE_SKILL_URL)}`,
    `  echo "${AGENT_DEVICE_SKILL_SHA256}  $A/plugin/skills/agent-device/SKILL.md" | sha256sum -c - >/dev/null`,
    `  printf '%s\\n' ${shq(manifest)} > "$A/plugin/.claude-plugin/plugin.json"`,
    `  printf %s ${shq(wrapperScript(ENTRY, boxSdk()))} > "$A/bin/agent-device" && chmod 755 "$A/bin/agent-device"`,
    '  touch "$A/.done"',
    "fi",
  );
  return `${lines.join("\n")}\n`;
}

/** Fetches the tools alone (toolsScript), for a box whose claude should have agent-device's skill and wrapper from its
 * start, before any session boots the emulator. */
export const toolsIn = (box: Pick<Box, "run">) => sh(box, toolsScript(), 900).then(() => undefined);

/**
 * What an agent's own box needs when its emulator runs in another box (../device/devices.ts DeviceHost `agentBox`):
 * the tools (toolsScript) and adb (the SDK's platform-tools alone, no emulator or image), whose server is the other
 * box's, reached at ADB_SERVER_PORT on this box's loopback through its host's relay.
 */
export function agentToolsScript(): string {
  const lines = [...HEAD];
  for (const p of CLIENT_PACKAGES()) if (p.dest === "sdk" || p.dest.startsWith("sdk/")) lines.push(...fetchLines(p));
  return `${lines.join("\n")}\n${toolsScript()}`;
}
export const agentToolsIn = (box: Pick<Box, "run">) => sh(box, agentToolsScript(), 900).then(() => undefined);

// ---- the emulator ----

const PID_FILE = `${BOX_ROOT}/emulator.pid`;

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

const booted = async (box: AndroidBox) =>
  (await sh(box, `${shq(boxSdk().adb)} -s ${SERIAL} shell getprop sys.boot_completed 2>/dev/null || true`, 30).catch(() => "")).trim() === "1";
const running = async (box: AndroidBox) =>
  (await sh(box, `[ -f ${shq(PID_FILE)} ] && kill -0 "$(cat ${shq(PID_FILE)})" 2>/dev/null && echo up || true`).catch(() => "")).trim() === "up";

/**
 * The box's emulator, booted, with everything that drives it fetched: the first time in a box that fetches the pinned
 * pieces (about 1.3 GB) and boots cold; an emulator already booted there (a holder before started it) is taken as it
 * is (`reattached`).
 */
export async function bootIn(box: AndroidBox): Promise<{ reattached: boolean }> {
  const why = await kvmIn(box);
  if (why) throw new Error(`${why}, and the Android emulator needs KVM`);
  await sh(box, prepareScript(), 900);
  await sh(box, toolsScript(), 900);
  if ((await running(box)) && (await booted(box))) return { reattached: true };
  await stopEmulator(box);
  await sh(box, startScript(PID_FILE));
  const deadline = Date.now() + timing.upMs;
  while (!(await booted(box))) {
    if (Date.now() > deadline) {
      const log = await sh(box, `tail -c 800 ${shq(`${BOX_ROOT}/emulator.log`)} 2>/dev/null || true`).catch(() => "");
      await stopEmulator(box);
      throw new Error(`the emulator in the sandbox didn't boot within ${timing.upMs / 1000} s${log.trim() ? `: ${log.trim()}` : ""}`);
    }
    await Bun.sleep(timing.pollMs);
  }
  // Settled for automation, as the node's own device is (../device/sdk.ts snapshot).
  const adb = shq(boxSdk().adb);
  await sh(box, ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"].map((k) => `${adb} -s ${SERIAL} shell settings put global ${k} 0`).join("; "), 60).catch(() => "");
  return { reattached: false };
}

/** Kills the emulator's process session, and the box's adb server. */
export const stopEmulator = (box: Pick<Box, "run">) =>
  sh(box, `${killSession(PID_FILE)}; rm -f ${shq(PID_FILE)}; ${shq(boxSdk().adb)} kill-server >/dev/null 2>&1; true`).catch(() => "");

/** Points the agent session's agent-device at the box's emulator. */
export const pointAgent = (box: AndroidBox, thread: string) =>
  box.write(`${boxSessionDir(thread)}/config.json`, enc(`${JSON.stringify({ platform: "android", serial: SERIAL })}\n`), 0o600);

/** Says to the agent's wrapper that a person has the device (`human`), or that they don't. */
export const controlIn = (box: AndroidBox, thread: string, human: boolean) =>
  human ? box.write(boxControlPath(thread), enc("human\n"), 0o600) : sh(box, `rm -f ${shq(boxControlPath(thread))}`).then(() => undefined);

/** Ends the agent session's agent-device daemon, if one runs, and drops its config and control file. */
export const releaseAgent = (box: AndroidBox, thread: string) => {
  const dir = boxSessionDir(thread);
  return sh(
    box,
    `p=$(sed -n 's/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p' ${shq(`${dir}/state/daemon.json`)} 2>/dev/null | head -n1); [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; rm -f ${shq(`${dir}/config.json`)} ${shq(boxControlPath(thread))}; true`,
  ).catch(() => "");
};

// ---- the part ----

/** Where a session's part runs in the box, and how a holder reaches it. Its token is the part's word that a
 * connection is the holder's: readable to anything root in the box. */
export type PartHandle = { port: number; token: string };

const partDir = (sessionId: string) => `${BOX_ROOT}/parts/${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}`;

/** Starts a session's part in the box, in a process session of its own that outlives the call, and answers where it
 * listens once it does. */
export async function startPart(box: AndroidBox, sessionId: string): Promise<PartHandle> {
  const token = hex(24);
  const dir = partDir(sessionId);
  const portFile = `${dir}/port`;
  const sdk = boxSdk();
  const scid = (Number.parseInt(hex(4), 16) & 0x7fffffff).toString(16).padStart(8, "0");
  const config = {
    portFile,
    token,
    graceMs: timing.graceMs,
    adb: sdk.adb,
    serial: SERIAL,
    env: boxEnv(),
    jar: sdk.scrcpyServer,
    serverPath: SERVER_PATH,
    scid,
    serverArgs: serverArgs(scid),
    ffmpeg: sdk.ffmpeg,
    decoderArgs: DECODER_ARGS,
  };
  await box.write(`${BOX_ROOT}/android_part.mjs`, enc(part), 0o644);
  await box.write(`${dir}/config.json`, enc(JSON.stringify(config)), 0o600);
  await sh(box, `cd ${shq(dir)} && setsid bun ${shq(`${BOX_ROOT}/android_part.mjs`)} config.json </dev/null >>part.log 2>&1 & echo $! > ${shq(`${dir}/part.pid`)}`);
  const deadline = Date.now() + timing.reachMs;
  for (;;) {
    const said = await box.read(portFile, 16).then((b) => Number(new TextDecoder().decode(b).trim()), () => 0);
    if (Number.isInteger(said) && said > 0 && said < 65_536) return { port: said, token };
    if (Date.now() > deadline) {
      const log = await sh(box, `tail -c 400 ${shq(`${dir}/part.log`)} 2>/dev/null || true`).catch(() => "");
      await stopPart(box, sessionId);
      throw new Error(`the screen's part didn't start in the box within ${timing.reachMs / 1000} s${log.trim() ? `: ${log.trim()}` : ""}`);
    }
    await Bun.sleep(Math.min(timing.pollMs, 200));
  }
}

/** Ends a session's part (its stream, its decoder) and its folder. */
export const stopPart = (box: Pick<Box, "run">, sessionId: string) => {
  const dir = partDir(sessionId);
  return sh(box, `${killSession(`${dir}/part.pid`)}; rm -rf ${shq(dir)}; true`).catch(() => "");
};

/** What a part tells its holder. */
export type PartEvents = {
  /** A frame of the screen, as JPEG: `seq` 1, 2, … for the part's stream. */
  frame(seq: number, jpeg: Uint8Array): void;
  /** Why the stream went, in the part's words. */
  note(text: string): void;
  /** The connection dropped (the box's link, the part's grace, the part's end). */
  closed(): void;
};

const record = (type: number, body: Uint8Array) => {
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = type;
  out.set(body, 5);
  return out;
};

/** One connection to a session's part. */
export class PartLink {
  private buf: Buffer = Buffer.alloc(0);
  private gone = false;

  constructor(
    private readonly stream: Duplex,
    token: string,
    private readonly on: PartEvents,
  ) {
    stream.on("data", (d: Buffer) => this.data(d));
    stream.on("error", () => {});
    stream.once("close", () => this.close());
    stream.once("end", () => this.close());
    stream.write(`${token}\n`);
  }

  private close(): void {
    if (this.gone) return;
    this.gone = true;
    this.on.closed();
  }

  private data(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const type = this.buf[4];
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (type === 1 && body.length > 4) this.on.frame(body.readUInt32BE(0), Uint8Array.from(body.subarray(4)));
      else if (type === 2) this.on.note(body.toString("utf8"));
    }
  }

  /** Whether the connection is still up. */
  get open(): boolean {
    return !this.gone;
  }

  /** A person's input, as scrcpy's control messages; false when the connection is gone. */
  control(messages: Uint8Array[]): boolean {
    if (this.gone) return false;
    for (const m of messages) this.stream.write(record(3, m));
    return true;
  }

  /** Tells the part to end its stream and exit, then drops the connection. */
  stop(): void {
    if (!this.gone) this.stream.write(record(4, new Uint8Array()));
    this.stream.end();
  }

  /** Drops the connection, ending nothing: the part waits its grace for the next one. */
  drop(): void {
    this.stream.destroy();
  }
}

/** A connection to a session's part once it listens, trying again until `ms` is up. */
export async function dialPart(box: AndroidBox, handle: PartHandle, on: PartEvents, ms = 30_000): Promise<PartLink> {
  return new PartLink(await dialUntil(box, handle.port, ms), handle.token, on);
}
