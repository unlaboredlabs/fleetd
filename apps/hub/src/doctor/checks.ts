// Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix. Only
// three fixes are automatic (restart T3 with the node's own command, re-mint the hub's T3 session, re-apply the
// fleetd instance config); every other fix is a command for a person to run.
import type { DoctorCheck, DoctorFix, DoctorStatus, Machine, MachineId, ProbeCounter, UsageBreaker } from "@fleetd/contracts";
import type { ProviderInstanceConfig, ServerSettings } from "@t3tools/contracts";
import { FLEETD_INSTANCE } from "../executor/ProviderList.ts";
import { T3_PIN, T3_VERSION } from "../t3.ts";
import type { HubConfig } from "./config.ts";

export type AutoAction = "restart_t3" | "remint_session" | "reapply_instance";

/** A check with the automatic fix behind its `auto` fix, if it has one. */
export interface Entry {
  readonly check: DoctorCheck;
  readonly action?: AutoAction;
}

/** The disk floor: below this a machine cannot hold more worktrees. */
export const MIN_FREE_BYTES = 5e9;
/** The service units `fleetd init` and `fleetd machine add` install. */
export const HUB_UNIT = "fleetd-hub.service";
export const NODE_UNIT = "fleetd-node.service";
/** Every tool the fleetd instance must deny: T3's own (they spawn and schedule outside fleetd's slots) and Claude's subagents. */
export const REQUIRED_DISALLOWED = ["mcp__t3-code__*", "Task", "Workflow"] as const;
const DISALLOWED_FLAGS = new Set(["--disallowedTools", "--disallowed-tools"]);

const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const manual = (label: string, command?: string): DoctorFix => ({ kind: "manual", label: clip(label, 200), ...(command === undefined ? {} : { command }) });

const hubEntry = (name: string, status: DoctorStatus, message: string, fix?: DoctorFix): Entry => ({
  check: { id: `hub/${name}`, scope: "hub", status, message: clip(message), ...(fix === undefined ? {} : { fix }) },
});

const machineEntry = (machineId: MachineId, name: string, status: DoctorStatus, message: string, fix?: DoctorFix, action?: AutoAction): Entry => ({
  check: { id: `${machineId}/${name}`, scope: "machine", machineId, status, message: clip(message), ...(fix === undefined ? {} : { fix }) },
  ...(action === undefined ? {} : { action }),
});

const setupAgain = (machineId: MachineId) => manual(`Run machine setup again from the hub; it is idempotent`, `fleetd machine add <ssh host of ${machineId}>`);

// Hub checks

export type Probe = { readonly ok: true } | { readonly ok: false; readonly why: string };

export const hubReachable = (url: string, probe: Probe): Entry =>
  probe.ok
    ? hubEntry("reachable", "ok", `The hub answers at ${url}.`)
    : hubEntry("reachable", "fail", `The hub does not answer at its own address ${url} (${probe.why}).`, manual("Restart the hub service", `systemctl --user restart ${HUB_UNIT}`));

