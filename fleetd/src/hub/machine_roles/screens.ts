// People's own screens (D239): `screen_open` and `screen_end`, and the
// line of people waiting for a full machine. A person's screen is a session the hub places itself, on the machine they
// picked, hosted there as an agent's screen on another machine is: the hub seals the start to the runner's box key
// (no secrets, a relay key nobody dials), the runner reports it in the project's name under a thread of its own, and
// the hub hands control to the person as soon as it is live. It ends with `screen_end`, or after IDLE_MS without the
// person's input. A full machine refuses, or takes the request in line (`screen_waits`): each slot that frees there
// goes to the oldest person waiting, and agents' starts see the slots people wait for as taken.
import type { Database } from "bun:sqlite";
import type {
  BrowserSession,
  PersonRef,
  ProjectRef,
  ScreenPr,
  ScreenStage,
  ScreenWait,
  SessionHost,
  SessionKind,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import {
  CAP_PROJECT_SIGNINS,
  HOST_NOUN,
  SCREEN_WAIT_MINUTES,
  type BrowserCallFrame,
} from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { isoMs } from "../auth/index.ts";
import { live } from "../browser/live.ts";
import { ensureOwnerOn, isNavi, personOn, projectRepos } from "../browser/reads.ts";
import { events } from "../store/events.ts";
import { link } from "../link/index.ts";
import { seal } from "../../shared/sealed_box.ts";
import { store } from "../store/hub_store.ts";
import { changeControl, unknownMachine, unknownProject } from "../browser/tools.ts";
import { get } from "../browser/store.ts";
import { sleep } from "../browser/thumbs.ts";
import { type Build, builds, type Found, openDone, PIECE, sealCall } from "./builds.ts";
import { CALL_WAIT, cancel, DEVICE_WAIT, hostSession, START_WAIT } from "./calls.ts";
import { isAgentsMac } from "./mac.ts";
import {
  endPlace,
  IDLE_MS,
  insertPlace,
  liveOn,
  newKey,
  open,
  PLACE_COLUMNS,
  type Place,
  placeOf,
  ready,
  type Runner,
  runners,
} from "./places.ts";

/** How long a person's wait for a slot lasts. */
const WAIT_MS = SCREEN_WAIT_MINUTES * 60_000;
/** How long a start's answer waits for the runner's report of the screen live, which races it over the link. */
const RECORD_WAIT = 5_000;
/** How long a PR's build may take to install, the screen's runner starting first included. */
const INSTALL_WAIT = 300_000;
/** Between tries while the screen's machine holds a command back. */
const INSTALL_RETRY = 1_000;

export function register(tools: Registry): void {
  tools.add("screen_open", screenOpen);
  tools.add("screen_end", screenEnd);
}

const HOSTS: Record<string, SessionHost> = {
  android: "android",
  ios: "ios",
  linux_desktop: "desktop",
  mac: "mac",
  browser: "browser",
};
const hostOf = (kind: SessionKind): SessionHost => HOSTS[kind] ?? "browser";

const WHAT: Record<string, string> = {
  browser: "Browser",
  android: "Android emulator",
  ios: "iOS simulator",
  linux_desktop: "Linux desktop",
  mac: "Agents' Mac",
};

/** What a person's screen is called in the list, in their name, with the PR whose build it has. */
function purpose(kind: SessionKind, person: PersonRef, pr: ScreenPr | undefined): string {
  const what = WHAT[kind] ?? "Browser";
  return pr ? `${what} opened by ${person.name}, with PR #${pr.number}` : `${what} opened by ${person.name}`;
}

/** The person `caller` is. A key with no person acts as the hub's owner, made on a hub that has no people yet. */
function personOf(hub: Hub, caller: Caller): PersonRef {
  if (caller.person) return caller.person;
  return hub.db.transaction((c) => ensureOwnerOn(c, caller.name, hub.clock.now()));
}

/** The person who opened the session reporting under `thread` themselves; undefined for an agent's session. */
export function opener(hub: Hub, machine: string, thread: string): PersonRef | undefined {
  const row = hub.db.all<{ person_id: string }>(
    `SELECT person_id FROM session_places WHERE origin_machine = ?1 AND origin_thread = ?2
       AND person_id IS NOT NULL LIMIT 1`,
    [machine, thread],
  )[0];
  if (!row) return undefined;
  return personOn(hub.db.conn, row.person_id) ?? { personId: row.person_id, name: "A person" };
}

/** People waiting for a slot on `runner` now: in line, not on their way (their slot is a place already). */
export function heldOn(c: Database, runner: string, now: number): number {
  return (
    c
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM screen_waits WHERE runner_id = ?1 AND since_ms > ?2 AND stage = 'waiting'",
      )
      .get(runner, now - WAIT_MS)?.n ?? 0
  );
}

