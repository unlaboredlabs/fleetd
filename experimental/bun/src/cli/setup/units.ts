// systemd user units and launchd agents for the hub and the node, and the shell commands that drive them
// (crates/fleetd/src/cli/setup/units.rs).
import { relocated } from "../../shared/home.ts";
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