export type GhOutcome = { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | { readonly spawnError: string };

export const ghAuth = (outcome: GhOutcome): Entry => {
  const login = manual("Log gh in on the hub machine", "gh auth login");
  if ("spawnError" in outcome) {
    return outcome.spawnError === "ENOENT"
      ? hubEntry("gh_auth", "fail", "The GitHub CLI (gh) is not installed on the hub; the merge train and PR checks need it.", manual("Install gh (https://cli.github.com), then log in", "gh auth login"))
      : hubEntry("gh_auth", "unknown", `Could not run gh on the hub: ${outcome.spawnError}`);
  }
  if (outcome.exitCode !== 0) return hubEntry("gh_auth", "fail", "gh is not logged in on the hub; the merge train and PR checks need it.", login);
  const account = /account (\S+)/u.exec(`${outcome.stdout}\n${outcome.stderr}`)?.[1];
  return hubEntry("gh_auth", "ok", account === undefined ? "gh is logged in on the hub." : `gh is logged in on the hub as ${account}.`);
};

/** `undefined`: this hub keeps no push subscriptions. */
export const pushConfigured = (devices: number | undefined, publicUrl: string | undefined): Entry => {
  if (devices === undefined) return hubEntry("push", "unknown", "This hub keeps no push subscriptions yet.");
  if (devices > 0) return hubEntry("push", "ok", `${devices} device${devices === 1 ? "" : "s"} get${devices === 1 ? "s" : ""} push.`);
  return hubEntry(
    "push",
    "warn",
    "No device gets push, so asks only reach you when an app is open.",
    manual("Pair your phone, open the link, then turn on push in the app", `fleetd hub device add --name phone --url ${publicUrl ?? "<hub https url>"}`),
  );
};

export const httpsReachable = (config: { readonly config: HubConfig; readonly problem?: string }, port: number, probe: Probe | undefined): Entry => {
  const serve = manual("Serve the hub over HTTPS (Tailscale Serve shown), then set publicUrl in hub.json", `tailscale serve --bg ${port}`);
  if (config.problem !== undefined) return hubEntry("https", "warn", config.problem, serve);
  const url = config.config.publicUrl;
  if (url === undefined) return hubEntry("https", "warn", "No public URL is configured, so phones cannot reach the hub over HTTPS.", serve);
  if (!url.startsWith("https://")) {
    return hubEntry("https", "warn", `The hub's public URL ${url} is not HTTPS; the phone app needs HTTPS for push and offline use.`, serve);
  }
  if (probe === undefined || probe.ok) return hubEntry("https", "ok", `The hub is reachable over HTTPS at ${url}.`);
  return hubEntry("https", "fail", `${url} does not answer (${probe.why}).`, manual("Check that HTTPS still points at the hub", "tailscale serve status"));
};

// Machine checks

export const machineOnline = (machine: Machine, connected: boolean): Entry => {
  const id = machine.machineId;
  switch (machine.status) {
    case "offline":
      return machineEntry(id, "online", "fail", `${id} is offline (last seen ${machine.lastSeenAt}).`, manual(`Start the fleetd node on ${id}`, `systemctl --user restart ${NODE_UNIT}`));
    case "degraded":
      return machineEntry(id, "online", "fail", `${id} is degraded: ${machine.degradedReason ?? "T3 is down"}.`, { kind: "auto", label: `Restart T3 on ${id} with its node's restart command` }, "restart_t3");
    case "online":
      return connected
        ? machineEntry(id, "online", "ok", `${id} is online.`)
        : machineEntry(
            id,
            "online",
            "fail",
            `${id}'s node is linked, but the hub has no T3 connection there (its session may be revoked or expired).`,
            { kind: "auto", label: `Re-mint the hub's T3 session on ${id}` },
            "remint_session",
          );
  }
};

export const t3Version = (machine: Machine): Entry => {
  const id = machine.machineId;
  const pin = `pin ${T3_PIN.slice(0, 10)}`;
  if (machine.t3 === null) return machineEntry(id, "t3_version", "unknown", `T3 on ${id} has not reported its version yet.`);
  if (machine.t3.version === T3_VERSION) return machineEntry(id, "t3_version", "ok", `T3 ${T3_VERSION} (${pin}).`);
  return machineEntry(id, "t3_version", "fail", `T3 ${machine.t3.version} runs on ${id}; fleetd needs ${T3_VERSION} (${pin}).`, setupAgain(id));
};

const tokens = (args: string) => args.split(/\s+/u).filter((t) => t.length > 0);

/** The tools a launch-args string denies, from every `--disallowedTools` (or `=`) flag, comma or space separated. */
export const disallowedTools = (launchArgs: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  let inFlag = false;
  for (const token of tokens(launchArgs)) {
    const [flag, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    if (DISALLOWED_FLAGS.has(flag!)) {
      inFlag = inline === undefined;
      if (inline !== undefined) out.push(...inline.split(","));
      continue;
    }
    if (token.startsWith("-")) inFlag = false;
    else if (inFlag) out.push(...token.split(","));
  }
  return out.filter((t) => t.length > 0);
};

/** The launch args with one `--disallowedTools` flag that denies everything required plus whatever it denied before. */
export const withRequiredArgs = (launchArgs: string): string => {
  const kept: Array<string> = [];
  let inFlag = false;
  for (const token of tokens(launchArgs)) {
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (DISALLOWED_FLAGS.has(flag)) {
      inFlag = !token.includes("=");
      continue;
    }
    if (token.startsWith("-")) inFlag = false;
    if (!inFlag) kept.push(token);
  }
  const denied = [...new Set([...REQUIRED_DISALLOWED, ...disallowedTools(launchArgs)])];
  return [...kept, "--disallowedTools", denied.join(",")].join(" ");
};

const configOf = (instance: ProviderInstanceConfig): Record<string, unknown> =>
  typeof instance.config === "object" && instance.config !== null ? (instance.config as Record<string, unknown>) : {};

/** The fleetd instance, when it is one fleetd can re-apply: a Claude instance with its own config dir. */
export const reapplicable = (settings: ServerSettings): ProviderInstanceConfig | undefined => {
  const instance = settings.providerInstances[FLEETD_INSTANCE as keyof ServerSettings["providerInstances"]];
  if (instance === undefined || instance.driver !== "claudeAgent") return undefined;
  const home = configOf(instance).homePath;
  return typeof home === "string" && home.trim().length > 0 && !/\/\.claude\/?$/u.test(home) ? instance : undefined;
};

/** `instance_args` and `auto_resume`, from the machine's T3 settings, or why they could not be read. */
export const instanceChecks = (machineId: MachineId, settings: ServerSettings | { readonly unreadable: string }): ReadonlyArray<Entry> => {
  if ("unreadable" in settings) {
    return ["instance_args", "auto_resume"].map((name) => machineEntry(machineId, name, "unknown", settings.unreadable));
  }
  const reapply = { kind: "auto", label: `Re-apply the fleetd instance config on ${machineId}` } as const;
  const instance = settings.providerInstances[FLEETD_INSTANCE as keyof ServerSettings["providerInstances"]];
  const config = instance === undefined ? {} : configOf(instance);
  const home = typeof config.homePath === "string" ? config.homePath.trim() : "";
  const args = typeof config.launchArgs === "string" ? config.launchArgs : "";
  const missing = REQUIRED_DISALLOWED.filter((tool) => !disallowedTools(args).includes(tool));
  const instanceArgs =
    instance === undefined
      ? machineEntry(machineId, "instance_args", "fail", `T3 on ${machineId} has no "${FLEETD_INSTANCE}" Claude instance.`, setupAgain(machineId))
      : instance.driver !== "claudeAgent"
        ? machineEntry(machineId, "instance_args", "fail", `The "${FLEETD_INSTANCE}" instance on ${machineId} runs ${instance.driver}, not Claude.`, setupAgain(machineId))
        : home.length === 0
          ? machineEntry(machineId, "instance_args", "fail", `The fleetd instance on ${machineId} has no config dir of its own (CLAUDE_CONFIG_DIR).`, setupAgain(machineId))
          : reapplicable(settings) === undefined
            ? machineEntry(machineId, "instance_args", "fail", `The fleetd instance on ${machineId} shares your own Claude config dir (${home}).`, setupAgain(machineId))
            : missing.length > 0
              ? machineEntry(
                  machineId,
                  "instance_args",
                  "fail",
                  `The fleetd instance on ${machineId} does not deny ${missing.join(", ")} (launch args: ${args.trim() === "" ? "none" : args.trim()}).`,
                  reapply,
                  "reapply_instance",
                )
              : machineEntry(machineId, "instance_args", "ok", `The fleetd instance denies ${REQUIRED_DISALLOWED.join(", ")} and uses its own config dir ${home}.`);
  const autoResume = settings.autoResumeLimitedThreads
    ? machineEntry(machineId, "auto_resume", "fail", `T3 on ${machineId} auto-resumes usage-limited threads, which bypasses fleetd's usage pacing.`, reapply, "reapply_instance")
    : machineEntry(machineId, "auto_resume", "ok", "T3 does not auto-resume usage-limited threads.");
  return [instanceArgs, autoResume];
};

export const probeCounter = (machineId: MachineId, probes: ProbeCounter): Entry => {
  if (!probes.observable) return machineEntry(machineId, "probes", "unknown", `Probe counter not observable: ${probes.reason ?? "no trace to read"}.`);
  const count = probes.count ?? 0;
  return count === 0
    ? machineEntry(machineId, "probes", "ok", "T3 made no direct usage API calls (probe counter 0).")
    : machineEntry(
        machineId,
        "probes",
        "fail",
        `T3 on ${machineId} made ${count} direct usage or reset-credit call${count === 1 ? "" : "s"} (seen in ${probes.source ?? "its trace"}).`,
        manual("Remove stored Claude credentials from the fleetd instance's config dir and any cliproxy usage source in T3's settings"),
      );
};

export const usageBreaker = (machineId: MachineId, breaker: UsageBreaker): Entry =>
  breaker.state === "closed"
    ? machineEntry(machineId, "usage_breaker", "ok", "The usage breaker is closed.")
    : machineEntry(
        machineId,
        "usage_breaker",
        "warn",
        breaker.message ?? `New turns on ${machineId} are paused by the usage breaker.`,
        manual(`Wait for the reset${breaker.until === undefined ? "" : ` (${breaker.until})`}, or call usage_resume for ${machineId} once the login has capacity`),
      );

export interface HostProbe {
  readonly gitEmail?: string;
  readonly diskPath: string;
  readonly diskFreeBytes: number;
}

const NOREPLY = /@users\.noreply\.github\.com$/iu;

export const commitIdentity = (machineId: MachineId, probe: HostProbe | { readonly unreadable: string }, config: HubConfig): Entry => {
  if ("unreadable" in probe) return machineEntry(machineId, "commit_identity", "unknown", probe.unreadable);
  const want = config.commitIdentity?.email;
  const set = manual(`Set the commit identity on ${machineId}`, `git config --global user.email '${want ?? "<id>+<user>@users.noreply.github.com"}'`);
  if (probe.gitEmail === undefined) return machineEntry(machineId, "commit_identity", "fail", `No git commit identity is set on ${machineId}.`, set);
  if (want !== undefined && probe.gitEmail.toLowerCase() !== want.toLowerCase()) {
    return machineEntry(machineId, "commit_identity", "warn", `Commits on ${machineId} use ${probe.gitEmail}; the hub's identity is ${want}.`, set);
  }
  return machineEntry(
    machineId,
    "commit_identity",
    "ok",
    `Commits on ${machineId} use ${probe.gitEmail}${NOREPLY.test(probe.gitEmail) ? " (a GitHub noreply address)" : ""}.`,
  );
};

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export const diskSpace = (machineId: MachineId, probe: HostProbe | { readonly unreadable: string }): Entry => {
  if ("unreadable" in probe) return machineEntry(machineId, "disk", "unknown", probe.unreadable);
  if (probe.diskFreeBytes < 0) return machineEntry(machineId, "disk", "unknown", `Could not read the free space under ${probe.diskPath} on ${machineId}.`);
  return probe.diskFreeBytes < MIN_FREE_BYTES
    ? machineEntry(
        machineId,
        "disk",
        "fail",
        `${gb(probe.diskFreeBytes)} free under ${probe.diskPath} on ${machineId}; fleetd needs at least ${gb(MIN_FREE_BYTES)}.`,
        manual(`Free disk space on ${machineId}`, `df -h ${probe.diskPath}`),
      )
    : machineEntry(machineId, "disk", "ok", `${gb(probe.diskFreeBytes)} free under ${probe.diskPath}.`);
};