type Wait = {
  id: string;
  person: string;
  device: string;
  project: ProjectRef;
  runner: string;
  kind: SessionKind;
  sinceMs: number;
  pr: ScreenPr | undefined;
  stage: ScreenStage;
  thread: string | undefined;
  error: string | undefined;
};

type WaitRow = {
  wait_id: string;
  person_id: string;
  device: string;
  machine_id: string;
  project_id: string;
  runner_id: string;
  kind: string;
  since_ms: number;
  pr_repo: string | null;
  pr_number: number | null;
  stage: string;
  thread_id: string | null;
  error: string | null;
};

const WAIT_COLUMNS =
  "wait_id, person_id, device, machine_id, project_id, runner_id, kind, since_ms, pr_repo, pr_number, stage, thread_id, error";

const waitOf = (r: WaitRow): Wait => ({
  id: r.wait_id,
  person: r.person_id,
  device: r.device,
  project: { machineId: r.machine_id, projectId: r.project_id },
  runner: r.runner_id,
  kind: r.kind as SessionKind,
  sinceMs: r.since_ms,
  pr: r.pr_repo !== null && r.pr_number !== null ? { repo: r.pr_repo, number: r.pr_number } : undefined,
  stage: r.stage as ScreenStage,
  thread: r.thread_id ?? undefined,
  error: r.error ?? undefined,
});

/** Every wait still in time, oldest first. */
const waitsOn = (c: Database, now: number): Wait[] =>
  c
    .query<WaitRow, [number]>(`SELECT ${WAIT_COLUMNS} FROM screen_waits WHERE since_ms > ?1 ORDER BY since_ms, wait_id`)
    .all(now - WAIT_MS)
    .map(waitOf);

const clip = (text: string, max: number) => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`);

function asWait(w: Wait, all: Wait[]): ScreenWait {
  let ahead = 0;
  for (const o of all) {
    if (o.id === w.id) break;
    if (o.runner === w.runner && o.stage === "waiting") ahead += 1;
  }
  return {
    waitId: w.id,
    projectRef: w.project,
    kind: w.kind,
    machineId: w.runner,
    since: isoMs(w.sinceMs),
    ahead,
    ...(w.pr ? { pr: w.pr } : {}),
    stage: w.stage,
    ...(w.thread === undefined ? {} : { threadId: w.thread }),
    ...(w.error === undefined ? {} : { error: clip(w.error, 500) }),
  };
}

/** `screen.wait` for wait `id` of project `r`, now at `stage` (undefined: gone). */
function announce(hub: Hub, r: ProjectRef, id: string, stage: ScreenStage | undefined): void {
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "screen.wait",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `a person's screen: ${stage ?? "gone"}`,
    data: { projectRef: r, waitId: id, ...(stage === undefined ? {} : { stage }) },
  });
}

/** Moves wait `id` to `stage`, with why when it failed. */
function setStage(hub: Hub, r: ProjectRef, id: string, stage: ScreenStage, error?: string): void {
  const changed = hub.db.transaction(
    (c) => c.query("UPDATE screen_waits SET stage = ?2, error = ?3 WHERE wait_id = ?1").run(id, stage, error ?? null).changes,
  );
  if (changed > 0) announce(hub, r, id, stage);
}

