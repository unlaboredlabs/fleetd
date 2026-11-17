// A new bot as a pure reducer, shared with the phone: a name and its repos in (none, one or several), the hub calls
// out. The bot is made first with project_add: in the first folder listed, which is then its own folder, else in a
// new folder the hub makes for it. Every other repo goes to it with project_repo_add: a folder on its machine at once,
// a GitHub repo as a clone whose progress and end come as events naming its addId (one can come before the answer
// that names it: those wait in `early`). A repo that fails leaves the bot made: its row says why, with Retry, and
// "Use the checkout there" when the clone's folder already holds that repo.

import type { ToolInput } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { ADD_EVENTS, type CloneProgressData, type HubEvent, type ProjectAddFailedData, type ProjectAddOutput, type ProjectAddedData, type ProjectSummary } from "./contracts";
import { progress, type ProjectKey } from "./discovery";
import { addSource, baseName, otherHost } from "./source";

/** One repo in the list: a GitHub repo to clone onto the bot's machine, or a folder already on it. */
export type RepoDraft = { readonly kind: "clone"; readonly repo: string } | { readonly kind: "folder"; readonly path: string };

export interface Draft {
  readonly name: string;
  readonly machineId: string;
  readonly repos: ReadonlyArray<RepoDraft>;
}

/** A row's key, the same for the same repo however it was typed. */
export const repoKey = (r: RepoDraft): string => (r.kind === "clone" ? `gh:${r.repo.toLowerCase()}` : `dir:${r.path.replace(/(.)\/+$/u, "$1")}`);

/** What a row reads as: owner/repo, or the folder's path. */
export const repoLabel = (r: RepoDraft): string => (r.kind === "clone" ? r.repo : r.path);

/** The bot's name: as typed, else its first repo's. Empty when neither. */
export const botName = (name: string, repos: ReadonlyArray<RepoDraft>): string => {
  const t = name.trim();
  if (t !== "") return t;
  const first = repos[0];
  return first === undefined ? "" : baseName(repoLabel(first));
};

const trimmed = (path: string): string => path.replace(/(.)\/+$/u, "$1");

/**
 * What the add field's text adds as it stands, for a Create pressed before it was added: the repo, or why it can't
 * be added yet. Null when the field is empty, so there is nothing to add.
 */
export const typedRepo = (text: string): { readonly repo: RepoDraft } | { readonly why: string } | null => {
  const t = text.trim();
  if (t === "") return null;
  const other = otherHost(t);
  if (other !== null) return { why: other };
  const src = addSource(t);
  if (src === null) return { why: `"${t}" isn't a repo yet: pick one from the list, or clear the field.` };
  if (src.kind === "github") return { repo: { kind: "clone", repo: src.repo } };
  if (!src.path.startsWith("/")) return { why: "Type the folder's full path, starting with /." };
  return { repo: { kind: "folder", path: trimmed(src.path) } };
};

type Listed = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "workspaceRoot" | "repos">;

/** The bot whose own folder is `path` on `machineId`: adding it would take that bot's place, so it isn't added. */
export const botAtFolder = (projects: Readonly<Record<string, Listed>>, machineId: string | undefined, path: string): Listed | undefined =>
  Object.values(projects).find((p) => p.machineId === machineId && trimmed(p.workspaceRoot) === trimmed(path));

/**
 * The bot that is the checkout a failed clone found in its way (`at`, the hub's path, or the GitHub repo its own
 * checkout tracks): adding that checkout to another bot archives it read-only (hub/projects/repos.ts attachCheckout).
 */
export const botHolding = (projects: Readonly<Record<string, Listed>>, machineId: string, repo: string, at: string | undefined, self: string): Listed | undefined => {
  const key = `github.com/${repo}`.toLowerCase();
  return Object.values(projects).find(
    (p) =>
      p.machineId === machineId &&
      p.projectId !== self &&
      ((at !== undefined && trimmed(p.workspaceRoot) === trimmed(at)) || (p.repos ?? []).some((r) => r.checkout.projectId === p.projectId && r.repoKey?.toLowerCase() === key)),
  );
};

/** The repo whose folder becomes the bot's own: the first folder listed. None: the hub makes a folder for it. */
export const ownRepo = (repos: ReadonlyArray<RepoDraft>): RepoDraft | undefined => repos.find((r) => r.kind === "folder");

export type RepoState =
  /** Waits for the bot to be made. */
  | { readonly t: "waiting" }
  | { readonly t: "adding"; readonly detail: string; readonly fraction?: number }
  /** `archived`: the bot that checkout was until now, archived read-only by the add. */
  | { readonly t: "added"; readonly path: string; readonly archived?: ProjectKey }
  /** `existing`: the clone's folder (`at`, as the hub says it) already holds this repo, which can be added as it is. */
  | { readonly t: "failed"; readonly message: string; readonly fix?: string; readonly existing?: boolean; readonly at?: string };

