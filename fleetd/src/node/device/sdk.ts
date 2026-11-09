// What an android session needs on its node, each pinned and checked by
// digest: Google's platform-tools (adb), its emulator and an Android 15 Google APIs system image, scrcpy's server (the
// live view and the video, scrcpy.ts) and an ffmpeg that decodes its H.264 stream; agent-device comes from npm
// (agent_device.ts). All of it lives under `<node home>/device/`, with no Java: the node writes the virtual device's
// files itself rather than run avdmanager.
//
// Once installed, the node boots the device cold once, turns its animations off and saves its Quick Boot snapshot
// (`default_boot`): every session's copy starts from that snapshot with `-read-only`, so nothing it does is kept.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../secrets/files.ts";
import { freePort, spawnEmulator, waitBooted } from "./emulator.ts";

/** The pins, together: a change to any of them installs again, and makes the snapshot again. */
export const PINS =
  "platform-tools 37.0.1, emulator 37.2.12, android-35 google_apis x86_64 r09, scrcpy 5.0.1, ffmpeg 6.0.1";
/** scrcpy's server: the node speaks its protocol itself, so the version must match the jar exactly. */
export const SCRCPY_VERSION = "5.0.1";
/**
 * The port of the node's own adb server: never a person's 5037, whose adb may be another version (each would kill
 * the other's server) and whose own devices aren't the agents'.
 */
export const ADB_SERVER_PORT = 15037;
/** The virtual device sessions copy. */
export const AVD = "fleetd-android-35";

type Package = { url: string; sha1?: string; sha256?: string; dest: string; unpack: "zip" | "tar.xz" | "file" };

const PACKAGES: Package[] = [
  {
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip",
    sha1: "477254aa5f903c15cf51001717bdf347fb6b53e0",
    dest: "sdk",
    unpack: "zip",
  },
  {
    url: "https://dl.google.com/android/repository/emulator-linux_x64-16428233.zip",
    sha1: "cd7362ea55dfb86a418958138dc396e74165dd01",
    dest: "sdk",
    unpack: "zip",
  },
  {
    url: "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip",
    sha1: "0103e6dab21290c4b9d16550a3ce99476f884eef",
    dest: "sdk/system-images/android-35/google_apis",
    unpack: "zip",
  },
  {
    url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
    sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",
    dest: "scrcpy-server.jar",
    unpack: "file",
  },
  {
    url: "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz",
    sha256: "28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5",
    dest: "ffmpeg",
    unpack: "tar.xz",
  },
];

export const packageUrls = () => PACKAGES.map((p) => p.url);

/** The virtual device's settings: a 720×1600 phone, small enough to stream and record cheaply. */
const AVD_CONFIG = `avd.ini.encoding=UTF-8
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.ramSize=2048
hw.lcd.width=720
hw.lcd.height=1600
hw.lcd.density=320
hw.keyboard=yes
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
disk.dataPartition.size=4G
image.sysdir.1=system-images/android-35/google_apis/x86_64/
tag.id=google_apis
target=android-35
PlayStore.enabled=false
fastboot.forceColdBoot=no
fastboot.forceFastBoot=yes
`;

/** A cold boot of the image takes about 20 s on a KVM host; this allows a slow one. */
const COLD_BOOT = 240_000;

export const deviceDir = (home: string) => join(home, "device");

/** The node's install, as sessions use it. */
export type Sdk = {
  root: string;
  adb: string;
  emulator: string;
  avdHome: string;
  emulatorHome: string;
  scrcpyServer: string;
  ffmpeg: string;
};

export function sdkAt(home: string): Sdk {
  const dir = deviceDir(home);
  const root = join(dir, "sdk");
  return {
    root,
    adb: join(root, "platform-tools/adb"),
    emulator: join(root, "emulator/emulator"),
    avdHome: join(dir, "avd"),
    emulatorHome: join(dir, "emulator-home"),
    scrcpyServer: join(dir, "scrcpy-server.jar"),
    ffmpeg: join(dir, "ffmpeg/ffmpeg-6.0.1-amd64-static/ffmpeg"),
  };
}

/** The environment the emulator and adb run with. */
export function sdkEnv(sdk: Sdk): Record<string, string> {
  return {
    ANDROID_HOME: sdk.root,
    ANDROID_SDK_ROOT: sdk.root,
    ANDROID_AVD_HOME: sdk.avdHome,
    ANDROID_EMULATOR_HOME: sdk.emulatorHome,
    // The copies' temporary files, which may be large: on disk, not in a /tmp that may be memory.
    ANDROID_TMP: join(sdk.emulatorHome, "tmp"),
    ANDROID_ADB_SERVER_PORT: String(ADB_SERVER_PORT),
  };
}

