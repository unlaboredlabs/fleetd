// The Android pins, with nothing of the machine's: what a node installs for its own emulators (./sdk.ts) and what a
// hosted box fetches for its own (../place/box_emulator.ts), each checked by digest, so both run the same versions.
// Pure (docs/CONTRIBUTING.md "The package"): the box side imports it.
import { dirname } from "node:path";

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

export type Package = { url: string; sha1?: string; sha256?: string; dest: string; unpack: "zip" | "tar.xz" | "file" };

export const PACKAGES: Package[] = [
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
export const AVD_CONFIG = `avd.ini.encoding=UTF-8
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

/** The node's install, as sessions use it. */
export type Sdk = {
  root: string;
  adb: string;
  emulator: string;
  avdHome: string;
  emulatorHome: string;
  scrcpyServer: string;
  ffmpeg: string;
  /** The adb server's port, where it isn't the node's own (ADB_SERVER_PORT): one in an agent's hosted box, reached
   * here through a port of this machine's (../place/box_android.ts). */
  adbPort?: number;
  /** A port of this machine's that reaches `port` where the adb server runs, for scrcpy's forward; absent: the same
   * port here. */
  reach?: (port: number) => Promise<number>;
};

/** What a node needs to drive an emulator that runs elsewhere (in an agent's hosted box): adb, scrcpy's server and the
 * ffmpeg that decodes its stream, without the emulator or its image. */
export const CLIENT_PACKAGES = (): Package[] => PACKAGES.filter((p) => p.url.includes("platform-tools") || !(p.dest === "sdk" || p.dest.startsWith("sdk/")));
/** What the emulator itself needs: the SDK's pieces, platform-tools, the emulator and its image. */
export const EMULATOR_PACKAGES = (): Package[] => PACKAGES.filter((p) => p.dest === "sdk" || p.dest.startsWith("sdk/"));

/** The agent-device release the node installs. */
export const AGENT_DEVICE_VERSION = "0.21.31";

/** Its npm package, checked against npm's own integrity digest for it. */
export const AGENT_DEVICE_URL = "https://registry.npmjs.org/agent-device/-/agent-device-0.21.31.tgz";
export const AGENT_DEVICE_INTEGRITY =
  "sha512-541X/tXHqQS3Xg5PutPSek1nQFLgEJEXFdLPiZ9jTvSb+SMHr/Z4kzVCnBkGza59R+EHO1atLWx0ZAW5vK84IQ==";

/** Its skill, from the same tag (the npm package leaves it out), checked by digest. */
export const AGENT_DEVICE_SKILL_URL = "https://raw.githubusercontent.com/callstack/agent-device/v0.21.31/skills/agent-device/SKILL.md";
export const AGENT_DEVICE_SKILL_SHA256 = "ad3b4ccbd2d43c3baae80a5b0d5aaad14becffb49fabccb6c93d61d44dcd6698";

/** What the wrapper says while a person has control. */
export const PAUSED =
  "A person has control of the device now. You are told the moment they hand it back (carry on with other work meanwhile, or end your turn); your next agent-device command after that sees the screen as they left it.";

/**
 * The wrapper: refuses while the session's control file says a person has the device, else runs agent-device with the
 * node's SDK and adb (on the node's own adb server port). Those are set here only, for agent-device: an agent's own
 * `ANDROID_HOME`, `PATH` and adb stay as they were for its own Android work.
 */
export function wrapperScript(entryPath: string, sdk: Pick<Sdk, "root" | "adb">): string {
  const quote = (p: string) => p.replaceAll("'", "'\\''");
  return (
    "#!/bin/sh\n" +
    `# fleetd's: agent-device ${AGENT_DEVICE_VERSION}, pointed at this session's emulator.\n` +
    'if [ -n "$FLEETD_DEVICE_CONTROL" ] && [ -e "$FLEETD_DEVICE_CONTROL" ]; then\n' +
    `  echo '${quote(PAUSED)}' >&2\n  exit 75\nfi\n` +
    `ANDROID_HOME='${quote(sdk.root)}'\nANDROID_SDK_ROOT='${quote(sdk.root)}'\nPATH='${quote(dirname(sdk.adb))}':"$PATH"\n` +
    `ANDROID_ADB_SERVER_PORT=${ADB_SERVER_PORT}\n` +
    "export ANDROID_HOME ANDROID_SDK_ROOT PATH ANDROID_ADB_SERVER_PORT\n" +
    `exec node '${quote(entryPath)}' "$@"\n`
  );
}

