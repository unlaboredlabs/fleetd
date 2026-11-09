// Machine roles (W46) and where each session runs (crates/fleetd/src/hub/machine_roles/mod.rs): table `machine_roles`
// (agents, sessions or both, and a session cap; no row means both, auto) and `session_places`, one row per session
// the hub placed. A session the agent's machine can't take goes to the online machine with the most free slots; a
// cloud machine only when every other is full, while it is awake, never woken for one.
import type { Database } from "bun:sqlite";
import type { HostCheck, MachineRole, MachineRolesEntry, SessionHost } from "../../shared/contracts.ts";
import type { NodeLoad } from "../../shared/node_link.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_SESSION_HOST, CAP_SESSION_SEAL, HOST_NOUN } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import type { HostedCaller } from "../lead_calls/types.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { heldOn } from "./screens.ts";

/** Memory to allow per session when sizing a machine's session cap: a browser or an emulator. */
const MEM_PER_SESSION = 2 * 2 ** 30;
/** The most sessions a machine is sized to on its own. */
const AUTO_MAX = 16;
/** A machine's session cap until its node reports its figures. */
const UNMEASURED = 2;
/** A machine's agent slots before it was measured (hub/slots/sizing.rs `UNMEASURED`). */
const AGENTS_UNMEASURED = 4;
/** A start the hub placed counts against its machine's slots this long, until the session reports itself. */
export const START_MS = 120_000;
/** A person's screen with no input from them this long ends, as an agent's does without its commands. */
export const IDLE_MS = 30 * 60_000;
/** How long a task's screen outlasts the end of its last turn. */
export const TURN_WAIT_MS = IDLE_MS;
/** How long a hosted session's place outlives its end: its runner may still be uploading its recording. */
const KEEP_HOSTED_MS = 7 * 86_400_000;

export type Roles = { agents: boolean; sessions: boolean; maxSessions: number | undefined };

export const rolesList = (r: Roles): MachineRole[] => [
  ...(r.agents ? (["agents"] as const) : []),
  ...(r.sessions ? (["sessions"] as const) : []),
];

export function rolesOn(c: Database, m: string): Roles {
  const row = c
    .query<{ agents: number; sessions: number; max_sessions: number | null }, [string]>(
      "SELECT agents, sessions, max_sessions FROM machine_roles WHERE machine_id = ?",
    )
    .get(m);
  return row
    ? { agents: row.agents !== 0, sessions: row.sessions !== 0, maxSessions: row.max_sessions ?? undefined }
    : { agents: true, sessions: true, maxSessions: undefined };
}

/** This area's own service, `hub.area("machine_roles")`: whether a machine runs agents (the train's node_run reads it). */
export const machineRoles = (hub: Hub) =>
  hub.area("machine_roles", (h) => ({ agents: (machineId: string) => rolesOn(h.db.conn, machineId).agents }));

export function setRoles(c: Database, m: string, r: Roles): void {
  c.query(
    `INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (machine_id) DO UPDATE SET agents = excluded.agents, sessions = excluded.sessions,
       max_sessions = excluded.max_sessions`,
  ).run(m, r.agents ? 1 : 0, r.sessions ? 1 : 0, r.maxSessions ?? null);
}

function setting(c: Database, key: string): number | undefined {
  return c.query<{ value: number }, [string]>("SELECT value FROM machine_roles_settings WHERE key = ?").get(key)?.value;
}

