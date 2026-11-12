// browser_sessions, browser_recording_get, browser_control, browser_retention_set and screens_count:
// the app's Sessions view, its replay and its takeover.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { BrowserControl, BrowserControlTo, BrowserSession } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_BROWSER, RECORDING_FILES, RECORDING_PART_BYTES, type RecordingFileName } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, REPAIR_FIX, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { runnerOf } from "../machine_roles/places.ts";
import { waitsOf } from "../machine_roles/screens.ts";
import { live, runsOn } from "./live.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { get, list, liveSessions, filePath, retentionOn, setRetention } from "./store.ts";

/** How long browser_control waits for the node to say it acted. */
const CONTROL_WAIT = 5_000;

export function register(tools: Registry): void {
  tools.add("browser_sessions", browserSessions);
  tools.add("browser_recording_get", browserRecordingGet);
  tools.add("browser_control", browserControl);
  tools.add("browser_retention_set", browserRetentionSet);
  tools.add("screens_count", screensCount);
}

/** "human:<device>", as the action log names a person's step. */
export const person = (caller: Caller) => `human:${caller.name}`;

const notFound = (id: string) =>
  new ToolError("not_found", `No screen ${id}.`, "Call browser_sessions for the project's screens.");

export const unknownProject = (r: { machineId: string; projectId: string }) =>
  new ToolError(
    "not_found",
    `No project ${r.projectId} on ${r.machineId}.`,
    `Call project_get with machineId ${r.machineId} and no projectId.`,
    undefined,
    "It was removed, or its machine was: the projects list has the ones that are left.",
  );

export const unknownMachine = (m: string) =>
  new ToolError(
    "not_found",
    `No machine ${m}.`,
    "Call fleetd_status to list machines.",
    undefined,
    "This hub has no machine by that id: Settings › Hub › Machines lists the ones it has, or ask the hub admin.",
  );

/** Some grant on every machine gives at least `role` (api/grants.rs `allows_everywhere`). */
export const allowsEverywhere = (caller: Caller, role: "read" | "operate" | "admin") =>
  caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

export const adminEverywhereFix = (caller: Caller) =>
  isHuman(caller) ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).";

async function browserControl(hub: Hub, caller: Caller, input: { sessionId: string; control: BrowserControlTo }) {
  const id = input.sessionId;
  let session = get(hub, id);
  if (!session) throw notFound(id);
  const machine = session.projectRef.machineId;
  if (!allows(caller, "read", machine)) throw notFound(id);
  if (!isHuman(caller)) {
    throw new ToolError(
      "forbidden",
      "Only a person's device takes a browser over or hands it back.",
      "Use the fleetd app, on a computer or a phone.",
    );
  }
  requireRole(caller, "operate", machine);
  if (session.state !== "live") throw new ToolError("invalid", `Screen ${id} is ${session.state}, not live.`);
  if (session.openedBy !== undefined && input.control === "agent") {
    throw new ToolError(
      "invalid",
      `Screen ${id} is a person's own: it has no agent to hand it to.`,
      "End it with screen_end when you're done.",
    );
  }
  const next: BrowserControl =
    input.control === "human" ? "human" : session.control === "human" ? "handing_back" : session.control;
  if (next !== session.control) {
    await changeControl(hub, session, runsOn(hub, session), input.control, next, person(caller));
    session = get(hub, id);
    if (!session) throw notFound(id);
  }
  return {
    session,
    next:
      next === "human"
        ? "You have control: send browser_input; hand it back with control agent."
        : "The agent drives again from its next command; it sees the page as you left it.",
  };
}

/**
 * Sends a change of who drives `session` to `machine`, the one it runs on, and waits for its node to report it done:
 * `next`, the control it becomes. Nothing changes on the hub until the node reports.
 */
