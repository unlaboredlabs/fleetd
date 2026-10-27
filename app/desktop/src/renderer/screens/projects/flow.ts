// The add in flight, as a pure reducer: messages in (the user, call answers, hub events, the connection), state and
// the calls to make out. The hub answers `project_add` and streams the clone's events separately, so an event can
// come before the answer that names its addId: those wait in `early`. A dropped connection loses the answer and any
// events sent meanwhile, so the next snapshot settles it: its project list has the project (added), or it doesn't
// yet (unlisted: a clone may still be running, so it is never called failed).

import type { ToolInput } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import {
  ADD_EVENTS,
  type CloneProgressData,
  type HubEvent,
  type ProjectAddFailedData,
  type ProjectAddInput,
  type ProjectAddOutput,
  type ProjectAddedData,
  type ProjectSummary,
} from "./contracts";
import { progress, ready, existingFolderAction, type Failure, type ProjectKey, type Ready, type Request, type Step } from "./discovery";
import { baseName, omit, tilde } from "./source";

export interface Job {
  /** "acme/storefront", or a folder's name. */
  readonly what: string;
  readonly machineId: string;
  readonly path: string;
  readonly clone: boolean;
  /** A new project: the hub makes its folder, so there is nothing to clone or inspect. */
  readonly create?: true;
  readonly step: Step;
  readonly detail: string;
  readonly fraction?: number;
}

export type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "working"; readonly job: Job }
  | { readonly kind: "ready"; readonly ready: Ready }
  | { readonly kind: "failed"; readonly what: string; readonly failure: Failure }
  /** After a drop, the hub doesn't list the project yet: a clone may still be running, or it failed (Machines says). */
  | { readonly kind: "unlisted"; readonly what: string; readonly path: string; readonly request: Request };

export interface AddState {
  readonly phase: Phase;
  readonly request?: Request;
  readonly addId?: string;
  /** The project_add call is out. */
  readonly awaiting: boolean;
  readonly early: ReadonlyArray<HubEvent>;
  /** The connection dropped while the add ran; the next snapshot settles it. */
  readonly lost: boolean;
  /** A clone's failure, held while a dry run says whether its folder can be added instead. */
  readonly held?: Failure;
  /** Bumped by each start, so an answer to an earlier add is ignored. */
  readonly gen: number;
  readonly live: boolean;
}

export const initialAdd: AddState = { phase: { kind: "pick" }, awaiting: false, early: [], lost: false, gen: 0, live: false };

/** A step's project_add: the add itself, or the dry run that inspects a clone's existing folder. */
export interface Call {
  readonly purpose: "add" | "inspect";
  readonly gen: number;
  readonly input: ToolInput<"project_add">;
}

export type Outcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError };

export type AddMsg =
  | { readonly t: "start"; readonly request: Request; readonly path: string }
  | { readonly t: "answer"; readonly call: Call; readonly outcome: Outcome }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "live"; readonly live: boolean }
  /** A snapshot arrived (the first, or the resync after a reconnect), with the hub's projects. */
  | { readonly t: "snapshot"; readonly projects: ReadonlyArray<ProjectSummary> }
  | { readonly t: "back" }
  | { readonly t: "reset" };

/** Machine ids as names, for the ready state. */
export type Names = (machineId: string) => string;

export type Step_ = readonly [AddState, ReadonlyArray<Call>];

/** Codes the shell itself reports when a call never got its answer (shared/hub.ts HubError). */
const CONNECTION = new Set(["disconnected", "offline", "timeout"]);
const EARLY_MAX = 64;
const LOST = "Lost the connection to the hub. Once it's back, this checks whether the project was added.";

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

export const requestWhat = (r: Request): string => (r.kind === "clone" ? r.repo : r.kind === "new" ? r.name : baseName(r.path));

const failure = (message: string, fix: string | undefined): Failure => (fix?.trim() ? { message, fix } : { message });


const addInput = (r: Request): ProjectAddInput => {
  switch (r.kind) {
    case "clone":
      return { machineId: r.machineId, url: r.repo, ...(r.useExisting ? { useExisting: true } : {}) };
    case "folder":
      return { machineId: r.machineId, path: r.path };
    case "new":
      return { machineId: r.machineId, path: r.path, title: r.name, create: true, ...(r.gitInit ? { gitInit: true } : {}) };
  }
};

/** A clone refused because its folder exists: ask a dry-run project_add whether that folder is this repo first. */
const holdAndInspect = (s: AddState, f: Failure): Step_ => {
  const r = s.request;
  if (r?.kind === "clone" && !r.useExisting && s.live) {
    const held = { ...s, held: f };
    return [held, [{ purpose: "inspect", gen: held.gen, input: { machineId: r.machineId, url: r.repo, dryRun: true } }]];
  }
  return [fail(s, f), []];
};

