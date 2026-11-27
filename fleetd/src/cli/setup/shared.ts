// What setup's commands share: the usage, `say` (which the wizard can capture),
// listen addresses, who holds the hub's database, and this machine's dirs.
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fleetdDir } from "../../shared/home.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { homeDir } from "../common.ts";
import { SETUP_USAGE } from "../usages.ts";
export { SETUP_USAGE };

/** Where `hub start` listens unless told otherwise. */
export const DEFAULT_LISTEN = "127.0.0.1:4790";


let captured: string[] | undefined;

/** A line to stderr, or kept while the wizard captures a step's output. */
export function say(line: string) {
  if (captured) captured.push(line);
  else process.stderr.write(`${line}\n`);
}
export const capture = () => void (captured = []);
export function release(): string[] {
  const lines = captured ?? [];
  captured = undefined;
  return lines;
}

/** `host:port`, `:port` or `port`; IPv6 hosts in brackets. */
export function parseListen(value: string): [string, number] | undefined {
  const colon = value.lastIndexOf(":");
  const [rawHost, rawPort] = colon < 0 ? ["", value] : [value.slice(0, colon), value.slice(colon + 1)];
  if (!/^[0-9]+$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return undefined;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  return [host || "127.0.0.1", port];
}

export type Probe = "hub" | "other" | "free";

/** What answers at `http://host:port/healthz`: a fleetd hub, something else, or nothing. */
export async function probeListen([host, port]: [string, number]): Promise<Probe> {
  const h = host.includes(":") ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${h}:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    const body: any = await response.json().catch(() => undefined);
    return response.ok && typeof body?.protocol === "number" ? "hub" : "other";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ConnectionRefused" || code === "ECONNREFUSED" ? "free" : "other";
  }
}

/** PIDs (other than this one) with `file` open: the hub keeps hub.sqlite open while it runs. */
export function processesHolding(file: string): number[] {
  const held: number[] = [];
  if (process.platform === "linux") {
    let pids: string[];
    try {
      pids = readdirSync("/proc");
    } catch {
      return held;
    }
    for (const name of pids) {
      if (!/^[0-9]+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      if (
        fds.some((fd) => {
          try {
            return readlinkSync(`/proc/${pid}/fd/${fd}`) === file;
          } catch {
            return false;
          }
        })
      ) {
        held.push(pid);
      }
    }
    return held.sort((a, b) => a - b);
  }
  const out = Bun.spawnSync(["lsof", "-t", file], { stderr: "ignore" });
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => Number(l))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/** The programs listening on TCP `port` that this user can see, by pid and name: on Linux from /proc (a socket's
 * inode in /proc/net/tcp{,6}, then which process has it open), elsewhere from lsof. */
export function listeners(port: number): { pid: number; name: string }[] {
  if (process.platform !== "linux") {
    const out = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { stderr: "ignore" });
    const found: { pid: number; name: string }[] = [];
    for (const line of out.stdout.toString().split("\n")) {
      if (line.startsWith("p")) found.push({ pid: Number(line.slice(1)), name: "" });
      else if (line.startsWith("c") && found.length > 0) found.at(-1)!.name = line.slice(1);
    }
    return found;
  }
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    // sl local_address rem_address st … inode: the local address is HEXIP:HEXPORT, and st 0A is LISTEN.
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[3] === "0A" && parseInt(f[1]!.split(":")[1] ?? "", 16) === port) inodes.add(`socket:[${f[9]}]`);
    }
  }
  const found: { pid: number; name: string }[] = [];
  if (inodes.size === 0) return found;
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n));
  } catch {}
  for (const name of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    const holds = fds.some((fd) => {
      try {
        return inodes.has(readlinkSync(`/proc/${name}/fd/${fd}`));
      } catch {
        return false;
      }
    });
    if (!holds) continue;
    let comm = "";
    try {
      comm = readFileSync(`/proc/${name}/comm`, "utf8").trim();
    } catch {}
    found.push({ pid: Number(name), name: comm });
  }
  return found;
}

/** `--listen` of the hub process that has this home's database open. */
export function runningListen(home: string): string | undefined {
  for (const pid of processesHolding(join(home, "hub.sqlite"))) {
    const out = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stderr: "ignore" });
    const found = listenFromArgs(out.stdout.toString());
    if (found !== undefined) return found;
  }
  return undefined;
}

/** `--listen <addr>` or `--listen=<addr>` in a `fleetd hub start` command line. */
export function listenFromArgs(args: string): string | undefined {
  const words = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--listen") return words[i + 1];
    if (words[i]!.startsWith("--listen=")) return words[i]!.slice(9);
  }
  return undefined;
}

/** The workspace a node on this machine joined, and as which machine: a worker has no workspace of its own. */
export function workerOf(): { hub: string; machineId: string } | undefined {
  try {
    const node = JSON.parse(readFileSync(join(fleetdDir(), "node", "node.json"), "utf8"));
    return node?.enrolled === true && typeof node.hub === "string" && typeof node.machineId === "string" ? { hub: node.hub, machineId: node.machineId } : undefined;
  } catch {
    return undefined;
  }
}

/** The fix for a hub home without setup.json. On a worker, `fleetd init` "starting the workspace" was the wrong advice. */
export function noSetupFix(home: string): string {
  const running = runningListen(home);
  if (running !== undefined) return `a workspace you started yourself answers there: fleetd init --no-service --listen ${running}`;
  const worker = workerOf();
  if (worker !== undefined) {
    return `this machine is ${worker.machineId}, a worker of the workspace at ${worker.hub}: run this on the workspace's machine, or open ${settingsPath("Setup")} in the app; here, fleetd init checks and repairs the worker`;
  }
  return "fleetd init (it starts the workspace and repairs its setup)";
}

export type Platform = "linux" | "darwin";

export const localPlatform = (): Platform | undefined =>
  process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : undefined;

export function localDirs(): { home: string; configHome: string } {
  const home = homeDir();
  return { home, configHome: process.env.XDG_CONFIG_HOME || `${home}/.config` };
}

/** This user's uid. */
export const localUid = () => process.getuid?.() ?? 0;

/** The running executable, symlinks resolved. */
export function currentExe(): string {
  try {
    return realpathSync(process.execPath);
  } catch (error) {
    throw new Error(`cannot find the running fleetd executable: ${(error as Error).message}`);
  }
}