/** Wait `id` is over: its screen is the person's. */
function done(hub: Hub, r: ProjectRef, id: string): void {
  const gone = hub.db.transaction((c) => c.query("DELETE FROM screen_waits WHERE wait_id = ?").run(id).changes);
  if (gone > 0) announce(hub, r, id, undefined);
}

/** The caller's own waits for a screen of project `r`, oldest first. */
export function waitsOf(hub: Hub, caller: Caller, r: ProjectRef): ScreenWait[] {
  if (!isHuman(caller)) return [];
  const me = personOf(hub, caller);
  const all = waitsOn(hub.db.conn, hub.clock.now());
  return all
    .filter((w) => w.person === me.personId && w.project.machineId === r.machineId && w.project.projectId === r.projectId)
    .map((w) => asWait(w, all));
}

/** Whether a person's screen of `kind` on `runner` runs on the profile project `r` keeps (D221, D310). */
function keptProfile(hub: Hub, r: ProjectRef, kind: SessionKind, runner: string): boolean {
  if (kind !== "browser" || runner !== r.machineId) return false;
  return isNavi(hub.db, r) || link(hub).can(runner, CAP_PROJECT_SIGNINS);
}

/** Why `runner` can't host a person's screen of `kind` at all, slots aside; undefined when it can. */
function unable(r: Runner, host: SessionHost): string | undefined {
  const name = r.name;
  if (!r.sessions) return `${name} hosts no screens: its role is agents only.`;
  if (!r.online) return `${name} is offline.`;
  if (r.othersNote !== undefined) return `${name} can't host it yet. ${r.othersNote}`;
  if (ready(r, host) === true) return undefined;
  const why = r.hosts?.find((h) => h.host === host)?.detail ?? "it hasn't said what it can host";
  return `${name} can't host ${HOST_NOUN[host] ?? host} screen: ${why}.`;
}

/** The person a screen is for, and their device: its action log names their steps by it. */
type Opener = { person: PersonRef; device: string };

/** A start the hub placed and holds a slot for, to send to its runner (`launch`). */
type Start = { place: Place; kind: SessionKind; frame: BrowserCallFrame; sealed: Sealed; navi: string | undefined; by: string };

/** A person's start as sealed to its runner, and the relay key in it, which seals the hub's install steps. */
type Sealed = { sealed: string; relayKey: Uint8Array };

/**
 * What the hub seals to the runner for a person's screen, as an agent's node seals its own: no secrets, and a relay
 * key. A Navi's browser names its Navi in the hub's frame, never here.
 */
function sealedFor(hub: Hub, runner: string): Sealed {
  const boxKey = store(hub).machineGet(runner)?.boxPubKey ?? "";
  const publicKey = Buffer.from(boxKey, "base64");
  if (publicKey.length !== 32) {
    throw new ToolError("failed", `${runner} has no key to seal a screen to: its key is not 32 bytes of base64.`);
  }
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const plain = JSON.stringify({ secrets: [], relayKey: Buffer.from(relayKey).toString("base64") });
  try {
    return { sealed: Buffer.from(seal(publicKey, new TextEncoder().encode(plain))).toString("base64"), relayKey };
  } catch (e) {
    throw new ToolError("failed", `${runner} has no key to seal a screen to: ${(e as Error).message}.`);
  }
}

/** Places a person's screen on `runner` and holds its slot: from here it counts there, as a start does. */
function prepare(
  c: Database,
  o: Opener,
  r: ProjectRef,
  kind: SessionKind,
  runner: string,
  sealed: Sealed,
  kept: boolean,
  pr: ScreenPr | undefined,
  now: number,
): Start {
  const key = newKey();
  const place: Place = {
    key,
    originThread: `screen-${key.slice(1)}`,
    runner,
    origin: r,
    taskId: undefined,
    hosted: true,
    sessionId: undefined,
  };
  insertPlace(c, place, now);
  c.query("UPDATE session_places SET person_id = ?2 WHERE place_id = ?1").run(key, o.person.personId);
  return {
    place,
    kind,
    frame: { id: "open", cwd: "/", call: { op: "session_start", purpose: purpose(kind, o.person, pr), kind } },
    sealed,
    navi: kept ? r.projectId : undefined,
    by: `human:${o.device}`,
  };
}

