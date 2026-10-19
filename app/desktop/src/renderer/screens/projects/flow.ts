// The add in flight, as a pure reducer: messages in (the user, call answers, hub events, the connection), state and
// the calls to make out. The hub answers `project_add` and streams the clone's events separately, so an event can
// come before the answer that names its addId: those wait in `early`. A dropped connection loses the answer and any
// events sent meanwhile, so after the next snapshot the add is looked up again from where it started (`since`).

import type { HubError } from "../../../shared/hub";
import {
  ADD_EVENTS,
  type CloneProgressData,
  type EventsWaitOutput,
  type HubEvent,
  type ProjectAddFailedData,
  type ProjectAddInput,
  type ProjectAddOutput,
  type ProjectAddedData,
  type ProjectDiscoverOutput,
  type ProjectInspectOutput,
} from "./contracts";
import { discovery, progress, ready, existingFolderAction, type Discovery, type Failure, type ProjectKey, type Ready, type Request, type Step } from "./discovery";
import { baseName, omit } from "./source";

export interface Job {
  /** "acme/storefront", or a folder's name. */
  readonly what: string;
  readonly machineId: string;
  readonly path: string;
  readonly clone: boolean;
  readonly step: Step;
  readonly detail: string;
  readonly fraction?: number;
}

export type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "working"; readonly job: Job }
  | { readonly kind: "ready"; readonly ready: Ready }
  | { readonly kind: "failed"; readonly what: string; readonly failure: Failure };

export interface AddState {
  /** Null while the hub is looking (or before the first look). */
  readonly discovery: Discovery | null;
  readonly phase: Phase;
  readonly request?: Request;
  readonly addId?: string;
  /** The project_add call is out. */
  readonly awaiting: boolean;
  readonly early: ReadonlyArray<HubEvent>;
  /** The last event seq this app has seen, and its value when the add started. */
  readonly seen?: number;
  readonly since?: number;
  /** The connection dropped while the add ran; look it up once the snapshot is back. */
  readonly lost: boolean;
  /** A clone's failure, held while project_inspect says whether its folder can be added instead. */
  readonly held?: Failure;
  /** Bumped by each start, so an answer to an earlier add is ignored. */
  readonly gen: number;
  readonly live: boolean;
  /** A look for repos was asked for while offline: it runs on the next snapshot. */
  readonly discoverWanted: boolean;
}

export const initialAdd: AddState = {
  discovery: null,
  phase: { kind: "pick" },
  awaiting: false,
  early: [],
  lost: false,
  gen: 0,
  live: false,
  discoverWanted: false,
};

export type Purpose = "discover" | "add" | "inspect" | "recover";

export interface Call {
  readonly purpose: Purpose;
  readonly gen: number;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type Outcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError };

export type AddMsg =
  | { readonly t: "discover" }
  | { readonly t: "start"; readonly request: Request; readonly path: string }
  | { readonly t: "answer"; readonly call: Call; readonly outcome: Outcome }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "live"; readonly live: boolean }
  /** A snapshot arrived (the first, or the resync after a reconnect). */
  | { readonly t: "snapshot"; readonly cursor: number }
  | { readonly t: "back" }
  | { readonly t: "reset" };

/** Machine ids as names, for the discovery's detail lines. */
export type Names = (machineId: string) => string;

export type Step_ = readonly [AddState, ReadonlyArray<Call>];

/** Codes the shell itself reports when a call never got its answer (shared/hub.ts HubError). */
const CONNECTION = new Set(["disconnected", "offline", "timeout"]);
const EARLY_MAX = 64;
const LOST = "Lost the connection to the hub. Once it's back, this looks up where the add got to.";

const isAddEvent = (type: string): boolean => (ADD_EVENTS as ReadonlyArray<string>).includes(type);

