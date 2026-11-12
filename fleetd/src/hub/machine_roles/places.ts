// Machine roles (W46) and where each session runs: table `machine_roles`
// (agents, sessions or both, and a session cap; no row means both, auto) and `session_places`, one row per session
// the hub placed. A session the agent's machine can't take goes to the online machine with the most free slots.
import type { Database } from "bun:sqlite";
import type { HostCheck } from "../../shared/contracts.ts";
import { CAP_SESSION_HOST, CAP_SESSION_SEAL } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import type { HostedCaller } from "../lead_calls/types.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { heldOn } from "./screens.ts";
import {
  AGENTS_UNMEASURED,
  autoSessions,
  KEEP_HOSTED_MS,
  type Place,
  PLACE_COLUMNS,
  placeOf,
  type PlaceRow,
  type Roles,
  type Runner,
  type RunnerRow,
  START_MS,
  TURN_WAIT_MS,
} from "./placement.ts";

export {
  able,
  autoSessions,
  entry,
  free,
  IDLE_MS,
  newKey,
  newRelayToken,
  open,
  place,
  type Place,
  PLACE_COLUMNS,
  placeOf,
  ready,
  type Roles,
  rolesList,
  type Runner,
  type RunnerRow,
  START_MS,
  TURN_WAIT_MS,
} from "./placement.ts";

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
    };
    return { runner, roles, why };
  });
}

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