export interface RepoJob {
  readonly key: string;
  readonly draft: RepoDraft;
  readonly state: RepoState;
  /** The clone's, once the hub's answer names it. */
  readonly addId?: string;
  /** Its project_repo_add is out. */
  readonly awaiting?: boolean;
}

export interface Bot {
  readonly project: ProjectKey;
  readonly title: string;
  readonly path: string;
}

export type Phase =
  | { readonly kind: "form" }
  /** project_add is out. */
  | { readonly kind: "creating"; readonly title: string }
  /** The bot wasn't made; Back goes to the form as it was. */
  | { readonly kind: "failed"; readonly title: string; readonly message: string; readonly fix?: string }
  /** The bot is made; its repos are being added, or are. */
  | { readonly kind: "made"; readonly bot: Bot };

export interface CreateState {
  readonly phase: Phase;
  readonly jobs: ReadonlyArray<RepoJob>;
  readonly early: ReadonlyArray<HubEvent>;
  /** Bumped by each create, so an answer to an earlier one is ignored. */
  readonly gen: number;
  readonly live: boolean;
}

export const initialCreate: CreateState = { phase: { kind: "form" }, jobs: [], early: [], gen: 0, live: false };

export type Call =
  | { readonly kind: "create"; readonly gen: number; readonly input: ToolInput<"project_add"> }
  | { readonly kind: "repo"; readonly gen: number; readonly key: string; readonly input: ToolInput<"project_repo_add"> };

export type Outcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError };

export type CreateMsg =
  | { readonly t: "start"; readonly draft: Draft }
  | { readonly t: "answer"; readonly call: Call; readonly outcome: Outcome }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "live"; readonly live: boolean }
  /** A snapshot after a drop: a repo the bot now lists was added while the link was down. */
  | { readonly t: "snapshot"; readonly projects: ReadonlyArray<ProjectSummary> }
  | { readonly t: "retry"; readonly key: string; readonly useExisting?: boolean }
  /** A failed row taken out of the list: nothing on the hub changes. */
  | { readonly t: "dismiss"; readonly key: string }
  | { readonly t: "back" }
  | { readonly t: "reset" };

export type Step_ = readonly [CreateState, ReadonlyArray<Call>];

/** Codes the shell itself reports when a call never got its answer (shared/hub.ts HubError). */
const CONNECTION = new Set(["disconnected", "offline", "timeout"]);
const EARLY_MAX = 64;
const LOST_CREATE = "Lost the connection to the hub before it answered.";
const LOST_CREATE_FIX = "If the bot was made, it shows in the sidebar once the hub is back; else create it again.";
const LOST_REPO = "Lost the connection: it shows here once the hub is back.";

const str = (data: unknown, key: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

const sentence = (text: string): string => (/[.?!…]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** The folder in the hub's "<machine> already has a checkout of <repo> at <path>" (hub/projects/add.ts destTaken). */
const atPath = (message: string): string | undefined => / at (\/\S+?)\.?$/u.exec(message.trim())?.[1];

const failed = (message: string, fix: string | undefined, existing = false): RepoState => {
  // The hub names its own field in the fix ("Add that checkout instead (useExisting)"): the row's button says it.
  if (existing) {
    const at = atPath(message);
    return { t: "failed", message: sentence(message), existing: true, ...(at === undefined ? {} : { at }) };
  }
  return fix?.trim() ? { t: "failed", message: sentence(message), fix: sentence(fix) } : { t: "failed", message: sentence(message) };
};

/** A clone refused because its folder already holds the same repo (hub/projects/add.ts destTaken). */
const sameRepoThere = (fix: string | undefined): boolean => fix !== undefined && /\buseExisting\b/u.test(fix);

export const settled = (j: RepoJob): boolean => j.state.t === "added" || j.state.t === "failed";

/** Something is still being made or added: closing the dialog leaves it running. */
export const busy = (s: CreateState): boolean => s.phase.kind === "creating" || (s.phase.kind === "made" && s.jobs.some((j) => !settled(j)));

/** Events wait only while an answer that may name them is out. */
const trimEarly = (s: CreateState): CreateState => (s.jobs.some((j) => j.awaiting === true) || s.early.length === 0 ? s : { ...s, early: [] });

const withJob = (s: CreateState, key: string, change: (j: RepoJob) => RepoJob): CreateState => ({ ...s, jobs: s.jobs.map((j) => (j.key === key ? change(j) : j)) });

const repoInput = (bot: ProjectKey, d: RepoDraft, useExisting: boolean): ToolInput<"project_repo_add"> =>
  d.kind === "clone" ? { ...bot, url: d.repo, ...(useExisting ? { useExisting: true } : {}) } : { ...bot, path: d.path };

const sendRepo = (s: CreateState, bot: ProjectKey, key: string, useExisting: boolean): Step_ => {
  const job = s.jobs.find((j) => j.key === key);
  if (job === undefined) return [s, []];
  const detail = job.draft.kind === "clone" ? "Asking the hub" : "Reading the folder";
  const next = withJob(s, key, (j) => ({ key: j.key, draft: j.draft, state: { t: "adding", detail }, awaiting: true }));
  return [next, [{ kind: "repo", gen: s.gen, key, input: repoInput(bot, job.draft, useExisting) }]];
};

const start = (s: CreateState, draft: Draft): Step_ => {
  const title = botName(draft.name, draft.repos);
  const own = ownRepo(draft.repos);
  const seen = new Set<string>();
  const jobs: Array<RepoJob> = [];
  for (const r of draft.repos) {
    const key = repoKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ key, draft: r, state: { t: "waiting" } });
  }
  const gen = s.gen + 1;
  const input: ToolInput<"project_add"> =
    own === undefined ? { machineId: draft.machineId, create: true, title } : { machineId: draft.machineId, path: own.kind === "folder" ? own.path : "", title };
  return [{ phase: { kind: "creating", title }, jobs, early: [], gen, live: s.live }, [{ kind: "create", gen, input }]];
};

