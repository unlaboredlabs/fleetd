// Where a screen session runs, without the hub (places.ts reads the machines and keeps the places): a machine's roles
// and session cap, which machine takes a session or why none can, its row in Hub › Machines, and a place's key.
import type { HostCheck, MachineRole, MachineRolesEntry, SessionHost } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import { HOST_NOUN } from "../../shared/screens_wire.ts";

/** Memory to allow per session when sizing a machine's session cap: a browser or an emulator. */
export const MEM_PER_SESSION = 2 * 2 ** 30;
/** The most sessions a machine is sized to on its own. */
export const AUTO_MAX = 16;
/** A machine's session cap until its node reports its figures. */
export const UNMEASURED = 2;
/** A machine's agent slots before it was measured (hub/slots/sizing.rs `UNMEASURED`). */
export const AGENTS_UNMEASURED = 4;
/** A start the hub placed counts against its machine's slots this long, until the session reports itself. */
export const START_MS = 120_000;
/** A person's screen with no input from them this long ends, as an agent's does without its commands. */
export const IDLE_MS = 30 * 60_000;
/** How long a task's screen outlasts the end of its last turn. */
export const TURN_WAIT_MS = IDLE_MS;
/** How long a hosted session's place outlives its end: its runner may still be uploading its recording. */
export const KEEP_HOSTED_MS = 7 * 86_400_000;

export type Roles = { agents: boolean; sessions: boolean; maxSessions: number | undefined };

export const rolesList = (r: Roles): MachineRole[] => [
  ...(r.agents ? (["agents"] as const) : []),
  ...(r.sessions ? (["sessions"] as const) : []),
];

/**
 * What a machine fits in sessions at once, and why: one per two CPUs and about 2 GB of memory each, and never fewer
 * than its agents can open, one each (`agents`: its agent slots and leads).
 */
export function autoSessions(load: NodeLoad | undefined, agents: number): [number, string] {
  let fits: number;
  let why: string;
  if (!load) {
    [fits, why] = [UNMEASURED, "auto: not measured yet"];
  } else {
    const cpus = load.cpus;
    const byCpu = Math.max(Math.floor(cpus / 2), 1);
    const byMem = load.memTotalBytes === undefined ? undefined : Math.max(Math.floor(load.memTotalBytes / MEM_PER_SESSION), 1);
    fits = Math.min(byMem === undefined ? byCpu : Math.min(byMem, byCpu), AUTO_MAX);
    why =
      load.memTotalBytes === undefined
        ? `auto: ${cpus} CPUs`
        : `auto: ${cpus} CPUs, ${Math.floor(load.memTotalBytes / 2 ** 30)} GB`;
  }
  if (agents > fits) return [agents, `auto: one for each agent and lead it runs (${agents})`];
  return [fits, why];
}

/** A machine as placement sees it. */
export type Runner = {
  machineId: string;
  name: string;
  online: boolean;
  sessions: boolean;
  /** What its node reported; undefined: nothing yet. */
  hosts: HostCheck[] | undefined;
  /** Its node hosts sessions for agents on other machines. */
  hostsOthers: boolean;
  othersNote: string | undefined;
  live: number;
  max: number;
  /** People waiting for a slot here: the next ones free are theirs, before any agent's. */
  held: number;
};

export const ready = (r: Runner, host: SessionHost) => r.hosts?.some((h) => h.host === host && h.ready);

/** It could host this kind for `origin`'s agents, slots aside. */
export function able(r: Runner, host: SessionHost, origin: string): boolean {
  if (!r.sessions) return false;
  // A node that reports nothing hosts a browser as it always did.
  if (r.machineId === origin) return ready(r, host) ?? host === "browser";
  return r.hostsOthers && ready(r, host) === true;
}

/** Slots an agent's start may take: those no person waits for. */
export const free = (r: Runner) => r.max - r.live - r.held;
/** Slots a person's own screen may take. */
export const open = (r: Runner) => r.max - r.live;

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const byName = (a: Runner, b: Runner) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

export function maxBy<T>(items: T[], cmp: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of items) if (best === undefined || cmp(item, best) >= 0) best = item;
  return best;
}

/**
 * Where a session of `host` for an agent on `origin` runs: its own machine when it can, else (with `remote`) the
 * online machine that can with the most free slots (then by name), else a refusal that says why in plain words.
 */
