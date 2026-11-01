// Add machine's words and decisions, apart from React: which way "This computer" goes, how each host and step reads,
// and which run the panel follows.
import type { GlyphState } from "../../ui";
import type { JoinHere, ThisComputer } from "../../../shared/joinHere";
import type { MachineAddRun, MachineHost, SetupStep } from "../../../shared/contracts";
import { machineIdFromHost } from "../projects/source";

/**
 * "This computer": the machine of the hub the app is connected to (that hub adds it with its own fleetd, no
 * download), one that runs a different hub (nothing to add from here), one whose node is enrolled already (nothing
 * to add: its fleetd is that node's), or another one, which main joins with a one-time code. Decided by what this
 * computer's fingerprint (a hash of its OS's id for it) and what its fleetd dir holds, never by its name or folders:
 * the connected hub's own computer is the one whose fingerprint hub_info gives, whatever it is called now, wherever
 * that hub keeps its data.
 */
export type Here =
  | { readonly kind: "hub"; readonly machineId: string; readonly joined: boolean }
  | { readonly kind: "other-hub" }
  | { readonly kind: "node"; readonly machineId: string; readonly hub: string; readonly ours: boolean }
  | { readonly kind: "app"; readonly machineId: string; readonly joined: boolean };

export const hereOf = (
  hosts: ReadonlyArray<MachineHost>,
  hubFingerprint: string | undefined,
  hostName: string,
  here: ThisComputer,
  joinedIds: ReadonlySet<string>,
): Here | undefined => {
  const hub = hosts.find((h) => h.source === "hub");
  if (hub !== undefined && hubFingerprint !== undefined && here.fingerprint === hubFingerprint) {
    return { kind: "hub", machineId: hub.machineId, joined: hub.joined };
  }
  if (here.kind === "hub") return { kind: "other-hub" };
  if (here.kind === "node") return { kind: "node", machineId: here.machineId, hub: here.hub, ours: joinedIds.has(here.machineId) };
  const machineId = machineIdFromHost(hostName);
  return machineId === "" ? undefined : { kind: "app", machineId, joined: joinedIds.has(machineId) };
};

/** "This computer"'s line under its name. */
export const hereLine = (here: Here | undefined): string => {
  if (here === undefined) return "Looking at this computer…";
  if (here.kind === "other-hub") return "This computer runs a different hub, so it can't be one of this hub's machines.";
  if (here.kind === "node") {
    return here.ours
      ? `This computer is already part of the hub as ${here.machineId}.`
      : `This computer is already part of ${here.hub === "" ? "another hub" : `another hub (${here.hub})`} as ${here.machineId}.`;
  }
  if (here.joined) return `${here.machineId} is a machine of this hub already: adding it again repairs it.`;
  return here.kind === "hub"
    ? `${here.machineId}, the hub's own machine: the hub sets up its node with its own fleetd.`
    : `${here.machineId}: downloads the hub's fleetd for this computer, checks it and runs its node as a user service.`;
};

const SOURCE: Record<string, string> = {
  hub: "the hub's own machine",
  set_up: "set up from this hub",
  ssh_config: "~/.ssh/config",
  tailnet: "tailnet",
};

/** A host's second line: where the hub found it, and its address when that says more than its name. */
export const hostLine = (h: MachineHost): string => {
  const source = SOURCE[h.source] ?? h.source;
  return h.host !== undefined && h.host !== h.machineId ? `${h.host} · ${source}` : source;
};

/** The hosts a person picks from: those that aren't machines yet first, each group as the hub listed it. */
export const pickable = (hosts: ReadonlyArray<MachineHost>): ReadonlyArray<MachineHost> => [
  ...hosts.filter((h) => !h.joined),
  ...hosts.filter((h) => h.joined),
];

export const glyphOf = (state: SetupStep["state"]): GlyphState =>
  state === "running" ? "working" : state === "done" ? "done" : state === "failed" ? "failed" : "queued";

/** A step's title with its first letter up: the hub's titles are lower-case, as the CLI prints them. */
export const stepTitle = (title: string): string => title.charAt(0).toUpperCase() + title.slice(1);

/** The hub's line as a sentence: a capital first, and a full stop where it ends in a colon or nothing. */
export const sentence = (text: string): string => {
  const t = stepTitle(text.trim()).replace(/:$/u, "");
  return /[.!?]$/u.test(t) ? t : `${t}.`;
};

/** A run's title: its machine, with its host when that says more. */
export const runTitle = (run: { readonly machineId: string; readonly host?: string | undefined }): string =>
  run.host === undefined ? `${run.machineId}, the hub's own machine` : run.host === run.machineId ? run.machineId : `${run.machineId} · ${run.host}`;

