// systemd user units and launchd agents for the hub and the node, and the shell commands that drive them.
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relocated } from "../../shared/home.ts";
import { isHubService, services, unitDir, userManagerEnv } from "../../update/service.ts";
import { q } from "../pair.ts";
import type { Platform } from "./shared.ts";

export type Role = "hub" | "node";
export { q };

export type ServiceSpec = {
  role: Role;
  description: string;
  program: string[];
  env: [string, string][];
  envFile?: string;
  workingDirectory: string;
  logPath: string;
};

/** A second fleet on this machine (its own fleetd dir) never takes over a unit that runs another's. */
export const foreignUnit = (unitText: string | undefined, home: string) =>
  relocated() !== undefined && unitText !== undefined && !unitText.includes(home);

export const systemdName = (role: Role) => `fleetd-${role}.service`;
export const launchdLabel = (role: Role) => `sh.fleetd.${role}`;

export function unitPath(platform: Platform, dirs: { home: string; configHome: string }, role: Role): string {
  return platform === "linux"
    ? `${dirs.configHome.replace(/\/+$/, "")}/systemd/user/${systemdName(role)}`
    : `${dirs.home.replace(/\/+$/, "")}/Library/LaunchAgents/${launchdLabel(role)}.plist`;
}

function systemdValue(value: string, exec: boolean): string {
  const escaped = exec ? value.replaceAll("%", "%%").replaceAll("$", "$$$$") : value.replaceAll("%", "%%");
  return /[\s"'\;]/.test(escaped) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
}

/** Under memory pressure the kernel kills an agent's processes before the hub or the node. A user manager can't set a
 * score below its own, so systemd leaves the service at that, 100 under `user@.service`, rather than the 200 it gives
 * its services by default. systemd-oomd, where it runs, picks other cgroups first. */
const OOM_LINES = ["OOMScoreAdjust=-900", "ManagedOOMPreference=avoid"];

/** Every key renderSystemdUnit writes, or has written. A unit with any other was edited by hand, and is left alone. */
const UNIT_KEYS = new Set([
  "Description",
  "StartLimitIntervalSec",
  "StartLimitBurst",
  "Type",
  "WorkingDirectory",
  "Environment",
  "EnvironmentFile",
  "ExecStart",
  "KillMode",
  "OOMPolicy",
  "OOMScoreAdjust",
  "ManagedOOMPreference",
  "Restart",
  "RestartSec",
  "StandardOutput",
  "StandardError",
  "WantedBy",
  "",
]);

/** A unit fleetd wrote, from any version, rewritten from today's template with the same command, environment and
 * paths, so a service gets settings added since (its OOM lines, `OOMPolicy=continue`) without `fleetd machine add`.
 * Undefined when it reads as today's already, or isn't one fleetd wrote. */
export function refreshSystemdUnit(text: string, role: Role): string | undefined {
  const spec = parseSystemdUnit(text, role);
  if (spec === undefined) return undefined;
  const fresh = renderSystemdUnit(spec);
  return fresh === text ? undefined : fresh;
}

/** The spec renderSystemdUnit wrote `text` from. */
export function parseSystemdUnit(text: string, role: Role): ServiceSpec | undefined {
  const spec: ServiceSpec = { role, description: "", program: [], env: [], workingDirectory: "", logPath: "" };
  // As Rust's str::lines: a last empty line isn't one.
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    const [key, value] = eq < 0 ? [line, ""] : [line.slice(0, eq), line.slice(eq + 1)];
    if (!UNIT_KEYS.has(key)) return undefined;
    if (key === "Description") spec.description = value;
    else if (key === "WorkingDirectory") {
      const v = unquote(value);
      if (v === undefined) return undefined;
      spec.workingDirectory = v;
    } else if (key === "Environment") {
      const pair = unquote(value);
      const at = pair?.indexOf("=") ?? -1;
      if (pair === undefined || at < 0) return undefined;
      spec.env.push([pair.slice(0, at), pair.slice(at + 1)]);
    } else if (key === "EnvironmentFile") {
      const v = value.startsWith("-") ? unquote(value.slice(1)) : undefined;
      if (v === undefined) return undefined;
      spec.envFile = v;
    } else if (key === "ExecStart") {
      const w = words(value, true);
      if (w === undefined) return undefined;
      spec.program = w;
    } else if (key === "StandardOutput") {
      if (!value.startsWith("append:")) return undefined;
      spec.logPath = value.slice("append:".length).replaceAll("%%", "%");
    }
  }
  return spec.program.length > 0 && spec.logPath !== "" ? spec : undefined;
}

/** One value as systemdValue wrote it. */
function unquote(value: string): string | undefined {
  const w = words(value, false);
  return w?.length === 1 ? w[0] : undefined;
}

/** A line's words as systemdValue wrote them: bare, or in double quotes with `\\` and `\"` escaped, and `%` doubled,
 * and `$` too in an `ExecStart=` (`exec`). */
function words(line: string, exec: boolean): string[] | undefined {
  const out: string[] = [];
  const chars = [...line];
  let i = 0;
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (;;) {
    while (space(chars[i])) i++;
    const first = chars[i++];
    if (first === undefined) break;
    let word = "";
    if (first === '"') {
      for (;;) {
        const c = chars[i++];
        if (c === undefined) return undefined;
        if (c === '"') break;
        if (c === "\\") {
          const next = chars[i++];
          if (next === undefined) return undefined;
          word += next;
        } else word += c;
      }
    } else {
      word = first;
      while (chars[i] !== undefined && !space(chars[i])) word += chars[i++];
    }
    word = word.replaceAll("%%", "%");
    out.push(exec ? word.replaceAll("$$", "$") : word);
  }
  return out;
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

const info = (unit: string, message: string) => console.log(`${new Date().toISOString()} INFO ${message} {"unit":${JSON.stringify(unit)}}`);
const warn = (unit: string, message: string) => console.warn(`${new Date().toISOString()} WARN ${message} {"unit":${JSON.stringify(unit)}}`);

/** `systemctl --user args`: whether it ran and succeeded, or why not. */
function systemctl(args: string[]): string | undefined {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "ignore", env: userManagerEnv() });
  if (r.error) return `couldn't run systemctl: ${r.error.message}`;
  return r.status === 0 ? undefined : `systemctl --user ${args.join(" ")} exited with ${r.signal ? `signal: ${r.signal}` : `exit status: ${r.status}`}`;
}