/** `adb -s <serial> <args…>` with the node's SDK: its stdout, stderr and exit code, killed past `timeoutMs`. */
export async function adb(
  sdk: Sdk,
  serial: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([sdk.adb, "-s", serial, ...args], {
    env: { ...process.env, ...sdkEnv(sdk) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The marker a finished install leaves: the pins it installed. */
const marker = (home: string) => join(deviceDir(home), "INSTALLED");
/** The marker the snapshot leaves once saved. */
const snapshotMarker = (home: string) => join(deviceDir(home), "SNAPSHOT");
export const markers = (home: string) => ({ installed: marker(home), snapshot: snapshotMarker(home) });

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The install, when it is the pinned one with its snapshot saved. */
export function findSdk(home: string): Sdk | undefined {
  const pinned = (path: string) => {
    try {
      return readFileSync(path, "utf8").trim() === PINS;
    } catch {
      return false;
    }
  };
  const sdk = sdkAt(home);
  const there = pinned(marker(home)) && pinned(snapshotMarker(home)) && [sdk.adb, sdk.emulator, sdk.scrcpyServer, sdk.ffmpeg].every(isFile);
  return there ? sdk : undefined;
}

/** Android sessions run on Linux x86_64 with KVM (Google's emulator needs hardware acceleration for an x86_64 image). */
export const supported = () => process.platform === "linux" && process.arch === "x64";

/**
 * How the emulator gets /dev/kvm: this process opens it (`direct`), or the user joined group kvm after the node
 * started, so its process lacks the group (`sg`): `sg kvm` starts the emulator with the group, as a fresh login would,
 * with no restart and no password.
 */
export type Kvm = "direct" | "sg";
/** Why this process can't use KVM, with the command that fixes it when a person can. */
export type KvmRefusal = { why: string; fix?: string };
export type KvmCheck = () => { ok: Kvm } | { err: KvmRefusal };

let sgOpened = false;
/** Whether `sg kvm` gives a command read-write /dev/kvm. Once it does, it always will: the answer is kept. */
function sgOpens(dev: string): boolean {
  if (sgOpened) return true;
  const q = quoted(dev);
  const ran = Bun.spawnSync(["sg", "kvm", "-c", `test -r ${q} && test -w ${q}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  sgOpened = ran.success;
  return sgOpened;
}

/** The machine's own KVM, as sessions use it. */
export const kvm: KvmCheck = () => {
  if (!supported()) return { err: { why: "Android screens run only on Linux x86_64 machines with KVM." } };
  return kvmAt("/dev/kvm", "/etc/group", sgOpens);
};

/** A word for `sh -c`, single-quoted. */
export const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

export function kvmAt(dev: string, groupFile: string, sgOpen: (dev: string) => boolean): { ok: Kvm } | { err: KvmRefusal } {
  if (!existsSync(dev)) {
    return {
      err: {
        why: "This machine has no /dev/kvm: turn on hardware virtualization (VT-x or AMD-V) in its firmware, or nested virtualization if it is a VM.",
      },
    };
  }
  // Open it as the emulator will: whatever grants it (a group, an ACL, a udev rule), this is the answer.
  try {
    closeSync(openSync(dev, "r+"));
    return { ok: "direct" };
  } catch {
    // Not this process's to open.
  }
  const user = process.env.USER || "$USER";
  let joined = false;
  try {
    joined = readFileSync(groupFile, "utf8")
      .split("\n")
      .some((line) => {
        const fields = line.split(":");
        return fields[0] === "kvm" && (fields[3] ?? "").split(",").includes(user);
      });
  } catch {
    joined = false;
  }
  if (joined && sgOpen(dev)) return { ok: "sg" };
  if (joined) {
    return {
      err: {
        why: `${user} is in group kvm, but fleetd's node started before that and \`sg kvm\` can't give it the group, so it can't open /dev/kvm. Reboot this machine when no agents are running: that stops the node's agents (and, on the hub's own machine, the hub) until it is back.`,
      },
    };
  }
  return {
    err: {
      why: `${user} can't open /dev/kvm read-write: the command adds them to group kvm. The node then starts the emulator with that group through \`sg kvm\`, within minutes, with no restart.`,
      fix: `sudo usermod -aG kvm ${user}`,
    },
  };
}

/** The virtual device's two files, as avdmanager would write them. */
export function writeAvd(sdk: Sdk): void {
  const avdDir = join(sdk.avdHome, `${AVD}.avd`);
  mkdirSync(avdDir, { recursive: true });
  mkdirSync(join(sdk.emulatorHome, "tmp"), { recursive: true });
  writeFileSync(join(sdk.avdHome, `${AVD}.ini`), `avd.ini.encoding=UTF-8\npath=${avdDir}\ntarget=android-35\n`);
  const config = join(avdDir, "config.ini");
  const wanted = `AvdId=${AVD}\navd.ini.displayname=${AVD}\n${AVD_CONFIG}`;
  let now: string | undefined;
  try {
    now = readFileSync(config, "utf8");
  } catch {
    now = undefined;
  }
  if (now !== wanted) {
    // A changed device needs its data and snapshot made again.
    rmSync(avdDir, { recursive: true, force: true });
    mkdirSync(avdDir, { recursive: true });
    writeFileSync(config, wanted);
  }
}

/**
 * Installs every pinned piece that isn't, then makes the virtual device and its snapshot. Minutes: about 2 GB comes
 * down, and the device boots cold once.
 */
export async function install(home: string, kvmCheck: KvmCheck = kvm): Promise<Sdk> {
  if (!supported()) throw new Error("Android screens run only on Linux x86_64");
  const dir = deviceDir(home);
  let installed = false;
  try {
    installed = readFileSync(marker(home), "utf8").trim() === PINS;
  } catch {
    installed = false;
  }
  if (!installed) {
    rmSync(snapshotMarker(home), { force: true });
    for (const dest of ["sdk", "ffmpeg", "scrcpy-server.jar"]) rmSync(join(dir, dest), { recursive: true, force: true });
    const downloads = join(dir, "downloads");
    mkdirSync(downloads, { recursive: true });
    for (const pkg of PACKAGES) {
      const file = join(downloads, pkg.url.split("/").at(-1) ?? "download");
      await download(pkg, file);
      await unpackTo(file, join(dir, pkg.dest), pkg.unpack);
      rmSync(file, { force: true });
    }
    rmSync(downloads, { recursive: true, force: true });
    writeAtomic(marker(home), PINS);
  }
  const sdk = sdkAt(home);
  writeAvd(sdk);
  await snapshot(sdk, kvmCheck);
  writeAtomic(snapshotMarker(home), PINS);
  const found = findSdk(home);
  if (!found) throw new Error("the install left something out");
  return found;
}

/** Downloads a package to `file`, checking its digest as it comes. */
async function download(pkg: Package, file: string): Promise<void> {
  const name = pkg.url.split("/").at(-1) ?? pkg.url;
  let response: Response;
  try {
    response = await fetch(pkg.url);
  } catch (e) {
    throw new Error(`cannot download ${name}: ${(e as Error).message}`);
  }
  if (!response.ok || !response.body) throw new Error(`cannot download ${name}: HTTP ${response.status}`);
  const hash = createHash(pkg.sha1 ? "sha1" : "sha256");
  const out = Bun.file(file).writer();
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      out.write(chunk);
    }
  } catch (e) {
    throw new Error(`downloading ${name} failed: ${(e as Error).message}`);
  } finally {
    await out.end();
  }
  const got = hash.digest("hex");
  if (got !== (pkg.sha1 ?? pkg.sha256)) {
    rmSync(file, { force: true });
    throw new Error(`${name} is not the pinned build (digest ${got})`);
  }
}

async function unpackTo(file: string, dest: string, unpack: Package["unpack"]): Promise<void> {
  mkdirSync(unpack === "file" ? dirname(dest) : dest, { recursive: true });
  if (unpack === "file") {
    try {
      renameSync(file, dest);
    } catch {
      copyFileSync(file, dest);
      unlinkSync(file);
    }
    return;
  }
  const argv = unpack === "zip" ? ["unzip", "-q", "-o", file, "-d", dest] : ["tar", "-xJf", file, "-C", dest];
  const ran = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [said, code] = await Promise.all([new Response(ran.stderr).text(), ran.exited]);
  if (code !== 0) throw new Error(`unpacking ${file} failed: ${[...said.trim()].slice(0, 300).join("")}`);
}

/** Boots the device cold, settles it for automation and quits it, which saves the Quick Boot snapshot copies load. */
async function snapshot(sdk: Sdk, kvmCheck: KvmCheck): Promise<void> {
  const port = freePort(new Set());
  if (port === undefined) throw new Error("no free emulator port");
  const serial = `emulator-${port}`;
  const emulator = spawnEmulator(sdk, port, false, kvmCheck);
  try {
    await waitBooted(sdk, serial, emulator, COLD_BOOT);
  } catch (e) {
    emulator.kill();
    throw new Error(`the emulator did not boot: ${(e as Error).message}`);
  }
  for (const command of [
    "settings put global window_animation_scale 0",
    "settings put global transition_animation_scale 0",
    "settings put global animator_duration_scale 0",
    "settings put global stay_on_while_plugged_in 7",
    "svc power stayon true",
  ]) {
    await adb(sdk, serial, ["shell", command]).catch(() => undefined);
  }
  await adb(sdk, serial, ["emu", "kill"]).catch(() => undefined);
  const deadline = Date.now() + 120_000;
  while (emulator.alive()) {
    if (Date.now() > deadline) {
      emulator.kill();
      throw new Error("the emulator did not save its snapshot in 2 minutes");
    }
    await Bun.sleep(250);
  }
  if (!existsSync(join(sdk.avdHome, `${AVD}.avd/snapshots/default_boot`))) throw new Error("the emulator quit without saving its snapshot");
}