/** Keeps a person's screen on its way: in line (`waiting`), or past it (`starting`, on `thread`). Returns its id. */
function insertWait(
  c: Database,
  o: Opener,
  r: ProjectRef,
  kind: SessionKind,
  runner: string,
  pr: ScreenPr | undefined,
  stage: ScreenStage,
  thread: string | undefined,
  now: number,
): string {
  const id = `W${newKey().slice(1)}`;
  c.query(
    `INSERT INTO screen_waits (wait_id, person_id, device, machine_id, project_id, runner_id, kind, since_ms,
       pr_repo, pr_number, stage, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.person.personId, o.device, r.machineId, r.projectId, runner, kind, now, pr?.repo ?? null, pr?.number ?? null, stage, thread ?? null);
  return id;
}

async function screenOpen(
  hub: Hub,
  caller: Caller,
  input: { projectRef: ProjectRef; machineId: string; kind?: SessionKind; pr?: ScreenPr; wait?: boolean },
) {
  const r = input.projectRef;
  const kind: SessionKind = input.kind ?? "browser";
  if (!isHuman(caller)) {
    throw new ToolError(
      "forbidden",
      "Only a person's device opens a screen of its own; an agent opens one with session_start.",
      "Use the desktop app.",
    );
  }
  requireRole(caller, "operate", r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  // iOS screens are gone (D298): an app before them still offers one.
  if (kind === "ios") {
    throw new ToolError(
      "invalid",
      "iOS screens are gone: iOS simulators are the agents' Mac's now, where agents start their own with `mac sim`.",
      "Open the Agents' Mac screen to watch it, or an Android screen for a PR's build.",
    );
  }
  const runnerId = input.machineId;
  requireRole(caller, "read", runnerId);
  const host = hostOf(kind);
  const runner = runners(hub).find((m) => m.runner.machineId === runnerId)?.runner;
  if (!runner) throw unknownMachine(runnerId);
  if (host !== "mac" && isAgentsMac(hub, runnerId)) {
    throw new ToolError(
      "invalid",
      `${runner.name} is the agents' Mac: its only screen is its own.`,
      "Pick another machine for it: machine_roles lists what each can host.",
    );
  }
  const why = unable(runner, host);
  if (why) throw new ToolError("failed", why, "Pick a machine that can host it: machine_roles lists what each can.");
  // A PR's build is there before anything starts or waits.
  if (input.pr) {
    if (kind !== "android") {
      throw new ToolError("invalid", "A PR's build goes into an Android screen.", "Pick Android, or leave the PR out.");
    }
  }
  const found = input.pr ? await findBuild(hub, r, kind, input.pr) : undefined;
  const person = personOf(hub, caller);
  const o: Opener = { person, device: caller.name };
  const now = hub.clock.now();
  // A slot is free and nobody waits before this person: theirs now. Counted again as the place is kept.
  const sealed = runner.held === 0 && open(runner) > 0 ? sealedFor(hub, runnerId) : undefined;
  const kept = keptProfile(hub, r, kind, runnerId);
  const start =
    sealed === undefined
      ? undefined
      : hub.db.transaction((c) => {
          if (heldOn(c, runnerId, now) > 0 || liveOn(c, runnerId, now) >= runner.max) return undefined;
          const start = prepare(c, o, r, kind, runnerId, sealed, kept, input.pr, now);
          // With a PR it opens in the hub's own time, its row saying how far it is.
          const wait = input.pr ? insertWait(c, o, r, kind, runnerId, input.pr, "starting", start.place.originThread, now) : undefined;
          return { start, wait };
        });
  if (start?.wait !== undefined) {
    const all = waitsOn(hub.db.conn, now);
    const w = all.find((x) => x.id === start.wait);
    void opening(hub, start.wait, start.start, input.pr, found);
    return {
      ...(w ? { waiting: asWait(w, all) } : {}),
      next: "Its slot is yours. The hub reads the PR's build, starts the screen and installs it, then hands it to you: screen.wait events follow each step, and browser_sessions lists it under waits (its threadId names its session) until it is yours, or says why it failed.",
    };
  }
  if (start) {
    const session = await launch(hub, start.start);
    return {
      next: "You have control: send browser_input. End it with screen_end when you're done.",
      ...(session ? { session } : {}),
    };
  }
  const full = `${runner.name} is full: ${runner.live} of ${runner.max} screens${runner.held === 0 ? "" : `, ${runner.held} waiting`}.`;
  if (!input.wait) {
    throw new ToolError(
      "failed",
      full,
      "Call screen_open again with wait true to take its next free slot (ahead of agents), or pick another machine.",
    );
  }
  const id = hub.db.transaction((c) => insertWait(c, o, r, kind, runnerId, input.pr, "waiting", undefined, now));
  const all = waitsOn(hub.db.conn, now);
  const w = all.find((x) => x.id === id);
  return {
    ...(w ? { waiting: asWait(w, all) } : {}),
    next: `${full} Your screen opens in its next free slot, ahead of agents' screens; screen_end with waitId gives up.`,
  };
}

