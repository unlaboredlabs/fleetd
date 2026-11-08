// What the agents' Mac installs for itself, pinned and checked by digest (crates/fleetd/src/node/agents_mac/tools.rs):
// Node.js, which agent-device runs on, into `<node home>/mac`; agent-device, which drives iOS simulators; and
// agent-desktop, which drives the Mac's own apps. Nothing comes from the person's Homebrew, which agents can't write and
// must not plant binaries in. CocoaPods alone does, and the tools check says how (checks.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { install as installAgentDesktop, VERSION as AGENT_DESKTOP } from "../desktop/mac/agent_desktop.ts";
import { findAgentDevice, install as installAgentDevice, VERSION as AGENT_DEVICE } from "../device/agent_device.ts";
import { toolsDir } from "./common.ts";

/** The Node.js release the Mac installs (an LTS). */
export const NODE_VERSION = "24.22.2";
/** The agent-device and agent-desktop releases the node pins (node/device's and the Mac screen's). */
export const AGENT_DEVICE_VERSION = AGENT_DEVICE;
export const AGENT_DESKTOP_VERSION = AGENT_DESKTOP;

/** nodejs.org's SHASUMS256.txt for each of its macOS tarballs. */
const NODE_SHA256: Record<string, string> = {
  arm64: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
  x64: "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
};

/** Where the pinned tools stand. */
export type ToolsState = { kind: "ready"; versions: string } | { kind: "installing" } | { kind: "failed"; why: string };

export const versions = () => `Node.js ${NODE_VERSION}, agent-device ${AGENT_DEVICE_VERSION}, agent-desktop ${AGENT_DESKTOP_VERSION}.`;

const arch = () => (process.arch === "arm64" ? "arm64" : "x64");

export const nodeDir = (home: string) => join(toolsDir(home), "node");
/** The directory to put first on PATH for agent-device and agents' own Node.js work on the Mac. */
export const nodeBin = (home: string) => join(nodeDir(home), "bin");

const pinned = (dir: string, version: string) => {
  try {
    return readFileSync(join(dir, "VERSION"), "utf8").trim() === version;
  } catch {
    return false;
  }
};

/** The install, as the checks read it. */
export class Installing {
  state: ToolsState = { kind: "installing" };

  /** Installs what isn't in place at its pinned version, once. */
  async run(home: string, fetcher: typeof fetch = fetch): Promise<void> {
    try {
      await install(home, fetcher);
      this.state = { kind: "ready", versions: versions() };
    } catch (e) {
      console.warn(`the agents' Mac's tools didn't install: ${(e as Error).message}`);
      this.state = { kind: "failed", why: (e as Error).message };
    }
  }
}

async function install(home: string, fetcher: typeof fetch): Promise<void> {
  if (process.platform !== "darwin") throw new Error("the agents' Mac's tools run on macOS only");
  if (!pinned(nodeDir(home), NODE_VERSION) || !existsSync(join(nodeBin(home), "node"))) await installNode(home, fetcher);
  if (!findAgentDevice(home)) await installAgentDevice(home);
  await installAgentDesktop(home, fetcher);
}

/** Downloads, checks and unpacks the pinned Node.js into `<home>/mac/node`. */
export async function installNode(home: string, fetcher: typeof fetch = fetch, platformArch = arch()): Promise<void> {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${platformArch}.tar.gz`;
  let tarball: Uint8Array;
  try {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`HTTP status ${res.status}`);
    tarball = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`cannot download Node.js: ${(e as Error).message}`);
  }
  const digest = createHash("sha256").update(tarball).digest("hex");
  if (digest !== NODE_SHA256[platformArch]) throw new Error(`Node.js's tarball is not the pinned one (sha256 ${digest})`);
  const dir = nodeDir(home);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = `${dir}.tgz`;
  writeFileSync(file, tarball);
  const tar = Bun.spawn(["tar", "-xzf", file, "-C", dir, "--strip-components=1"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [said, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
  rmSync(file, { force: true });
  if (code !== 0) throw new Error(`unpacking Node.js failed: ${said.trim()}`);
  writeFileSync(join(dir, "VERSION"), NODE_VERSION);
}
