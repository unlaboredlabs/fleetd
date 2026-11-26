// `fleetd workspace stop|restart`: the workspace's service on this machine, the one `fleetd init` wrote, stopped or
// (re)started through the user's service manager, so nobody needs its unit's name (fleetd-hub.service,
// sh.fleetd.hub.plist). The unit keeps the old name: renaming it would strand every install that has one.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ArgError, parse } from "./args.ts";
import { currentExe } from "./setup/shared.ts";
import { WORKSPACE_USAGE } from "./usages.ts";
import { isHubService, restartCommand, services, unitAffixes, unitDir, userManagerEnv, type Service } from "../update/service.ts";

type Step = [cmd: string, args: string[]];

const uid = () => String(process.getuid?.() ?? "");

/** The service manager's commands for `what` on `service`. `loaded`: whether launchd has it (macOS only); a stopped
 * one was booted out, so starting it is a bootstrap, which starts it as it loads. */
export function serviceSteps(what: "stop" | "restart", service: Service, platform: NodeJS.Platform, loaded: boolean): Step[] {
  if (platform !== "darwin") return [["systemctl", ["--user", what, service.name]]];
  const [prefix] = unitAffixes();
  const label = `gui/${uid()}/${prefix}${service.unit}`;
  if (what === "stop") return loaded ? [["launchctl", ["bootout", label]]] : [];
  return loaded ? [restartCommand(service)] : [["launchctl", ["bootstrap", `gui/${uid()}`, join(unitDir(), service.name)]]];
}

const launchdHas = (service: Service): boolean => {
  const [prefix] = unitAffixes();
  return spawnSync("launchctl", ["print", `gui/${uid()}/${prefix}${service.unit}`], { stdio: "ignore" }).status === 0;
};

export async function serviceCommand(what: "stop" | "restart", argv: string[]): Promise<number> {
  const v = parse(argv, { options: {}, positionals: false });
  if (v instanceof ArgError) {
    process.stderr.write(`fleetd: ${v.message}\n\nusage:\n${WORKSPACE_USAGE}`);
    return 2;
  }
  let exe: string | undefined;
  try {
    exe = currentExe();
  } catch {}
  const service = exe === undefined ? undefined : services(exe).find(isHubService);
  if (service === undefined) {
    process.stderr.write("fleetd: no workspace service of this fleetd here. Fix: fleetd init sets one up\n");
    return 1;
  }
  const loaded = process.platform === "darwin" && launchdHas(service);
  for (const [cmd, args] of serviceSteps(what, service, process.platform, loaded)) {
    const r = spawnSync(cmd, args, { stdio: "ignore", env: userManagerEnv() });
    const why = r.error ? r.error.message : r.status !== 0 ? `${cmd} exited with ${r.status}` : undefined;
    if (why !== undefined) {
      process.stderr.write(
        `fleetd: couldn't ${what} the workspace: ${why}. Fix: log in as this user at the machine's screen, then run fleetd workspace ${what} again\n`,
      );
      return 1;
    }
  }
  process.stdout.write(what === "stop" ? "stopped the workspace\n" : "restarted the workspace\n");
  return 0;
}