async function screenEnd(hub: Hub, caller: Caller, input: { sessionId?: string; waitId?: string }) {
  if (!isHuman(caller)) {
    throw new ToolError("forbidden", "Only a person's device ends a person's screen.", "Use the desktop app.");
  }
  const me = personOf(hub, caller);
  if (input.waitId !== undefined) {
    const wait = input.waitId;
    const found = waitsOn(hub.db.conn, hub.clock.now()).find((w) => w.id === wait && w.person === me.personId);
    if (!found) throw new ToolError("not_found", `You have no wait ${wait}: its screen may have opened already.`);
    // One on its way has its screen starting already: it opens, and screen_end ends it then.
    if (found.stage === "starting" || found.stage === "installing") {
      throw new ToolError(
        "invalid",
        `Your screen ${wait} is opening on ${found.runner} now.`,
        "End it with screen_end and its sessionId once it opens.",
      );
    }
    hub.db.transaction((c) => c.query("DELETE FROM screen_waits WHERE wait_id = ?").run(found.id));
    announce(hub, found.project, found.id, undefined);
    return { next: found.stage === "failed" ? "It is cleared." : "Your wait is given up." };
  }
  const id = input.sessionId;
  if (id === undefined) throw new ToolError("invalid", "screen_end needs a sessionId or a waitId.");
  const notFound = () =>
    new ToolError("not_found", `No screen ${id} of yours.`, "Call browser_sessions for the project's screens.");
  const session = get(hub, id);
  if (!session) throw notFound();
  try {
    requireRole(caller, "operate", session.projectRef.machineId);
  } catch {
    throw notFound();
  }
  if (session.openedBy?.personId !== me.personId) {
    throw new ToolError("forbidden", `Screen ${id} isn't one you opened: its agent ends it.`);
  }
  if (session.state !== "live") return { session, next: "It has ended already." };
  await end(hub, session);
  const after = get(hub, id);
  return { ...(after ? { session: after } : {}), next: "It closes on its machine; its recording goes to the hub." };
}

/**
 * Starts a placed screen on its runner, installs the PR's build in it when there is one, and hands its control to the
 * person. A start that fails frees its slot; a build that doesn't install ends the screen.
 */