/** What a done step printed, when it is one short line worth showing ("enrolled"); never a file's content. */
export const shortOutput = (step: { state: string; output?: string | undefined }): string | undefined => {
  const out = step.output?.trim();
  return step.state === "done" && out !== undefined && out !== "" && !out.includes("\n") && out.length < 120 ? out : undefined;
};

/** The run the panel shows on opening: one still going, or the newest if it failed (so its Retry is a click away). */
export const resumable = (runs: ReadonlyArray<MachineAddRun>): MachineAddRun | undefined =>
  runs.find((r) => r.state === "running") ?? (runs[0]?.state === "failed" ? runs[0] : undefined);

/** A run's one-line state, under its title. */
export const runLine = (run: { readonly state: string; readonly machineId: string }, online: boolean): string => {
  if (run.state === "failed") return `Couldn't add ${run.machineId}.`;
  if (run.state === "done") return online ? `${run.machineId} is online.` : `${run.machineId} is set up; waiting for it to come online.`;
  return `Adding ${run.machineId}. You can leave this page: it carries on, and comes back here.`;
};

/** A join of this computer as the steps the panel lists, with the hub's own wait at the end. */
export const joinSteps = (join: JoinHere, online: boolean): ReadonlyArray<SetupStep> => {
  const steps: SetupStep[] = join.steps.map((s) => ({ title: s.title, state: s.state, ...(s.output === undefined ? {} : { output: s.output }) }));
  const waitState: SetupStep["state"] = join.state !== "done" ? "planned" : online ? "done" : "running";
  return [...steps, { title: `wait until ${join.machineId} is online`, state: waitState }];
};

/**
 * Why the hub couldn't read a host over SSH, from what ssh said (the hub's message ends with its stderr), with what to
 * do on the hub's machine: `ssh-copy-id` where the host refused the hub's key, `ssh <host> true` to accept a host key
 * the hub doesn't know yet, and where the host didn't answer at all, what to check before the same `ssh <host> true`.
 * Undefined for any other failure: the hub's own words say it.
 */
export type SshProblem = { readonly kind: "key" | "host-key" | "unreachable"; readonly command: string; readonly note: string };

const UNREACHABLE = /could not resolve hostname|name or service not known|connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection closed by remote host|host is down/iu;

export const sshProblem = (host: string, message: string): SshProblem | undefined => {
  if (/permission denied|too many authentication failures/iu.test(message)) {
    return { kind: "key", command: `ssh-copy-id ${host}`, note: `It asks for ${host}'s password once, then the hub logs in with its key. Then Try again.` };
  }
  if (/host key verification failed|remote host identification has changed/iu.test(message)) {
    return { kind: "host-key", command: `ssh ${host} true`, note: `It shows ${host}'s host key: check it, answer yes, then Try again.` };
  }
  if (UNREACHABLE.test(message)) {
    return {
      kind: "unreachable",
      command: `ssh ${host} true`,
      note: `${host} didn't answer: check it is on and awake, on the hub's network or tailnet, and has SSH on (a Mac: System Settings › General › Sharing › Remote Login). This tries it again from the hub; then Try again.`,
    };
  }
  return undefined;
};

/** Why a name can't be a machine id, or undefined when it can. */
export const machineIdProblem = (name: string): string | undefined => {
  if (name.trim() === "") return "Give it a name: how the hub and its agents will call it.";
  return /^[a-z0-9-]{1,32}$/u.test(name.trim()) ? undefined : "Lower-case letters, digits and dashes, up to 32.";
};

/** "Works once, until 14:32." in the person's own clock. */
export const untilLine = (expiresAt: string): string =>
  `The code works once, until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;

/**
 * Where the paste line stands. Joined once its node is online: at once for a machine that was offline when the line
 * was made, and for a repair of one still online, once the line has restarted its node (`restarted`).
 * Expired once its code has, else waiting; `online` is a repair's wait while its machine is still up on its old
 * enrollment.
 */
export type LineState = "waiting" | "joined" | "expired" | "online";

export const lineState = (
  line: { readonly expiresAt: string; readonly onlineAtStart: boolean },
  online: boolean,
  now: number,
  /** Its node has linked to the hub again, or been offline, since the line was made. */
  restarted: boolean,
): LineState => {
  if (online && (!line.onlineAtStart || restarted)) return "joined";
  if (now >= Date.parse(line.expiresAt)) return "expired";
  return online ? "online" : "waiting";
};

export const lineWords = (state: LineState, machineId: string): string =>
  state === "joined"
    ? `${machineId} joined.`
    : state === "online"
      ? `${machineId} is online on its old enrollment. Run the line on it: it joins again once its node restarts.`
      : state === "expired"
        ? "The code expired before the line ran. Make a new one."
        : `Waiting for ${machineId}…`;