const str = (data: unknown, key: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

const finish = (s: AddState): AddState => {
  const rest = omit(s, "request", "addId", "held");
  return { ...rest, awaiting: false, early: [], lost: false };
};

const fail = (s: AddState, failure: Failure): AddState => {
  const what = s.phase.kind === "working" ? s.phase.job.what : s.request ? requestWhat(s.request) : "the project";
  return { ...finish(s), phase: { kind: "failed", what, failure } };
};

const withJob = (s: AddState, change: (job: Job) => Job): AddState =>
  s.phase.kind === "working" ? { ...s, phase: { kind: "working", job: change(s.phase.job) } } : s;

const waiting = (s: AddState, why: string): AddState =>
  withJob(s, (job) => {
    const rest = omit(job, "fraction");
    return { ...rest, detail: why };
  });

export const requestWhat = (r: Request): string => (r.kind === "clone" ? r.repo : baseName(r.path));

const failure = (message: string, fix: string | undefined): Failure => (fix?.trim() ? { message, fix } : { message });

/** The add's own events: by addId once known, else (looking it up after a reconnect) by repo or path and machine. */
const owns = (s: AddState, e: HubEvent): boolean => {
  if (!isAddEvent(e.type)) return false;
  if (s.addId !== undefined) return str(e.data, "addId") === s.addId;
  const r = s.request;
  if (r === undefined || e.machineId !== r.machineId) return false;
  return r.kind === "clone" ? str(e.data, "repo") === r.repo : e.type === "project.added" && str(e.data, "path") === r.path;
};

const call = (s: AddState, purpose: Purpose, tool: string, input: Readonly<Record<string, unknown>>): Call => ({ purpose, gen: s.gen, tool, input });

const addInput = (r: Request): ProjectAddInput =>
  r.kind === "clone" ? { machineId: r.machineId, url: r.repo, ...(r.useExisting ? { useExisting: true } : {}) } : { machineId: r.machineId, path: r.path };

/** A clone refused because its folder exists: ask project_inspect whether that folder is this repo first. */
const holdAndInspect = (s: AddState, f: Failure): Step_ => {
  const r = s.request;
  if (r?.kind === "clone" && !r.useExisting && s.live) {
    const held = { ...s, held: f };
    return [held, [call(held, "inspect", "project_inspect", { machineId: r.machineId, url: r.repo })]];
  }
  return [fail(s, f), []];
};

const onEvent = (s: AddState, e: HubEvent, names: Names): Step_ => {
  if (!isAddEvent(e.type) || s.request === undefined) return [s, []];
  if (s.addId === undefined) {
    // The answer naming the add isn't here yet: keep the event for it.
    return s.awaiting && s.early.length < EARLY_MAX ? [{ ...s, early: [...s.early, e] }, []] : [s, []];
  }
  if (!owns(s, e)) return [s, []];
  if (e.type === "project.clone_progress") {
    const p = progress(e.data as CloneProgressData);
    return [
      withJob(s, (job) => {
        const rest = omit(job, "fraction");
        return { ...rest, step: p.step, detail: p.detail, ...(p.fraction === undefined ? {} : { fraction: p.fraction }) };
      }),
      [],
    ];
  }
  if (e.type === "project.added") {
    const added = e.data as ProjectAddedData;
    if (e.machineId === undefined || e.projectId === undefined) return [s, []];
    const r = ready({ machineId: e.machineId, projectId: e.projectId }, added.title, names(e.machineId), added.path, added.inspect);
    return [{ ...finish(s), phase: { kind: "ready", ready: r } }, []];
  }
  const failed = e.data as ProjectAddFailedData;
  const f = failure(failed.message, failed.fix);
  if (failed.code === "dest_exists") {
    const rest = omit(s, "addId");
    return holdAndInspect(rest, f);
  }
  return [fail(s, f), []];
};

/** After the snapshot that follows a reconnect: the add's events since it started. */
const recover = (s: AddState): Step_ => {
  if (!s.lost || s.request === undefined) return [s, []];
  const next = waiting({ ...s, lost: false }, "Reconnected; looking up where the add got to.");
  const input = { ...(s.since === undefined ? {} : { cursor: s.since }), types: [...ADD_EVENTS], machineId: s.request.machineId, timeoutSec: 0 };
  return [next, [call(next, "recover", "events_wait", input)]];
};

export const active = (s: AddState): boolean => s.request !== undefined && (s.awaiting || s.addId !== undefined || s.held !== undefined || s.lost);

export const step = (s: AddState, msg: AddMsg, names: Names): Step_ => {
  switch (msg.t) {
    case "discover":
      return s.live
        ? [{ ...s, discovery: null, discoverWanted: false }, [call(s, "discover", "project_discover", {})]]
        : [{ ...s, discovery: null, discoverWanted: true }, []];
    case "live": {
      if (msg.live) return [{ ...s, live: true }, []];
      if (!active(s) || s.lost) return [{ ...s, live: false }, []];
      return [waiting({ ...s, live: false, lost: true, awaiting: false, early: [] }, LOST), []];
    }
    case "snapshot": {
      const seen = s.seen === undefined || s.seen < msg.cursor ? msg.cursor : s.seen;
      const [next, calls] = recover({ ...s, seen, live: true });
      if (!next.discoverWanted) return [next, calls];
      const looking = { ...next, discoverWanted: false };
      return [looking, [...calls, call(looking, "discover", "project_discover", {})]];
    }
    case "start": {
      const r = msg.request;
      const job: Job =
        r.kind === "clone"
          ? { what: r.repo, machineId: r.machineId, path: msg.path, clone: true, step: "clone", detail: "Asking the hub" }
          : {
              what: baseName(r.path),
              machineId: r.machineId,
              path: r.path,
              clone: false,
              step: "inspect",
              detail: "Reading the default branch, CI and merge rules",
            };
      const base: AddState = {
        discovery: s.discovery,
        phase: { kind: "working", job },
        request: r,
        awaiting: true,
        early: [],
        lost: false,
        gen: s.gen + 1,
        live: s.live,
        discoverWanted: false,
        ...(s.seen === undefined ? {} : { seen: s.seen, since: s.seen }),
      };
      if (!s.live) return [waiting({ ...base, awaiting: false, lost: true }, LOST), []];
      return [base, [call(base, "add", "project_add", { ...addInput(r) })]];
    }
    case "event": {
      const seq = msg.event.seq;
      const seen = s.seen === undefined || s.seen < seq ? seq : s.seen;
      return onEvent({ ...s, seen }, msg.event, names);
    }
    case "back":
      return s.phase.kind === "failed" ? [{ ...s, phase: { kind: "pick" } }, []] : [s, []];
    case "reset":
      return active(s) ? [s, []] : [{ ...finish(s), phase: { kind: "pick" } }, []];
    case "answer":
      return answer(s, msg.call, msg.outcome, names);
  }
};

const answer = (s: AddState, c: Call, outcome: Outcome, names: Names): Step_ => {
  if (c.purpose === "discover") {
    // An older hub without project_discover still gets the machines from the snapshot, nothing listed.
    if (!outcome.ok) return [{ ...s, discovery: { workers: [], found: [], problems: [failure(outcome.error.message, outcome.error.fix)] } }, []];
    return [{ ...s, discovery: discovery(outcome.output as ProjectDiscoverOutput, names) }, []];
  }
  if (c.gen !== s.gen || s.request === undefined) return [s, []];
  switch (c.purpose) {
    case "add": {
      if (!outcome.ok) {
        if (CONNECTION.has(outcome.error.code)) {
          // The hub may have taken it: look it up once the connection is back rather than say it failed.
          return [waiting({ ...s, awaiting: false, early: [], lost: true }, LOST), []];
        }
        return holdAndInspect({ ...s, awaiting: false, early: [] }, failure(outcome.error.message, outcome.error.fix));
      }
      const o = outcome.output as ProjectAddOutput;
      if (o.addId !== undefined) {
        let next: AddState = waiting({ ...s, awaiting: false, early: [], addId: o.addId }, "Starting the clone");
        next = withJob(next, (job) => ({ ...job, path: o.path }));
        const calls: Array<Call> = [];
        for (const e of s.early) {
          const [after, more] = onEvent(next, e, names);
          next = after;
          calls.push(...more);
        }
        return [next, calls];
      }
      if (o.projectId !== undefined && o.inspect !== undefined) {
        const r = ready({ machineId: o.machineId, projectId: o.projectId }, baseName(o.path), names(o.machineId), o.path, o.inspect);
        return [{ ...finish(s), phase: { kind: "ready", ready: r } }, []];
      }
      return [fail(s, { message: "The hub added it but sent no details.", fix: "Find it in the sidebar; if it isn't there, try again." }), []];
    }
    case "inspect": {
      const held = s.held ?? { message: "The folder for the clone already exists." };
      const rest = omit(s, "held");
      const target = outcome.ok ? (outcome.output as ProjectInspectOutput).clone : undefined;
      const action = target ? existingFolderAction(target, s.request) : undefined;
      return [fail(rest, action ? { ...held, action } : held), []];
    }
    case "recover": {
      if (!outcome.ok) {
        if (CONNECTION.has(outcome.error.code)) return [waiting({ ...s, lost: true }, LOST), []];
        return [
          fail(s, {
            message: `Lost track of the add after reconnecting: ${outcome.error.message}`,
            fix: "Look for it in the sidebar; if it isn't there, add it again.",
          }),
          [],
        ];
      }
      const page = outcome.output as EventsWaitOutput;
      let next = s;
      const calls: Array<Call> = [];
      for (const e of page.events) {
        if (next.request === undefined) break;
        if (next.addId === undefined && owns(next, e)) {
          const id = str(e.data, "addId");
          if (id !== undefined) next = { ...next, addId: id };
        }
        const [after, more] = onEvent(next, e, names);
        next = after;
        calls.push(...more);
      }
      if (next.request === undefined || calls.length > 0) return [next, calls];
      if (page.more) return recover({ ...next, since: page.cursor, lost: true });
      if (next.addId !== undefined) return [waiting(next, "Reconnected. The clone is still running; its next progress shows here."), []];
      return [
        fail(next, {
          message: "The connection dropped before the hub answered, and it has no record of this add.",
          fix: "Send it again.",
          action: { kind: "retry", request: next.request },
        }),
        [],
      ];
    }
  }
};

export type { ProjectKey };

/**
 * What the add flow must hear when it starts listening after the fleet already has: the connection as it is now and
 * the snapshot it already took. Frames only reach listeners from when they join, so without this a sheet opened after
 * the palette or Machines would wait forever for a "live" that came before it.
 */
export const seedFrom = (fleet: { readonly live: boolean; readonly synced: boolean; readonly cursor?: number }): ReadonlyArray<AddMsg> => {
  if (!fleet.live) return [];
  return fleet.synced && fleet.cursor !== undefined ? [{ t: "live", live: true }, { t: "snapshot", cursor: fleet.cursor }] : [{ t: "live", live: true }];
};