async function launch(hub: Hub, start: Start, build?: [ScreenPr, Build], wait?: string): Promise<BrowserSession | undefined> {
  const p = start.place;
  let id: string | undefined;
  let why = "it answered something else";
  try {
    const answer = await hostSession(hub, p.runner, p.key, start.frame, start.sealed.sealed, start.navi, START_WAIT);
    if (answer.result?.op === "session_start") id = String(answer.result.sessionId);
    else if (answer.error) why = answer.error.message;
  } catch (e) {
    why = (e as Error).message;
  }
  if (id === undefined) {
    await cancel(hub, p);
    throw new ToolError("failed", `The screen didn't start on ${p.runner}: ${why}`, "Try again, or pick another machine.");
  }
  const sessionId = id;
  hub.db.transaction((c) => c.query("UPDATE session_places SET session_id = ?2 WHERE place_id = ?1").run(p.key, sessionId));
  // The build goes in while the screen is still fleetd's: a person's control holds agent-device back.
  if (build && wait !== undefined) setStage(hub, p.origin, wait, "installing");
  if (build) {
    try {
      await install(hub, start, build[1]);
    } catch (e) {
      const why = (e as Error).message;
      console.warn(`PR #${build[0].number}'s build didn't install in ${sessionId}: ${why}`);
      const session = get(hub, sessionId);
      if (session) await end(hub, session).catch(() => {});
      else await cancel(hub, p);
      throw new ToolError(
        "failed",
        `PR #${build[0].number}'s build didn't install, so the screen was closed: ${why}`,
        "Try again, or open the screen without a PR.",
      );
    }
  }
  // Theirs from the start, once the hub has it: the runner's report of it live may come after its answer.
  const session = await recorded(hub, sessionId);
  if (!session) console.warn(`a person's screen ${sessionId} started on ${p.runner} but wasn't reported live`);
  else {
    try {
      await changeControl(hub, session, p.runner, "human", "human", start.by);
    } catch (e) {
      console.warn(`a person's screen ${sessionId} started without their control:`, (e as ToolError).message);
    }
  }
  return get(hub, sessionId);
}

/** Screen `id` as the hub has it, once its runner's report of it live is in, waiting for that up to RECORD_WAIT. */
async function recorded(hub: Hub, id: string): Promise<BrowserSession | undefined> {
  const found = get(hub, id);
  if (found) return found;
  // Listening before the second read: a report that lands between the two still wakes it.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(get(hub, id));
    }, RECORD_WAIT);
    const stop = live(hub).awaitControl(id, () => {
      clearTimeout(timer);
      stop();
      resolve(get(hub, id));
    });
    const now = get(hub, id);
    if (now) {
      clearTimeout(timer);
      stop();
      resolve(now);
    }
  });
}

/** Ends a person's live screen on its runner, and frees its slot. */
async function end(hub: Hub, session: BrowserSession): Promise<void> {
  const id = session.sessionId;
  const row = hub.db.all<Parameters<typeof placeOf>[0]>(
    `SELECT ${PLACE_COLUMNS} FROM session_places WHERE session_id = ?1 AND hosted = 1 AND person_id IS NOT NULL
     ORDER BY started_ms DESC LIMIT 1`,
    [id],
  )[0];
  if (!row) throw new ToolError("not_found", `Screen ${id} wasn't opened by a person.`);
  const p = placeOf(row);
  let gone = false;
  let why = "";
  try {
    const answer = await hostSession(hub, p.runner, p.key, { id: "end", cwd: "/", call: { op: "session_end" } }, undefined, undefined, CALL_WAIT);
    gone = answer.result !== undefined || answer.error?.code === "not_found";
    why = answer.error?.message ?? "";
  } catch (e) {
    why = (e as Error).message;
  }
  if (!gone) {
    throw new ToolError(
      "failed",
      `${p.runner} didn't end screen ${id}: ${why}`,
      "Try again; it ends by itself after 30 minutes without your input.",
    );
  }
  hub.db.transaction((c) => endPlace(c, p.key, hub.clock.now()));
  live(hub).forgetInput(id);
}

/** Finds PR `pr`'s build for a `kind` screen of project `r`: a PR of one of the project's repos, with a CI build. */
async function findBuild(hub: Hub, r: ProjectRef, kind: SessionKind, pr: ScreenPr): Promise<Found> {
  if (kind !== "android") throw new ToolError("invalid", "A PR's build goes into an Android screen.", "Pick Android, or leave the PR out.");
  // TODO(bun): the repos whose PRs the project lands too (hub/prs `project_repos`), once that area has them.
  if (!projectRepos(hub.db, r).some((repo) => repo.toLowerCase() === pr.repo.toLowerCase())) {
    throw new ToolError("invalid", `${pr.repo} isn't a repository of this project.`, "Pick a PR from pr_list for this project.");
  }
  try {
    return await builds(hub).find(pr.repo, pr.number, kind);
  } catch (e) {
    throw new ToolError("failed", (e as Error).message, "Pick another PR, or open the screen without one.");
  }
}

