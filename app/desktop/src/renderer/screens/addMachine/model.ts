// Add machine's words and decisions, apart from React: which way "This computer" goes, how each host and step reads,
// and which run the panel follows.
import type { GlyphState } from "../../ui";
import type { JoinHere } from "../../../shared/joinHere";
import type { MachineAddRun, MachineHost, SetupStep } from "../../../shared/contracts";
import { machineIdFromHost } from "../projects/source";

/**
 * "This computer", given the hosts the hub sees and this computer's name: the hub's own machine (the hub adds it
 * with its own fleetd, no download), or another one, which main joins with a one-time code.
 */
export type Here =
  | { readonly kind: "hub"; readonly machineId: string; readonly joined: boolean }
  | { readonly kind: "app"; readonly machineId: string; readonly joined: boolean };

export const hereOf = (hosts: ReadonlyArray<MachineHost>, hostName: string, joinedIds: ReadonlySet<string>): Here | undefined => {
  const machineId = machineIdFromHost(hostName);
  if (machineId === "") return undefined;
  const hub = hosts.find((h) => h.source === "hub");
  if (hub?.machineId === machineId) return { kind: "hub", machineId, joined: hub.joined };
  return { kind: "app", machineId, joined: joinedIds.has(machineId) };
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