function setSetting(c: Database, key: string, on: boolean): void {
  c.query(
    `INSERT INTO machine_roles_settings (key, value) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, on ? 1 : 0);
}

/** Whether the hub places sessions on other machines than their agents': on unless set off. */
export const remoteOn = (c: Database) => setting(c, "remote") !== 0;
export const setRemote = (c: Database, on: boolean) => setSetting(c, "remote", on);
/** "Agents may use this Mac": on unless an admin set it off. */
export const toolOn = (c: Database) => setting(c, "mac_tool") !== 0;
export const setToolOn = (c: Database, on: boolean) => setSetting(c, "mac_tool", on);

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

/**
 * Whether the task `column` names (`T<n>`, or NULL for a lead's) has ended as of `now`: cancelled, or done or failed
 * TURN_WAIT_MS ago and not continued since.
 */
export function taskEnded(column: string, now: number): string {
  return `EXISTS (SELECT 1 FROM tasks t WHERE t.n = CAST(substr(${column}, 2) AS INTEGER)
           AND (t.state = 'cancelled'
             OR (t.state IN ('done', 'failed') AND IFNULL(t.ended_at, '') <= '${isoMs(now - TURN_WAIT_MS)}')))`;
}

/**
 * The sessions live on `runner` now: its own agents' that run there, those it hosts for agents on other machines, and
 * the starts placed on it that have not reported yet. A session whose task ended counts for nothing.
 */
export function liveOn(c: Database, runner: string, now: number): number {
  const since = now - START_MS;
  const count = (sql: string, ...params: (string | number)[]) =>
    c.query<{ n: number }, (string | number)[]>(sql).get(...params)?.n ?? 0;
  const own = count(
    `SELECT COUNT(*) AS n FROM browser_sessions b WHERE b.machine_id = ?1 AND b.state = 'live'
       AND NOT ${taskEnded("json_extract(b.data, '$.taskId')", now)}
       AND NOT EXISTS (SELECT 1 FROM session_places p WHERE p.hosted = 1
         AND (p.session_id = b.session_id
           OR (p.session_id IS NULL AND p.ended_ms IS NULL AND p.origin_machine = b.machine_id
             AND p.origin_thread = json_extract(b.data, '$.threadId'))))`,
    runner,
  );
  const hosted = count(
    `SELECT COUNT(*) AS n FROM session_places p WHERE p.runner_id = ?1 AND p.hosted = 1 AND p.ended_ms IS NULL
       AND NOT ${taskEnded("p.task_id", now)}
       AND ((p.session_id IS NULL AND p.started_ms > ?2)
         OR (p.session_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')))`,
    runner,
    since,
  );
  const starting = count(
    `SELECT COUNT(*) AS n FROM session_places p WHERE p.runner_id = ?1 AND p.hosted = 0 AND p.started_ms > ?2
       AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.machine_id = p.origin_machine
         AND b.started_ms >= p.started_ms - 5000 AND json_extract(b.data, '$.threadId') = p.origin_thread)`,
    runner,
    since,
  );
  return own + hosted + starting;
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
  /** A cloud machine: true while it is awake for work. undefined on any other machine. */
  cloud: boolean | undefined;
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const byName = (a: Runner, b: Runner) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

function maxBy<T>(items: T[], cmp: (a: T, b: T) => number): T | undefined {
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
  // A cloud machine that isn't awake for work is as good as offline: a screen never wakes one.
  const online = ables.filter((r) => r.online && r.cloud !== false);
  const best = maxBy(
    online.filter((r) => free(r) > 0 && r.cloud === undefined),
    (a, b) => free(a) - free(b) || byName(a, b),
  );
  if (best) return best.machineId;
  // Every other machine is full: an awake cloud machine with room, the busiest first, so screens pack like agents.
  const cloud = maxBy(
    online.filter((r) => free(r) > 0 && r.cloud === true),
    (a, b) => a.live - b.live || byName(a, b),
  );
  if (cloud) return cloud.machineId;
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
function hereOnly(origin: string, host: SessionHost, own: Runner | undefined): ToolError {
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

/** A machine's agent slots (hub/slots `machine_cap`): none when it runs no agents, else its setting or its fit. */
function agentCap(c: Database, m: string, roles: Roles): number {
  if (!roles.agents) return 0;
  const row = c
    .query<{ auto: number; max_agents: number | null }, [string]>(
      "SELECT auto, max_agents FROM slot_machine_caps WHERE machine_id = ?",
    )
    .get(m);
  return row ? (row.max_agents ?? row.auto) : AGENTS_UNMEASURED;
}

/** Whether `m` is a cloud machine (hub/auth `is_pool`). */
export function isPool(c: Database, m: string): boolean {
  return (c.query<{ pool: number }, [string]>("SELECT pool FROM node_keys WHERE machine_id = ?").get(m)?.pool ?? 0) !== 0;
}

export type RunnerRow = { runner: Runner; roles: Roles; why: string };

/** Every machine as placement and Hub › Machines' roles see it. */
export function runners(hub: Hub): RunnerRow[] {
  const machines = store(hub).machinesList();
  const now = hub.clock.now();
  const nodes = link(hub);
  const c = hub.db.conn;
  return machines.map((m) => {
    const roles = rolesOn(c, m.machineId);
    const leads = store(hub).projectsShown(m.machineId).length;
    const agents = roles.agents ? agentCap(c, m.machineId, roles) + leads : 0;
    const load = nodes.load(m.machineId);
    const [auto, autoWhy] = autoSessions(load, agents);
    let othersNote: string | undefined;
    if (m.boxPubKey === undefined) {
      othersNote =
        "It gave the hub no key to seal a screen's secrets to: it hosts only its own agents' screens until its node links again.";
    } else if (!(nodes.can(m.machineId, CAP_SESSION_HOST) && nodes.can(m.machineId, CAP_SESSION_SEAL))) {
      othersNote =
        m.status === "offline"
          ? "Offline: it hosts other machines' agents' screens once it is back."
          : "Its fleetd is older: it hosts only its own agents' screens until it is updated.";
    }
    const [max, why] = roles.maxSessions !== undefined ? [roles.maxSessions, "set"] : [auto, autoWhy];
    // A cloud machine counts as awake for work while its node is linked (hub/pool's own wake state is the pool's).
    const cloud = isPool(c, m.machineId) ? nodes.linkId(m.machineId) !== undefined : undefined;
    // The node link keeps its own wire shape of a heartbeat's checks: the contracts' HostCheck, field for field.
    const hosts = load?.hosts as HostCheck[] | undefined;
    const runner: Runner = {
      machineId: m.machineId,
      name: m.name,
      online: m.status !== "offline",
      sessions: roles.sessions,
      // The agents' Mac offers only its own screen, whatever an older node of it still lists.
      hosts: hosts && m.agentsMac === true ? hosts.filter((h) => h.host === "mac") : hosts,
      hostsOthers: othersNote === undefined,
      othersNote,
      live: liveOn(c, m.machineId, now),
      max,
      held: heldOn(c, m.machineId, now),
      cloud,
    };
    return { runner, roles, why };
  });
}

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

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** `H` and 32 hex digits. */
export const newKey = () => `H${hex(16)}`;
/** 64 hex digits: one side of a session's relay. */
export const newRelayToken = () => hex(32);

export function insertPlace(c: Database, p: Place, now: number): void {
  c.query(
    `INSERT INTO session_places (place_id, runner_id, origin_machine, origin_thread, project_id, task_id, hosted,
       session_id, started_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.key,
    p.runner,
    p.origin.machineId,
    p.originThread,
    p.origin.projectId,
    p.taskId ?? null,
    p.hosted ? 1 : 0,
    p.sessionId ?? null,
    now,
  );
}

export const PLACE_COLUMNS = "place_id, runner_id, origin_machine, origin_thread, project_id, task_id, hosted, session_id";

type PlaceRow = {
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

function onePlace(c: Database, sql: string, ...params: (string | number)[]): Place | undefined {
  const row = c.query<PlaceRow, (string | number)[]>(sql).get(...params);
  return row ? placeOf(row) : undefined;
}

/** The open session an agent's session hosts on another machine, if any. */
export function openHosted(c: Database, origin: string, thread: string, now: number): Place | undefined {
  return onePlace(
    c,
    `SELECT ${PLACE_COLUMNS} FROM session_places p WHERE origin_machine = ?1 AND origin_thread = ?2
       AND hosted = 1 AND ended_ms IS NULL
       AND (session_id IS NOT NULL OR started_ms > ?3)
       AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')
     ORDER BY started_ms DESC LIMIT 1`,
    origin,
    thread,
    now - START_MS,
  );
}

/** A hosted session by its key. */
export const hosted = (c: Database, key: string) =>
  onePlace(c, `SELECT ${PLACE_COLUMNS} FROM session_places WHERE place_id = ?1 AND hosted = 1`, key);

/** The machine that hosts session `sessionId` for an agent on another one; undefined for one on its agent's machine. */
export function runnerOf(c: Database, sessionId: string): string | undefined {
  return (
    c
      .query<{ runner_id: string }, [string]>(
        "SELECT runner_id FROM session_places WHERE session_id = ?1 AND hosted = 1 ORDER BY started_ms DESC LIMIT 1",
      )
      .get(sessionId)?.runner_id ?? undefined
  );
}

/** A hosted start that answered: its session, and the SHA-256 of its relay token. */
export function setSession(c: Database, key: string, sessionId: string, relayHash: string): void {
  c.query("UPDATE session_places SET session_id = ?2, relay_hash = ?3 WHERE place_id = ?1").run(key, sessionId, relayHash);
}

/** The open hosted session whose relay token hashes to `relayHash`. */
export const placeByRelay = (c: Database, relayHash: string) =>
  onePlace(
    c,
    `SELECT ${PLACE_COLUMNS} FROM session_places p WHERE relay_hash = ?1 AND hosted = 1 AND ended_ms IS NULL
       AND session_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')`,
    relayHash,
  );

export function endPlace(c: Database, key: string, now: number): void {
  c.query("UPDATE session_places SET ended_ms = ?2 WHERE place_id = ?1 AND ended_ms IS NULL").run(key, now);
}

export function dropPlace(c: Database, key: string): void {
  c.query("DELETE FROM session_places WHERE place_id = ?").run(key);
}

/**
 * Drops places nobody needs: starts on the agent's own machine once they stopped counting, starts that never
 * answered, and hosted sessions a week after they ended or their recording landed. Returns how many.
 */
export function prune(c: Database, now: number): number {
  return c
    .query(
      `DELETE FROM session_places WHERE
         (hosted = 0 AND started_ms <= ?1)
         OR (hosted = 1 AND session_id IS NULL AND started_ms <= ?1)
         OR (hosted = 1 AND ended_ms IS NOT NULL AND ended_ms <= ?2)
         OR (hosted = 1 AND started_ms <= ?2 AND EXISTS (SELECT 1 FROM browser_sessions b
               WHERE b.session_id = session_places.session_id AND b.state IN ('recorded', 'lost', 'expired')))`,
    )
    .run(now - START_MS, now - KEEP_HOSTED_MS).changes;
}

/** The agent behind `thread` when it is a key the hub gave `runner` for a session it hosts (mod.rs `Callers`). */
export function callerOf(hub: Hub, runner: string, thread: string): HostedCaller | undefined {
  if (!thread.startsWith("H")) return undefined;
  const p = hosted(hub.db.conn, thread);
  if (!p || p.runner !== runner) return undefined;
  return {
    agent: p.taskId === undefined ? { kind: "lead" } : { kind: "task", taskId: p.taskId },
    projectRef: p.origin,
    threadId: p.originThread,
  };
}