/** The hub's own sealed device steps for a person's screen, counted up from 1 (session_route.rs `device_step`). */
class Steps {
  private count = 0;
  constructor(
    private readonly hub: Hub,
    private readonly place: Place,
    private readonly key: Uint8Array,
  ) {}

  async send(call: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
    const count = ++this.count;
    const frame: BrowserCallFrame = { id: `install-${count}`, cwd: "/", call: { op: "device", ...sealCall(this.key, count, call) } };
    const answer = await hostSession(this.hub, this.place.runner, this.place.key, frame, undefined, undefined, waitMs);
    if (answer.result?.op === "device") {
      const { op: _, ...sealed } = answer.result;
      const opened = openDone(this.key, count, sealed);
      if (!opened) throw new Error("its answer didn't open with the screen's key");
      return opened;
    }
    if (answer.error) throw new Error(answer.error.message);
    throw new Error("its machine answered something else");
  }

  /** An agent-device command on the screen's machine: its exit code and output. */
  async run(args: string[]): Promise<[number, string]> {
    const done = await this.send({ step: "run", args }, DEVICE_WAIT);
    if (done.step !== "run") throw new Error("its machine answered the command with another step's answer");
    return [Number(done.exitCode), `${String(done.stdout ?? "")}${String(done.stderr ?? "")}`];
  }
}

/**
 * Sends a PR's build to the screen's machine and installs it there with `agent-device install`. A command held back
 * (exit 75: the screen's runner still starting) is tried again until INSTALL_WAIT.
 */
async function install(hub: Hub, start: Start, build: Build): Promise<void> {
  const steps = new Steps(hub, start.place, start.sealed.relayKey);
  const until = Date.now() + INSTALL_WAIT;
  const held = (code: number) => code === 75 && Date.now() < until;
  for (;;) {
    for (let offset = 0; offset < build.bytes.length; offset += PIECE) {
      const piece = build.bytes.subarray(offset, offset + PIECE);
      await steps.send({ step: "put", name: build.name, offset, dataB64: Buffer.from(piece).toString("base64") }, CALL_WAIT);
    }
    const [code, out] = await steps.run(["install", `in/${build.name}`]);
    if (code === 0) return;
    if (!held(code)) throw new Error(out.trim() === "" ? `agent-device install exited with ${code}` : clip(out.trim(), 300));
    await Bun.sleep(INSTALL_RETRY);
  }
}

/**
 * A person's screen past its wait, in the hub's own time: the PR's build read (its slot held meanwhile), the screen
 * started, the build installed, and the screen handed to them. Its row goes once it is theirs, or says why it failed.
 */
async function opening(hub: Hub, wait: string, start: Start, pr: ScreenPr | undefined, found: Found | undefined): Promise<void> {
  const project = start.place.origin;
  try {
    let build: [ScreenPr, Build] | undefined;
    if (pr) {
      let f = found;
      try {
        f ??= await findBuild(hub, project, start.kind, pr);
        build = [pr, await builds(hub).fetch(pr.repo, pr.number, start.kind, f)];
      } catch (e) {
        await cancel(hub, start.place);
        throw e instanceof ToolError ? e : new ToolError("failed", (e as Error).message, "Try again, or open the screen without a PR.");
      }
    }
    await launch(hub, start, build, wait);
    done(hub, project, wait);
  } catch (e) {
    console.warn("a person's screen didn't open:", (e as Error).message);
    setStage(hub, project, wait, "failed", (e as Error).message);
  }
}

