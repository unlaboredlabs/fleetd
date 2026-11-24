// The hub and node services `fleetd init` created for a binary, and restarting one (crates/fleetd/src/update/
// service.rs): `systemctl --user restart`, `launchctl kickstart -k`. And whether systemd starts the user's manager,
// which runs them, again by itself.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { NodeManager } from "../shared/node_link.ts";

/** A hub or node service: its unit file's name (`fleetd-hub.service`), and the part between prefix and extension. */
export type Service = { name: string; unit: string };

export const isHubService = (s: Service) => s.unit.startsWith("hub");

export const unitAffixes = (): [string, string] => (process.platform === "darwin" ? ["sh.fleetd.", ".plist"] : ["fleetd-", ".service"]);

const home = () => process.env.HOME ?? "";

/** The hub and node services `fleetd init` created for `exe`: the unit files whose command line names it, hubs first. */
export function services(exe: string): Service[] {
  return servicesIn(unitDir(), exe);
}

/** Where the user's service manager reads the unit files `fleetd init` wrote. */
export const unitDir = () =>
  process.platform === "darwin" ? join(home(), "Library/LaunchAgents") : join(process.env.XDG_CONFIG_HOME ?? join(home(), ".config"), "systemd/user");

export function servicesIn(dir: string, exe: string): Service[] {
  const [prefix, ext] = unitAffixes();
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: Service[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
    const unit = name.slice(prefix.length, name.length - ext.length);
    if (!unit.startsWith("hub") && !unit.startsWith("node")) continue;
    try {
      if (readFileSync(join(dir, name), "utf8").includes(exe)) found.push({ name, unit });
    } catch {}
  }
  return [...found.filter(isHubService), ...found.filter((s) => !isHubService(s))];
}

const uid = () => String(process.getuid?.() ?? "");

/** What a non-PAM SSH session lacks for `systemctl --user` and `systemd-run --user`. */
export const userManagerEnv = () => ({ ...process.env, ...(process.env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid()}` }) });

/** The service manager's command that restarts `service`. */
export function restartCommand(service: Service): [cmd: string, args: string[]] {
  const [prefix] = unitAffixes();
  return process.platform === "darwin"
    ? ["launchctl", ["kickstart", "-k", `gui/${uid()}/${prefix}${service.unit}`]]
    : ["systemctl", ["--user", "restart", service.name]];
}

/** Restarts one service; the error is one plain reason. */
export function restart(service: Service): void {
  const [cmd, args] = restartCommand(service);
  const r = spawnSync(cmd, args, { stdio: "ignore", env: userManagerEnv() });
  if (r.error) throw new Error(`couldn't restart ${service.name}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`restarting ${service.name} exited with ${r.signal ? `signal: ${r.signal}` : `exit status: ${r.status}`}`);
}

/**
 * Starts `program args` outside the calling service, so the service's own restart doesn't end it: a transient systemd
 * user unit on Linux, a new session on macOS.
 */
export function spawnOutside(program: string, args: string[], what = "update"): void {
  if (process.platform === "linux") {
    const unit = `fleetd-${what}-${Date.now()}`;
    const r = spawnSync("systemd-run", ["--user", "--collect", "--quiet", "--unit", unit, program, ...args], { stdio: "ignore", env: userManagerEnv() });
    if (r.error) throw new Error(`couldn't run systemd-run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`systemd-run exited with exit status: ${r.status}`);
    return;
  }
  try {
    const child = Bun.spawn([program, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true } as never);
    child.unref();
  } catch (e) {
    throw new Error(`couldn't start ${program}: ${(e as Error).message}`);
  }
}

/**
 * Has the service manager restart `service` from outside it, so a service can ask for its own restart: this returns
 * once the restart is handed over, and the service is stopped and started a moment later.
 */
export function restartOutside(service: Service): void {
  const [cmd, args] = restartCommand(service);
  spawnOutside(cmd, args, "restart");
}

/** The unit this process runs as: the last part of its cgroup path under the user's manager (`user@1000.service`),
 * when that's a service (`fleetd-node.service`, not an agent's `run-….scope`). */
export function ownUnit(cgroup: string): string | undefined {
  const path = cgroup
    .split("\n")
    .find((l) => l.startsWith("0::"))
    ?.slice(3);
  if (path === undefined) return undefined;
  const parts = path.split("/");
  const manager = parts.findIndex((p) => p.startsWith("user@") && p.endsWith(".service"));
  if (manager < 0 || manager === parts.length - 1) return undefined;
  const last = parts.at(-1)!;
  return last.endsWith(".service") ? last : undefined;
}

/** Where the root drop-in goes that has systemd start `uid`'s service manager again whenever it stops. user@.service
 * has no Restart= of its own, so a lingering user's manager that exits (a SIGTERM to it) stays down, and the hub and
 * node with it, until that user logs in. A logout still ends a manager that doesn't linger: logind stops it, and
 * systemd never restarts a unit that was stopped. */
export const managerDropIn = (uid: number) => `/etc/systemd/system/user@${uid}.service.d/fleetd.conf`;

/** The drop-in's first line when linger was off before fleetd turned it on: `fleetd uninstall` then turns it off again,
 * and otherwise leaves it, as something else may need it. */
export const LINGER_MARK = "# fleetd turned linger on";

/** What root runs to keep `user`'s service manager running by itself: linger, so it starts at boot and outlives a
 * logout, and the drop-in, so it starts again 5 s after it stops. `lingerWasOff` marks the drop-in (LINGER_MARK). Run
 * again, it changes nothing; the manager that runs now carries on. */
export function keepManagerScript(user: string, uid: number, lingerWasOff = false): string {
  const file = managerDropIn(uid);
  const mark = lingerWasOff ? `${LINGER_MARK}\\n` : "";
  return `loginctl enable-linger ${user} && mkdir -p ${file.slice(0, file.lastIndexOf("/"))} && printf '${mark}[Service]\\nRestart=always\\nRestartSec=5\\n' > ${file} && systemctl daemon-reload`;
}

/** keepManagerScript as the one line an admin pastes. */
export const keepManagerCommand = (user: string, uid: number, lingerWasOff = false) =>
  `sudo sh -c "${keepManagerScript(user, uid, lingerWasOff)}"`;

/** What root runs to undo keepManagerScript: the drop-in goes, and linger too when the drop-in says fleetd turned it
 * on (`dropIn`, its text). */
export function undoManagerScript(user: string, uid: number, dropIn: string): string {
  const file = managerDropIn(uid);
  const linger = dropIn.split("\n").includes(LINGER_MARK) ? `loginctl disable-linger ${user}; ` : "";
  return `rm -f ${file}; rmdir ${file.slice(0, file.lastIndexOf("/"))} 2>/dev/null; ${linger}systemctl daemon-reload`;
}

/** Whether systemd brings this user's service manager back by itself, read from inside it: undefined off Linux, when
 * this process isn't a systemd user service, and when systemd can't be asked. */
export function readManager(): NodeManager | undefined {
  if (process.platform !== "linux") return undefined;
  let user: string;
  try {
    if (ownUnit(readFileSync("/proc/self/cgroup", "utf8")) === undefined) return undefined;
    user = userInfo().username;
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const r = spawnSync("systemctl", ["show", `user@${uid}.service`, "-p", "Restart", "--value"], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return undefined;
  // logind keeps linger as a file per user.
  return { user, uid, linger: existsSync(`/var/lib/systemd/linger/${user}`), restarts: r.stdout.trim() === "always" };
}