export function place(origin: string, host: SessionHost, runners: Runner[], remote: boolean): string {
  const noun = HOST_NOUN[host] ?? host;
  const own = runners.find((r) => r.machineId === origin);
  if (own && able(own, host, origin) && free(own) > 0) return own.machineId;
  if (!remote) throw hereOnly(origin, host, own);
  const ables = runners.filter((r) => r.machineId !== origin && able(r, host, origin));
  const online = ables.filter((r) => r.online);
  const best = maxBy(
    online.filter((r) => free(r) > 0),
    (a, b) => free(a) - free(b) || byName(a, b),
  );
  if (best) return best.machineId;
  const ownFull = own && able(own, host, origin) ? [own] : [];
  const full = [...ownFull, ...online];
  if (full.length > 0) {
    const each = full.map((r) =>
      r.held === 0
        ? `${r.name} ${r.live} of ${r.max}`
        : `${r.name} ${r.live} of ${r.max}, ${r.held} ${plural(r.held, "person", "people")} waiting for a slot`,
    );
    throw new ToolError(
      "failed",
      `Every machine that can host ${noun} session is full: ${each.join(", ")}.`,
      "end a session you no longer need, or try again later; a hub admin can raise a machine's session cap in Settings › Hub › Machines",
    );
  }
  if (ables.length > 0) {
    const names = ables.map((r) => r.name);
    throw new ToolError(
      "failed",
      `No machine online can host ${noun} session: ${names.join(", ")} can, but ${plural(names.length, "is", "are")} offline.`,
      "do without it and say so in your result, or try again once the machine is back",
    );
  }
  throw new ToolError(
    "failed",
    `No machine can host ${noun} session: none has the sessions role and ${noun} ready.`,
    "do without it and say so in your result: a hub admin can turn sessions on for a machine that can host it in Settings › Hub › Machines (fleetd machine set <id> --roles agents,sessions)",
  );
}

/** Why the agent's own machine can't take the session, while sessions run only there. */
export function hereOnly(origin: string, host: SessionHost, own: Runner | undefined): ToolError {
  const noun = HOST_NOUN[host] ?? host;
  const name = own?.name ?? origin;
  const settings = `Settings › Hub › Machines (fleetd machine set ${origin} --roles agents,sessions)`;
  if (own && !own.sessions) {
    return new ToolError(
      "failed",
      `${name} hosts no sessions: its role is agents only, and a session runs on its agent's own machine.`,
      `do without it and say so in your result: a hub admin can turn sessions on for ${name} in ${settings}`,
    );
  }
  if (own && able(own, host, origin)) {
    const message =
      own.held === 0
        ? `${name}'s session slots are full: ${own.live} of ${own.max}.`
        : `${name}'s session slots are full: ${own.live} of ${own.max}, and ${own.held} ${plural(own.held, "person is", "people are")} waiting for the next.`;
    return new ToolError(
      "failed",
      message,
      `end a session you no longer need, or try again later; a hub admin can raise ${name}'s session cap in Settings › Hub › Machines`,
    );
  }
  const why = own?.hosts?.find((h) => h.host === host)?.detail ?? "it hasn't said what it can host";
  return new ToolError(
    "failed",
    `${name} can't host ${noun} session: ${why}.`,
    "do without it and say so in your result: a person can set it up on this machine",
  );
}

export type RunnerRow = { runner: Runner; roles: Roles; why: string };

export function entry({ runner, roles, why }: RunnerRow): MachineRolesEntry {
  return {
    machineId: runner.machineId,
    name: runner.name,
    online: runner.online,
    roles: rolesList(roles),
    maxSessions: Math.max(runner.max, 0),
    ...(roles.maxSessions === undefined ? {} : { maxSessionsSet: roles.maxSessions }),
    maxSessionsWhy: why,
    sessionsLive: Math.max(runner.live, 0),
    hosts: runner.hosts ?? [],
    hostsOthers: runner.hostsOthers,
    ...(runner.othersNote !== undefined && roles.sessions ? { hostsOthersNote: runner.othersNote } : {}),
  };
}

/** A session the hub placed: on its agent's machine (`hosted` false), or hosted elsewhere under `key`. */
export type Place = {
  key: string;
  runner: string;
  origin: { machineId: string; projectId: string };
  originThread: string;
  taskId: string | undefined;
  hosted: boolean;
  sessionId: string | undefined;
};

export const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** `H` and 32 hex digits. */
export const newKey = () => `H${hex(16)}`;
/** 64 hex digits: one side of a session's relay. */
export const newRelayToken = () => hex(32);

export const PLACE_COLUMNS = "place_id, runner_id, origin_machine, origin_thread, project_id, task_id, hosted, session_id";

export type PlaceRow = {
  place_id: string;
  runner_id: string;
  origin_machine: string;
  origin_thread: string;
  project_id: string;
  task_id: string | null;
  hosted: number;
  session_id: string | null;
};

export const placeOf = (r: PlaceRow): Place => ({
  key: r.place_id,
  runner: r.runner_id,
  origin: { machineId: r.origin_machine, projectId: r.project_id },
  originThread: r.origin_thread,
  taskId: r.task_id ?? undefined,
  hosted: r.hosted !== 0,
  sessionId: r.session_id ?? undefined,
});