const onCreated = (s: CreateState, out: ProjectAddOutput, title: string, ownKey: string | undefined): Step_ => {
  if (out.projectId === undefined) {
    return [{ ...s, phase: { kind: "failed", title, message: "The hub made it but sent no details.", fix: "Find it in the sidebar; if it isn't there, create it again." } }, []];
  }
  const bot: Bot = { project: { machineId: out.machineId, projectId: out.projectId }, title, path: out.path };
  let next: CreateState = { ...s, phase: { kind: "made", bot }, jobs: s.jobs.map((j) => (j.key === ownKey ? { key: j.key, draft: j.draft, state: { t: "added", path: out.path } } : j)) };
  const calls: Array<Call> = [];
  for (const j of next.jobs) {
    if (j.state.t !== "waiting") continue;
    const [after, more] = sendRepo(next, bot.project, j.key, false);
    next = after;
    calls.push(...more);
  }
  return [next, calls];
};

const answer = (s: CreateState, c: Call, outcome: Outcome): Step_ => {
  if (c.gen !== s.gen) return [s, []];
  if (c.kind === "create") {
    if (s.phase.kind !== "creating") return [s, []];
    const title = s.phase.title;
    if (!outcome.ok) {
      const lost = CONNECTION.has(outcome.error.code);
      const message = lost ? LOST_CREATE : sentence(outcome.error.message);
      const fix = lost ? LOST_CREATE_FIX : outcome.error.fix;
      return [{ ...s, phase: { kind: "failed", title, message, ...(fix?.trim() ? { fix: sentence(fix) } : {}) } }, []];
    }
    const own = s.jobs.find((j) => j.draft.kind === "folder");
    return onCreated(s, outcome.output as ProjectAddOutput, title, own?.key);
  }
  const job = s.jobs.find((j) => j.key === c.key);
  if (job === undefined || job.awaiting !== true) return [s, []];
  if (!outcome.ok) {
    const lost = CONNECTION.has(outcome.error.code);
    const state: RepoState = lost ? { t: "adding", detail: LOST_REPO } : failed(outcome.error.message, outcome.error.fix, sameRepoThere(outcome.error.fix));
    return [trimEarly(withJob(s, c.key, (j) => ({ key: j.key, draft: j.draft, state }))), []];
  }
  const out = outcome.output as { path: string; addId?: string; repo?: { path?: string }; archived?: ProjectKey };
  if (out.addId === undefined) {
    const archived = out.archived === undefined ? {} : { archived: { machineId: out.archived.machineId, projectId: out.archived.projectId } };
    return [withJob(s, c.key, (j) => ({ key: j.key, draft: j.draft, state: { t: "added", path: out.repo?.path ?? out.path, ...archived } })), []];
  }
  const addId = out.addId;
  // Events that came before this answer: the ones naming its addId are its own.
  const mine = s.early.filter((e) => str(e.data, "addId") === addId);
  let next = withJob({ ...s, early: s.early.filter((e) => !mine.includes(e)) }, c.key, (j) => ({ key: j.key, draft: j.draft, addId, state: { t: "adding", detail: "Starting the clone" } }));
  for (const e of mine) next = onEvent(next, e);
  return [trimEarly(next), []];
};

const isAddEvent = (type: string): boolean => (ADD_EVENTS as ReadonlyArray<string>).includes(type);