/** At a hub's or node's start under its systemd user unit:
 * the unit rewritten from today's template when an older fleetd wrote it (an update swaps only the binary, so the
 * settings added since never reached it), and enabled when it isn't, so the service starts at the next boot. Run by
 * the new binary after an update's restart, so the update applies it; a rewritten unit takes effect at the next
 * restart. Off Linux, outside such a unit, or with a unit edited by hand, nothing changes. */
export function refreshOwnUnit(): void {
  if (process.platform !== "linux") return;
  let name: string | undefined;
  try {
    name = ownUnit(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {}
  if (name === undefined) return;
  const service = services(process.execPath).find((s) => s.name === name);
  if (service === undefined) return;
  const path = join(unitDir(), service.name);
  try {
    const fresh = refreshSystemdUnit(readFileSync(path, "utf8"), isHubService(service) ? "hub" : "node");
    if (fresh !== undefined) {
      const staged = `${path.replace(/\.service$/, "")}.service.new`;
      writeFileSync(staged, fresh);
      renameSync(staged, path);
      const why = systemctl(["daemon-reload"]);
      if (why === undefined) info(name, "rewrote the unit from today's template");
      else warn(name, `rewrote the unit from today's template, but ${why}`);
    }
  } catch (error) {
    warn(name, `couldn't rewrite the unit: ${(error as Error).message}`);
  }
  if (systemctl(["is-enabled", "--quiet", name]) === undefined) return;
  const why = systemctl(["enable", name]);
  if (why === undefined) info(name, "enabled the unit, which wasn't, so it starts at boot");
  else warn(name, `it may not start at the next boot: ${why}`);
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const lines = [
    "[Unit]",
    `Description=${spec.description}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdValue(spec.workingDirectory, false)}`,
    ...spec.env.map(([k, v]) => `Environment=${systemdValue(`${k}=${v}`, false)}`),
  ];
  if (spec.envFile !== undefined) lines.push(`EnvironmentFile=-${systemdValue(spec.envFile, false)}`);
  lines.push(`ExecStart=${spec.program.map((a) => systemdValue(a, true)).join(" ")}`);
  if (spec.role === "node") lines.push("KillMode=mixed", "OOMPolicy=continue");
  lines.push(...OOM_LINES);
  const log = spec.logPath.replaceAll("%", "%%");
  lines.push("Restart=always", "RestartSec=5", `StandardOutput=append:${log}`, `StandardError=append:${log}`, "", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

const xml = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const program =
    spec.envFile === undefined
      ? spec.program
      : ["/bin/sh", "-c", `[ -f ${q(spec.envFile)} ] && set -a && . ${q(spec.envFile)} && set +a; exec "$@"`, "sh", ...spec.program];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${launchdLabel(spec.role)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
  ];
  for (const [k, v] of spec.env) lines.push(`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`);
  lines.push(
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(spec.workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(spec.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(spec.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  );
  return lines.join("\n");
}

export const renderUnit = (platform: Platform, spec: ServiceSpec) =>
  platform === "linux" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec);

/** The shell commands that drive the services. */
export class ServiceManager {
  constructor(
    private readonly platform: Platform,
    private readonly uid: number,
    private readonly unitFile: (role: Role) => string,
  ) {}
  static linuxCtl = (uid: string) => `XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user`;
  private ctl = () => ServiceManager.linuxCtl(String(this.uid));
  private target = (role: Role) => `gui/${this.uid}/${launchdLabel(role)}`;
  private bootstrap = (role: Role) => `launchctl bootstrap gui/${this.uid} ${q(this.unitFile(role))}`;
  private bootout = (role: Role) => `launchctl bootout --wait ${this.target(role)} 2>/dev/null || true`;
  private resetFailed = (role: Role) => `${this.ctl()} reset-failed ${systemdName(role)} 2>/dev/null; `;

  ensureRunning(role: Role): string {
    if (this.platform === "linux") {
      const [ctl, name] = [this.ctl(), systemdName(role)];
      return `${this.resetFailed(role)}${ctl} enable ${name} && ${ctl} start ${name}`;
    }
    return `launchctl print ${this.target(role)} >/dev/null 2>&1 || ${this.bootstrap(role)}`;
  }

  restart(role: Role, unitChanged: boolean): string {
    if (this.platform === "linux") {
      const [ctl, name] = [this.ctl(), systemdName(role)];
      return `${this.resetFailed(role)}${unitChanged ? `${ctl} daemon-reload && ` : ""}${ctl} enable ${name} && ${ctl} restart ${name}`;
    }
    if (unitChanged) return `${this.bootout(role)}; ${this.bootstrap(role)}`;
    return `launchctl kickstart -k ${this.target(role)} 2>/dev/null || ${this.bootstrap(role)}`;
  }

  remove(role: Role): string {
    return this.platform === "linux" ? `${this.ctl()} disable --now ${systemdName(role)} 2>/dev/null || true` : this.bootout(role);
  }
}