/** Gives each slot free on a machine to the oldest person waiting for it, and drops waits past their time. */
export function serveWaits(hub: Hub): number {
  const now = hub.clock.now();
  hub.db.transaction((c) => c.query("DELETE FROM screen_waits WHERE since_ms <= ?").run(now - WAIT_MS));
  const waits = waitsOn(hub.db.conn, now).filter((w) => w.stage === "waiting");
  if (waits.length === 0) return 0;
  const all = runners(hub);
  const taken = new Map<string, number>();
  let served = 0;
  for (const w of waits) {
    const runner = all.find((x) => x.runner.machineId === w.runner)?.runner;
    if (!runner) continue;
    const used = taken.get(w.runner) ?? 0;
    if (open(runner) - used <= 0) continue;
    const person = personOn(hub.db.conn, w.person);
    if (!person) {
      hub.db.transaction((c) => c.query("DELETE FROM screen_waits WHERE wait_id = ?").run(w.id));
      continue;
    }
    let sealed: Sealed;
    try {
      sealed = sealedFor(hub, w.runner);
    } catch (e) {
      setStage(hub, w.project, w.id, "failed", (e as ToolError).message);
      continue;
    }
    const kept = keptProfile(hub, w.project, w.kind, w.runner);
    // Taken only while it still waits (not given up meanwhile): its slot is a place from here.
    const start = hub.db.transaction((c) => {
      const still = c.query("SELECT 1 FROM screen_waits WHERE wait_id = ?1 AND stage = 'waiting'").get(w.id);
      if (!still) return undefined;
      const s = prepare(c, { person, device: w.device }, w.project, w.kind, w.runner, sealed, kept, w.pr, now);
      c.query("UPDATE screen_waits SET stage = 'starting', thread_id = ?2 WHERE wait_id = ?1").run(w.id, s.place.originThread);
      return s;
    });
    if (!start) continue;
    announce(hub, w.project, w.id, "starting");
    taken.set(w.runner, used + 1);
    served += 1;
    void opening(hub, w.id, start, w.pr, undefined);
  }
  return served;
}

/** People's live screens with no input from them for IDLE_MS (or since they started, or since the hub did). */
function idle(hub: Hub, sinceHub: number): BrowserSession[] {
  const now = hub.clock.now();
  const rows = hub.db.all<{ session_id: string; started_ms: number }>(
    `SELECT p.session_id, p.started_ms FROM session_places p JOIN browser_sessions b ON b.session_id = p.session_id
     WHERE p.person_id IS NOT NULL AND p.hosted = 1 AND p.ended_ms IS NULL AND b.state = 'live'`,
  );
  return rows.flatMap((r) => {
    const last = Math.max(live(hub).lastInput(r.session_id) ?? 0, r.started_ms, sinceHub);
    const s = now - last >= IDLE_MS ? get(hub, r.session_id) : undefined;
    return s ? [s] : [];
  });
}

/** Ends people's screens idle for IDLE_MS; returns how many it ended. */
export async function endIdle(hub: Hub, sinceHub: number): Promise<number> {
  let ended = 0;
  for (const s of idle(hub, sinceHub)) {
    try {
      await end(hub, s);
      ended += 1;
    } catch (e) {
      console.warn(`idle screen ${s.sessionId} not ended:`, (e as ToolError).message);
    }
  }
  return ended;
}

/**
 * Serves the waits whenever anything changes (a screen's end is an event) and each minute, and ends people's idle
 * screens each minute, until the hub stops.
 */
export async function run(hub: Hub): Promise<void> {
  const sinceHub = hub.clock.now();
  const signal = hub.shutdown.signal;
  let wake: (() => void) | undefined;
  const unsubscribe = events(hub).subscribe(() => wake?.());
  let checked = Number.NEGATIVE_INFINITY;
  try {
    while (!signal.aborted) {
      try {
        serveWaits(hub);
      } catch (e) {
        console.warn("people's waits for screens not served:", e);
      }
      const now = hub.clock.now();
      if (now - checked >= 60_000) {
        checked = now;
        await endIdle(hub, sinceHub);
      }
      await Promise.race([sleep(60_000, signal), new Promise<void>((resolve) => (wake = resolve))]);
      wake = undefined;
    }
  } finally {
    unsubscribe();
  }
}