const onEvent = (s: CreateState, e: HubEvent): CreateState => {
  if (!isAddEvent(e.type) || s.phase.kind !== "made") return s;
  const addId = str(e.data, "addId");
  if (addId === undefined) return s;
  const job = s.jobs.find((j) => j.addId === addId);
  if (job === undefined) {
    // The answer naming it isn't here yet: keep the event for it.
    return s.jobs.some((j) => j.awaiting === true) && s.early.length < EARLY_MAX ? { ...s, early: [...s.early, e] } : s;
  }
  if (e.type === "project.clone_progress") {
    const p = progress(e.data as CloneProgressData);
    return withJob(s, job.key, (j) => ({ ...j, state: { t: "adding", detail: p.detail, ...(p.fraction === undefined ? {} : { fraction: p.fraction }) } }));
  }
  if (e.type === "project.added") {
    const added = e.data as ProjectAddedData;
    return withJob(s, job.key, (j) => ({ key: j.key, draft: j.draft, state: { t: "added", path: added.path } }));
  }
  const f = e.data as ProjectAddFailedData;
  return withJob(s, job.key, (j) => ({ key: j.key, draft: j.draft, state: failed(f.message, f.fix, f.code === "dest_exists" && sameRepoThere(f.fix)) }));
};

/** After a drop: a repo the bot now lists (by its folder) was added meanwhile. */
const settle = (s: CreateState, projects: ReadonlyArray<ProjectSummary>): CreateState => {
  if (s.phase.kind !== "made") return s;
  const { machineId, projectId } = s.phase.bot.project;
  const p = projects.find((x) => x.machineId === machineId && x.projectId === projectId);
  if (p === undefined) return s;
  const paths = (p.repos ?? []).flatMap((r) => (r.path === undefined ? [] : [r.path]));
  return {
    ...s,
    jobs: s.jobs.map((j) => {
      if (settled(j)) return j;
      const at = paths.find((path) => (j.draft.kind === "folder" ? path === j.draft.path : baseName(path) === baseName(j.draft.repo)));
      return at === undefined ? j : { key: j.key, draft: j.draft, state: { t: "added", path: at } };
    }),
  };
};

export const createStep = (s: CreateState, msg: CreateMsg): Step_ => {
  switch (msg.t) {
    case "start":
      return busy(s) ? [s, []] : start(s, msg.draft);
    case "answer":
      return answer(s, msg.call, msg.outcome);
    case "event":
      return [onEvent(s, msg.event), []];
    case "live":
      return [{ ...s, live: msg.live }, []];
    case "snapshot":
      return [settle(s, msg.projects), []];
    case "retry": {
      if (s.phase.kind !== "made") return [s, []];
      const job = s.jobs.find((j) => j.key === msg.key);
      if (job?.state.t !== "failed") return [s, []];
      return sendRepo(s, s.phase.bot.project, msg.key, msg.useExisting === true);
    }
    case "dismiss":
      return [{ ...s, jobs: s.jobs.filter((j) => j.key !== msg.key || !settled(j)) }, []];
    case "back":
      return s.phase.kind === "failed" ? [{ ...s, phase: { kind: "form" }, jobs: [] }, []] : [s, []];
    case "reset":
      return busy(s) ? [s, []] : [{ ...initialCreate, gen: s.gen, live: s.live }, []];
  }
};

/** The repos' state in one line, for a toast when the dialog is hidden: null while any is still being added. */
export const outcomeLine = (s: CreateState): { readonly title: string; readonly problem: boolean } | null => {
  if (s.phase.kind !== "made" || s.jobs.some((j) => !settled(j))) return null;
  const bad = s.jobs.filter((j) => j.state.t === "failed");
  const name = s.phase.bot.title;
  if (bad.length === 0) return { title: s.jobs.length === 1 ? `${name} has its repo` : `${name} has its ${String(s.jobs.length)} repos`, problem: false };
  const which = bad.map((j) => baseName(repoLabel(j.draft))).join(", ");
  return { title: `Couldn't add ${which} to ${name}`, problem: true };
};

/** The hub's events this flow follows, newest after `lastSeq`, and whether the link is up: from the data layer's store. */
export interface HubView {
  readonly live: boolean;
  readonly fresh: boolean;
  readonly projects: Readonly<Record<string, ProjectSummary>>;
  /** Oldest first. */
  readonly events: ReadonlyArray<HubEvent>;
}

/** The messages a change in the store means for the flow. `prev` undefined is the first look: old events aren't news. */
export const hubMessages = (prev: HubView | undefined, next: HubView, lastSeq: number | undefined): ReadonlyArray<CreateMsg> => {
  const out: Array<CreateMsg> = [];
  if (prev === undefined || prev.live !== next.live) out.push({ t: "live", live: next.live });
  if (next.fresh && (prev === undefined || !prev.fresh)) out.push({ t: "snapshot", projects: Object.values(next.projects) });
  if (prev !== undefined) for (const event of next.events) if (lastSeq === undefined || event.seq > lastSeq) out.push({ t: "event", event });
  return out;
};
