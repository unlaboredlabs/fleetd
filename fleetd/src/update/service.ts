// The hub and node services `fleetd init` created for a binary, and restarting one (crates/fleetd/src/update/
// service.rs): `systemctl --user restart`, `launchctl kickstart -k`.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