export async function changeControl(
  hub: Hub,
  session: BrowserSession,
  machine: string,
  control: BrowserControlTo,
  next: BrowserControl,
  by: string,
): Promise<void> {
  const id = session.sessionId;
  const nodes = link(hub);
  if (!nodes.can(machine, CAP_BROWSER)) {
    throw new ToolError(
      "machine_offline",
      `${machine}'s node isn't connected, or is too old for takeover.`,
      "Try again once the machine is online on the current fleetd.",
    );
  }
  // The node says who drives once it acted; the session changes only then.
  let stop: () => void = () => {};
  const confirmed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONTROL_WAIT);
    stop = live(hub).awaitControl(id, (reported) => {
      // The agent may have taken it back already.
      const done = next === "human" ? reported === "human" : reported !== "human";
      if (done) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  try {
    if (!nodes.send(machine, { t: "browser_control", sessionId: id, control, by })) {
      throw new ToolError("machine_offline", `${machine}'s node isn't connected.`);
    }
    if (!(await confirmed)) {
      throw new ToolError(
        "failed",
        `${machine}'s node didn't confirm the change: screen ${id} may have just ended there. Nothing changed.`,
        "Read the screen again with browser_sessions, and try again if it is still live.",
      );
    }
  } finally {
    stop();
  }
}

async function browserSessions(hub: Hub, caller: Caller, input: { projectRef: { machineId: string; projectId: string }; sessionId?: string; limit?: number }) {
  const r = input.projectRef;
  requireRole(caller, "read", r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolError("invalid", "limit: 1 to 100.");
  let sessions: BrowserSession[];
  if (input.sessionId !== undefined) {
    const s = get(hub, input.sessionId);
    sessions = s && s.projectRef.machineId === r.machineId && s.projectRef.projectId === r.projectId ? [s] : [];
  } else {
    sessions = list(hub, r, limit);
  }
  // Where each runs, and what a live one's agent did last there.
  for (const s of sessions) {
    s.machineId = runnerOf(hub.db.conn, s.sessionId) ?? s.projectRef.machineId;
    if (s.state === "live") {
      const step = live(hub).step(s.sessionId);
      if (step) s.step = step;
    }
  }
  return {
    sessions,
    waits: waitsOf(hub, caller, r),
    retention: retentionOn(hub.db.conn),
    ...(sessions.length === 0
      ? { next: "No screens yet: an agent opens one with session_start, a person with screen_open." }
      : {}),
  };
}

/** One read for the whole hub: every live screen, counted for the projects the caller reads, a Navi's for its owner. */
function screensCount(hub: Hub, caller: Caller) {
  const seen = new Map<string, boolean>();
  let count = 0;
  let asking = 0;
  for (const s of liveSessions(hub)) {
    const key = `${s.projectRef.machineId}\u0000${s.projectRef.projectId}`;
    let sees = seen.get(key);
    if (sees === undefined) {
      sees = allows(caller, "read", s.projectRef.machineId);
      seen.set(key, sees);
    }
    if (!sees) continue;
    count += 1;
    if (s.takeoverReason !== undefined && s.control === "agent") asking += 1;
  }
  return { live: count, asking };
}

function browserRecordingGet(hub: Hub, caller: Caller, input: { sessionId: string; file: string; offset?: number }) {
  const id = input.sessionId;
  const session = get(hub, id);
  // Knowing an id gives nothing on a machine the key can't read.
  if (!session || !allows(caller, "read", session.projectRef.machineId)) throw notFound(id);
  const file = input.file as RecordingFileName;
  if (!(file in RECORDING_FILES) || !(session.files ?? []).some((f) => f.file === file)) {
    throw new ToolError(
      "not_found",
      `Screen ${id} has no ${input.file} recording (${session.state}).`,
      "browser_sessions lists the files each screen has.",
    );
  }
  const offset = input.offset ?? 0;
  let data: Buffer;
  let bytes: number;
  try {
    const fd = openSync(filePath(hub, id, file), "r");
    try {
      bytes = fstatSync(fd).size;
      data = Buffer.alloc(offset < bytes ? Math.min(RECORDING_PART_BYTES, bytes - offset) : 0);
      if (data.length > 0) readSync(fd, data, 0, data.length, offset);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    console.warn(`browser recording of ${id} not read:`, e);
    throw new ToolError("failed", `The hub could not read ${id}'s recording.`);
  }
  const done = offset + data.length >= bytes;
  return {
    sessionId: id,
    file,
    mime: RECORDING_FILES[file].mime,
    offset,
    dataB64: data.toString("base64"),
    bytes,
    done,
    ...(done ? {} : { next: `Read the next piece from offset ${offset + data.length}.` }),
  };
}

function browserRetentionSet(hub: Hub, caller: Caller, input: { retentionDays: number; maxGbPerProject: number }) {
  // Retention prunes every project's recordings, so Admin on one machine is not enough.
  if (!allowsEverywhere(caller, "admin")) {
    throw new ToolError(
      "forbidden",
      "Browser recording retention is fleet-wide: it needs Admin on every machine.",
      adminEverywhereFix(caller),
    );
  }
  const { retentionDays, maxGbPerProject } = input;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new ToolError("invalid", "retentionDays: 1 to 365.");
  }
  if (!Number.isInteger(maxGbPerProject) || maxGbPerProject < 1 || maxGbPerProject > 10_000) {
    throw new ToolError("invalid", "maxGbPerProject: 1 to 10000.");
  }
  hub.db.transaction((c) => setRetention(c, { retentionDays, maxGbPerProject }));
  return { retention: { retentionDays, maxGbPerProject }, next: "Recordings past it go at the next hourly prune." };
}
