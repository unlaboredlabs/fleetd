import path from "node:path";

/** POSIX shell quoting: bare when safe, else single quotes. */
export const q = (value: string) => (/^[A-Za-z0-9_/.,:@%+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

export type Platform = "linux" | "darwin";
export type Role = "hub" | "t3" | "node";

export interface ServiceSpec {
  readonly role: Role;
  /** Appended to the unit name, so a second copy (a lab) can run beside the real one. */
  readonly suffix: string;
  readonly description: string;
  readonly program: ReadonlyArray<string>;
  /** Plain settings only: unit files are world-readable. */
  readonly env: Readonly<Record<string, string>>;
  /** A 0600 file of KEY=value lines (a provider login) read at each start, so no secret sits in the unit. */
  readonly envFile?: string;
  readonly workingDirectory: string;
  readonly logPath: string;
}

/** `--unit-suffix lab` names units `fleetd-<role>-lab`; undefined for anything but [a-z0-9-]. */
export const unitSuffix = (value: string | undefined) => {
  const bare = (value ?? "").replace(/^-+/u, "");
  if (bare.length === 0) return "";
  return /^[a-z0-9-]{1,32}$/u.test(bare) ? `-${bare}` : undefined;
};

export const systemdName = (role: Role, suffix: string) => `fleetd-${role}${suffix}.service`;
export const launchdLabel = (role: Role, suffix: string) => `sh.fleetd.${role}${suffix}`;

export const unitPath = (platform: Platform, dirs: { readonly home: string; readonly configHome: string }, role: Role, suffix: string) =>
  platform === "linux"
    ? path.posix.join(dirs.configHome, "systemd", "user", systemdName(role, suffix))
    : path.posix.join(dirs.home, "Library", "LaunchAgents", `${launchdLabel(role, suffix)}.plist`);

/** systemd expands `%` specifiers everywhere and `$VAR` in ExecStart, and splits unquoted values on spaces. */
const systemdValue = (value: string, exec = false) => {
  const escaped = exec ? value.replaceAll("%", "%%").replaceAll("$", "$$$$") : value.replaceAll("%", "%%");
  return /[\s"'\\;]/u.test(escaped) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
};

export const renderSystemdUnit = (spec: ServiceSpec) =>
  [
    "[Unit]",
    `Description=${spec.description}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdValue(spec.workingDirectory)}`,
    ...Object.entries(spec.env).map(([key, value]) => `Environment=${systemdValue(`${key}=${value}`)}`),
    // The leading "-" lets the service start before the file exists.
    ...(spec.envFile === undefined ? [] : [`EnvironmentFile=-${systemdValue(spec.envFile)}`]),
    `ExecStart=${spec.program.map((arg) => systemdValue(arg, true)).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${spec.logPath.replaceAll("%", "%%")}`,
    `StandardError=append:${spec.logPath.replaceAll("%", "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const renderLaunchdPlist = (spec: ServiceSpec) => {
  // launchd has no EnvironmentFile: a shell sources the 0600 file, then execs the program.
  const program =
    spec.envFile === undefined
      ? spec.program
      : ["/bin/sh", "-c", `[ -f ${q(spec.envFile)} ] && set -a && . ${q(spec.envFile)} && set +a; exec "$@"`, "sh", ...spec.program];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${launchdLabel(spec.role, spec.suffix)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...program.map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(spec.env).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(spec.workingDirectory)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(spec.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
};

export const renderUnit = (platform: Platform, spec: ServiceSpec) =>
  platform === "linux" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec);

/** Shell commands that drive one service through the user's service manager. */
export interface ServiceManager {
  /** Enables the service and starts it if it is not running; leaves a running one alone. */
  readonly ensureRunning: (role: Role) => string;
  /** Enables and (re)starts it, reloading a changed unit file first. */
  readonly restart: (role: Role, unitChanged: boolean) => string;
  /** Stops and disables it; succeeds when it was never installed. */
  readonly remove: (role: Role) => string;
  /** argv (no shell) the node runs to restart T3 when it stops answering. */
  readonly restartArgv: (role: Role) => ReadonlyArray<string>;
}

export const serviceManager = (platform: Platform, uid: number, suffix: string, unitFile: (role: Role) => string): ServiceManager => {
  if (platform === "linux") {
    // A non-PAM SSH session has no XDG_RUNTIME_DIR, without which `systemctl --user` cannot find the user manager.
    const ctl = `XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user`;
    const name = (role: Role) => systemdName(role, suffix);
    return {
      ensureRunning: (role) => `${ctl} enable ${name(role)} && ${ctl} start ${name(role)}`,
      restart: (role, unitChanged) => `${unitChanged ? `${ctl} daemon-reload && ` : ""}${ctl} enable ${name(role)} && ${ctl} restart ${name(role)}`,
      remove: (role) => `${ctl} disable --now ${name(role)} 2>/dev/null || true`,
      restartArgv: (role) => ["/usr/bin/env", `XDG_RUNTIME_DIR=/run/user/${uid}`, "systemctl", "--user", "restart", name(role)],
    };
  }
  const target = (role: Role) => `gui/${uid}/${launchdLabel(role, suffix)}`;
  const bootstrap = (role: Role) => `launchctl bootstrap gui/${uid} ${q(unitFile(role))}`;
  // Without --wait, bootout returns while the job drains and a bootstrap right after fails.
  const bootout = (role: Role) => `launchctl bootout --wait ${target(role)} 2>/dev/null || true`;
  return {
    ensureRunning: (role) => `launchctl print ${target(role)} >/dev/null 2>&1 || ${bootstrap(role)}`,
    // A loaded job keeps its old plist until it is booted out and bootstrapped again.
    restart: (role, unitChanged) =>
      unitChanged ? `${bootout(role)}; ${bootstrap(role)}` : `launchctl kickstart -k ${target(role)} 2>/dev/null || ${bootstrap(role)}`,
    remove: bootout,
    restartArgv: (role) => ["launchctl", "kickstart", "-k", target(role)],
  };
};
