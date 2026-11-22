// `fleetd node leave`: this computer stops being the hub's agents' Mac (the app's Stop being the agents' Mac runs it).
// In order: the node's service stops and its unit goes, so nothing dials the hub as this machine again; the hub is told
// over a link of the Mac's own (node/agents_mac/leave.ts) and removes the machine; then the node's home goes, with its
// key and node.json. A hub not reached in time still leaves this computer clean: the last line says so, and the hub
// shows the machine offline until an admin removes it there.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tellHub, type Told } from "../node/agents_mac/leave.ts";
import { readConfig, type NodeConfig } from "../node/config.ts";
import { loadOrCreateIdentity } from "../node/identity.ts";
import { localDirs, localPlatform, localUid } from "./setup/shared.ts";
import { foreignUnit, ServiceManager, unitPath } from "./setup/units.ts";

/** What leaving reaches outside this process: the service, the hub, the files. Tests pass their own. */
export interface LeavePorts {
  /** Stops and removes the node's service; why not, when it couldn't. */
  stopService(home: string): string | undefined;
  tellHub(config: NodeConfig, home: string): Promise<Told>;
  remove(home: string): void;
  say(line: string): void;
}

/** The last line, which the app reads: `left: removed` (the hub removed it), `left: unreached` or `left: old` (this
 * computer is clean, the hub still lists it), `left: none` (it had joined no hub). */
export const LEFT = "left: ";

export async function leave(home: string, ports: LeavePorts): Promise<number> {
  let config: NodeConfig | undefined;
  try {
    config = readConfig(home);
  } catch {}
  // Only the agents' Mac leaves by itself: a worker holds bots and their worktrees, which Remove in the app erases
  // with care (machine_remove), never this.
  if (config !== undefined && config.agentsMac !== true) {
    ports.say(`fleetd: ${config.machineId} isn't the agents' Mac, so it doesn't leave by itself. Fix: remove it from the app, Settings › Hub › Machines`);
    return 1;
  }
  const stopped = ports.stopService(home);
  if (stopped !== undefined) {
    ports.say(`fleetd: the node's service didn't stop: ${stopped}. Fix: log in as this user at the Mac's screen, then try again`);
    return 1;
  }
  const told: Told | "none" = config?.enrolled === true && existsSync(join(home, "node-key.pem")) ? await ports.tellHub(config, home) : "none";
  try {
    ports.remove(home);
  } catch (error) {
    ports.say(`fleetd: the node's files in ${home} weren't deleted: ${(error as Error).message}`);
    return 1;
  }
  if (told === "removed") ports.say(`${config!.machineId} left ${config!.hub}.`);
  else if (told !== "none") {
    ports.say(
      told === "old"
        ? `${config!.hub} is too old to let a machine leave by itself: it shows ${config!.machineId} offline until an admin removes it there.`
        : `${config!.hub} wasn't reached: it shows ${config!.machineId} offline until an admin removes it there.`,
    );
  }
  ports.say(`${LEFT}${told}`);
  return 0;
}

function stopService(home: string): string | undefined {
  const platform = localPlatform();
  if (platform === undefined) return undefined;
  const unitFile = (role: "node" | "hub") => unitPath(platform, localDirs(), role);
  const file = unitFile("node");
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  // Another fleet's node (a relocated fleetd): not this one's to stop.
  if (foreignUnit(text, home)) return undefined;
  const ran = Bun.spawnSync(["/bin/sh", "-c", new ServiceManager(platform, localUid(), unitFile).remove("node")], { stdout: "ignore", stderr: "pipe" });
  if (ran.exitCode !== 0) return ran.stderr.toString().trim() || `exit ${String(ran.exitCode)}`;
  try {
    rmSync(file, { force: true });
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

export function leaveCommand(home: string): Promise<number> {
  return leave(home, {
    stopService,
    tellHub: (config, at) => tellHub(config, loadOrCreateIdentity(at)),
    remove: (at) => rmSync(at, { recursive: true, force: true }),
    say: (line) => (line.startsWith("fleetd: ") ? process.stderr : process.stdout).write(`${line}\n`),
  });
}