const onEvent = (s: AddState, e: HubEvent, names: Names): Step_ => {
  if (!isAddEvent(e.type) || s.request === undefined) return [s, []];
  if (s.addId === undefined) {
    // The answer naming the add isn't here yet: keep the event for it.
    return s.awaiting && s.early.length < EARLY_MAX ? [{ ...s, early: [...s.early, e] }, []] : [s, []];
  }
  if (str(e.data, "addId") !== s.addId) return [s, []];
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

/** The snapshot after a drop settles the add: the project is in its list (added while the link was down), or not yet. */
const settle = (s: AddState, projects: ReadonlyArray<ProjectSummary>, names: Names): Step_ => {
  if (!s.lost || s.request === undefined || s.phase.kind !== "working") return [s, []];
  const { machineId, path } = s.phase.job;
  const p = projects.find((x) => x.machineId === machineId && (x.workspaceRoot === path || (path.startsWith("~/") && x.workspaceRoot.endsWith(path.slice(1)))));
  if (p !== undefined) {
    const ready: Ready = { project: { machineId, projectId: p.projectId }, title: p.title, machine: names(machineId), path: p.workspaceRoot, facts: [], leadLine: "Added while the connection was down.", leadOk: true, notes: [] };
    return [{ ...finish(s), phase: { kind: "ready", ready } }, []];
  }
  return [{ ...finish(s), phase: { kind: "unlisted", what: s.phase.job.what, path, request: s.request } }, []];
};

export const active = (s: AddState): boolean => s.request !== undefined && (s.awaiting || s.addId !== undefined || s.held !== undefined || s.lost);

export const step = (s: AddState, msg: AddMsg, names: Names): Step_ => {
  switch (msg.t) {
    case "live": {
      if (msg.live) return [{ ...s, live: true }, []];
      if (!active(s) || s.lost) return [{ ...s, live: false }, []];
      return [waiting({ ...s, live: false, lost: true, awaiting: false, early: [] }, LOST), []];
    }
    case "snapshot":
      return settle({ ...s, live: true }, msg.projects, names);
    case "start": {
      const r = msg.request;
      const job: Job =
        r.kind === "clone"
          ? { what: r.repo, machineId: r.machineId, path: msg.path, clone: true, step: "clone", detail: "Asking the hub" }
          : r.kind === "new"
            ? { what: r.name, machineId: r.machineId, path: r.path, clone: false, create: true, step: "register", detail: "Making the folder" }
            : {
              what: baseName(r.path),
              machineId: r.machineId,
              path: r.path,
              clone: false,
              step: "inspect",
              detail: "Reading the default branch, CI and merge rules",
            };
      const base: AddState = {
        phase: { kind: "working", job },
        request: r,
        awaiting: true,
        early: [],
        lost: false,
        gen: s.gen + 1,
        live: s.live,
      };
      if (!s.live) return [waiting({ ...base, awaiting: false, lost: true }, LOST), []];
      return [base, [{ purpose: "add", gen: base.gen, input: addInput(r) }]];
    }
    case "event":
      return onEvent(s, msg.event, names);
    case "back":
      return s.phase.kind === "failed" || s.phase.kind === "unlisted" ? [{ ...s, phase: { kind: "pick" } }, []] : [s, []];
    case "reset":
      return active(s) ? [s, []] : [{ ...finish(s), phase: { kind: "pick" } }, []];
    case "answer":
      return answer(s, msg.call, msg.outcome, names);
  }
};

const answer = (s: AddState, c: Call, outcome: Outcome, names: Names): Step_ => {
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
        const title = s.request.kind === "new" ? s.request.name : baseName(o.path);
        const r = ready({ machineId: o.machineId, projectId: o.projectId }, title, names(o.machineId), o.path, o.inspect);
        return [{ ...finish(s), phase: { kind: "ready", ready: r } }, []];
      }
      return [fail(s, { message: "The hub added it but sent no details.", fix: "Find it in the sidebar; if it isn't there, try again." }), []];
    }
    case "inspect": {
      const held = s.held ?? { message: "The folder for the clone already exists." };
      const rest = omit(s, "held");
      const target = outcome.ok ? (outcome.output as ProjectAddOutput).clone : undefined;
      const action = target ? existingFolderAction(target, s.request) : undefined;
      return [fail(rest, action ? { ...held, action } : held), []];
    }
  }
};

/**
 * A new project refused because its folder is already a project (the hub says so): the failure offers to open that
 * project, found in the hub's list by its machine and folder.
 */
export const offerOpen = (s: AddState, r: Request | undefined, projects: Readonly<Record<string, ProjectSummary>>): AddState => {
  if (r?.kind !== "new" || s.phase.kind !== "failed" || s.phase.failure.action !== undefined) return s;
  const root = (path: string) => path.replace(/(.)\/+$/u, "$1");
  // A folder typed as ~/x is the project's /home/<user>/x.
  const same = (path: string) => root(path) === root(r.path) || (r.path.startsWith("~/") && tilde(root(path)) === root(r.path));
  const p = Object.values(projects).find((x) => x.machineId === r.machineId && same(x.workspaceRoot));
  if (p === undefined) return s;
  const action = { kind: "open", project: { machineId: p.machineId, projectId: p.projectId } } as const;
  return { ...s, phase: { ...s.phase, failure: { ...s.phase.failure, action } } };
};

export type { ProjectKey };

/** What the add flow reads of the data layer's store (E1): the connection, freshness, the projects and recent events. */
export interface HubView {
  readonly live: boolean;
  /** A snapshot arrived since the link last went down. */
  readonly fresh: boolean;
  readonly projects: Readonly<Record<string, ProjectSummary>>;
  /** Oldest first. */
  readonly events: ReadonlyArray<HubEvent>;
}

/**
 * The messages a change in the store means for the add flow. `prev` undefined is the first look: whatever the store
 * already holds (the palette or Machines may have started it long before) counts as news, except old events.
 */
export const hubMessages = (prev: HubView | undefined, next: HubView, lastSeq: number | undefined): ReadonlyArray<AddMsg> => {
  const out: Array<AddMsg> = [];
  if (prev === undefined || prev.live !== next.live) out.push({ t: "live", live: next.live });
  if (next.fresh && (prev === undefined || !prev.fresh)) out.push({ t: "snapshot", projects: Object.values(next.projects) });
  if (prev !== undefined) for (const event of next.events) if (lastSeq === undefined || event.seq > lastSeq) out.push({ t: "event", event });
  return out;
};
