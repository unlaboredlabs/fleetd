// project_add: add a path (a git checkout or a plain folder), make a new
// folder (`create`), or clone a GitHub repository with progress events; then register it on its node and emit
// `project.added` with its inspect. A clone cut off by a hub restart gets its `project.add_failed` at the next start.
import type {
  CloneProgressData,
  GitHubRepo,
  HubEventType,
  MachineId,
  PersonId,
  ProjectAddInput,
  ProjectAddOutput,
  ProjectId,
  ProjectInspect,
  ProjectProblem,
  ProjectRef,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_FOLDER_MAKE } from "../../shared/node_link.ts";
import { type CloneProgressFrame, FOLDER_NOT_EMPTY, type RepoFacts } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { ExecutorError, executors, newUuid } from "../executor/index.ts";
import { projectUpsert } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/index.ts";
import { startNew as startApprovals } from "../navi/checker.ts";
import { who } from "../navi/owner.ts";
import { setOnlyMe as storeOnlyMe } from "../navi/store.ts";
import * as repos from "../repos/store.ts";
import { type EventLog, events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import {
  checkout,
  cloneTarget,
  folderMake,
  inspectCheckout,
  nodeError,
  nodeProblem,
  problem,
  problemError,
  projectAt,
  readGithub,
  repoClone,
  repoOf,
  repoScan,
  targetMachine,
} from "./discover.ts";
import { build, cutPath, fitAdded, fitFailed, folder, noAnswers, cloneProblem, repoKeyOf } from "./inspect.ts";
import { setOnlyMe } from "./settings.ts";

export const now = (hub: Hub) => isoMs(hub.clock.now());

const stripSlash = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
const lastPart = (p: string) => p.split("/").pop() ?? p;

/** Only me as `project_add` sets it (D310): what the call asked, and whose the project becomes when it is on. */
export class OnlyMe {
  constructor(
    readonly asked: boolean | undefined,
    readonly owner: PersonId | undefined,
    readonly caller: Caller,
  ) {}

  static of(hub: Hub, caller: Caller, asked: boolean | undefined): OnlyMe {
    return new OnlyMe(asked, who(hub.db.conn, caller), caller);
  }

  /**
   * Sets it on a project just added (`created`): as asked, else on for one with no repo, and the caller's. An existing
   * project keeps its own unless asked, and then changes only as `project_settings_set` changes it: by its owner or an
   * admin, from a person's own device.
   */
  apply(hub: Hub, r: ProjectRef, created: boolean, git: boolean): void {
    if (!created) {
      if (this.asked === undefined) return;
      const project = store(hub).projectGet(r);
      if (!project) throw unknownProject(r);
      setOnlyMe(hub, this.caller, project, this.asked);
      return;
    }
    storeOnlyMe(hub.db.conn, r, this.asked ?? !git, this.owner);
  }
}

/** A branch name as the contracts take one (`Line<1, 250>`). */
const isLine = (s: string) => s.length >= 1 && s.length <= 250 && !/[\r\n]/.test(s);

/**
 * Records the repo and base the project's work lands on, from what adding it read (work/mod.rs `bind_project`). The
 * work area's binding reads them again for a project that has none recorded.
 */
export function bindScope(hub: Hub, m: MachineId, projectId: ProjectId, facts: RepoFacts): void {
  const repoKey = facts.remote !== undefined ? repoKeyOf(facts.remote) : undefined;
  const base = facts.defaultBranch !== undefined && isLine(facts.defaultBranch) ? facts.defaultBranch : undefined;
  if (repoKey === undefined || base === undefined) return;
  const project = { machineId: m, projectId };
  try {
    hub.db.transaction((c) => {
      c.query(
        `INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET repo_key = ?3, base = ?4, updated_ms = ?5`,
      ).run(m, projectId, repoKey, base, hub.clock.now());
      repos.ensureOwn(c, project, undefined);
    });
  } catch (error) {
    console.warn("the project's repo and base were not recorded:", error);
  }
}

/** Records the checkout as a repo of `project` (repos/mod.rs `ensure_own`); a failure is logged, never the add's. */
export function ensureOwn(hub: Hub, project: ProjectRef, path: string, what: string): void {
  try {
    hub.db.transaction((c) => repos.ensureOwn(c, project, path));
  } catch (error) {
    console.warn(`${what} was not recorded:`, error);
  }
}

export function appendAdded(hub: Hub, m: MachineId, projectId: ProjectId, summary: string, data: unknown): void {
  events(hub).append({
    at: now(hub),
    type: "project.added",
    machineId: m,
    projectId,
    summary: jsPrefix(summary, 200),
    data,
  });
}

/**
 * Registers `path` on `m` (the same directory again is the same project; a title renames it) and emits
 * `project.added` with the inspect. Returns the inspect it emitted.
 */
async function registerAt(
  hub: Hub,
  m: MachineId,
  given: string,
  title: string | undefined,
  facts: RepoFacts,
  inspect: ProjectInspect,
  addId: string | undefined,
  onlyMe: OnlyMe,
): Promise<{ projectId: ProjectId; created: boolean; inspect: ProjectInspect }> {
  const path = stripSlash(given);
  const name = lastPart(path);
  const existing = projectAt(hub, m, path);
  const created = existing === undefined;
  const projectId = existing ?? newUuid();
  const named = title ?? name;
  const project = { machineId: m, projectId };
  // An existing project's Only me first: refused, the add changes nothing, its name included.
  if (!created) onlyMe.apply(hub, project, false, facts.isGit);
  if (created || named !== name) {
    await projectUpsert(hub, m, projectId, named, path).catch((e) => {
      throw fromExecutor(e);
    });
  }
  bindScope(hub, m, projectId, facts);
  // A git checkout is the project's own repo, with a remote or without; a plain folder holds none.
  if (facts.isGit) ensureOwn(hub, project, path, "the project's own repo");
  if (created) {
    onlyMe.apply(hub, project, true, facts.isGit);
    startApprovals(hub.db.conn, project);
  }
  // The event log keeps at most 2 KB of data; a dry-run project_add has the whole inspect.
  const data = fitAdded({ ...(addId !== undefined ? { addId } : {}), title: named, path, created, inspect });
  appendAdded(hub, m, projectId, `${named} added on ${m}: ${inspect.leadNeeds}`, data);
  return { projectId, created, inspect };
}

/** `project_add` with `dryRun`: what it would add, and for a url where it would clone; nothing is added. */
function dry(m: MachineId, path: string, inspect: ProjectInspect, clone?: ProjectAddOutput["clone"]): ProjectAddOutput {
  const next = clone?.sameRemote
    ? `${clone.machineId} already has it at ${clone.path}: project_add with useExisting adds that checkout.`
    : clone
      ? `project_add clones it to ${clone.path} on ${clone.machineId}.`
      : "Add it with project_add.";
  return { next, machineId: m, path, created: false, inspect, ...(clone ? { clone } : {}) };
}

/** The contracts' `checked!` rules on ProjectAddInput, with their words. */
function checkInput(input: ProjectAddInput): void {
  const bad = (why: string) => new ToolError("invalid", why);
  if (input.create === true) {
    if (input.url !== undefined || input.dest !== undefined || input.useExisting !== undefined) {
      throw bad("create makes an empty folder: url, dest and useExisting don't go with it");
    }
    if (input.path === undefined && input.title === undefined) throw bad("give title (the new project's name), path (its folder), or both");
    return;
  }
  if (input.gitInit !== undefined) throw bad("gitInit goes with create only");
  if (input.path !== undefined && input.url !== undefined) throw bad("give path or url, not both");
  if (input.path === undefined && input.url === undefined) throw bad("give path (a directory on the machine) or url (a GitHub repository)");
  if (input.path !== undefined && (input.dest !== undefined || input.useExisting !== undefined)) throw bad("dest and useExisting go with url only");
}

/** Hears how a clone `project_add` started ends: the project it became, or why there is none. */
export type CloneEnd = { added(projectId: ProjectId, path: string): void; failed(problem: ProjectProblem): void };

export async function add(hub: Hub, caller: Caller, input: ProjectAddInput, end?: CloneEnd): Promise<ProjectAddOutput> {
  checkInput(input);
  if (input.machineId !== undefined) requireRole(caller, "operate", input.machineId);
  const m = targetMachine(hub, input.machineId);
  requireRole(caller, "operate", m);
  const trimmed = input.title?.trim();
  const title = trimmed === undefined || trimmed === "" ? undefined : trimmed;
  const dryRun = input.dryRun === true;
  const onlyMe = OnlyMe.of(hub, caller, input.onlyMe);
  if (input.create === true) return create(hub, m, input, dryRun, onlyMe);
  if (input.path !== undefined) {
    const path = stripSlash(input.path);
    const facts = await checkout(hub, m, path);
    const inspect = await inspectCheckout(hub, facts);
    if (dryRun) return dry(m, path, inspect);
    const added = await registerAt(hub, m, path, title, facts, inspect, undefined, onlyMe);
    return {
      next: `${added.inspect.leadNeeds}. Write to its lead with chat_send; the lead starts with the first message.`,
      machineId: m,
      path,
      projectId: added.projectId,
      created: added.created,
      inspect: added.inspect,
    };
  }
  const repo = repoOf(input.url as string);
  // Before cloning: does gh see it, and is the destination free?
  const github = await readGithub(hub, repo, undefined);
  const target = await cloneTarget(hub, m, repo, input.dest);
  if (dryRun) return dry(m, target.path, github, target);
  if (target.exists) {
    if (target.sameRemote && input.useExisting === true) {
      const facts = await checkout(hub, m, target.path);
      const inspect = await inspectCheckout(hub, facts);
      const added = await registerAt(hub, m, target.path, title, facts, inspect, undefined, onlyMe);
      return {
        next: added.inspect.leadNeeds,
        machineId: m,
        path: target.path,
        projectId: added.projectId,
        created: added.created,
        inspect: added.inspect,
      };
    }
    throw destTaken(m, repo, target);
  }
  const run = clones(hub).start();
  const path = target.path;
  void cloneAndRegister(hub, m, repo, path, intoProject(hub, m, title, onlyMe, end), run);
  return {
    next: `Cloning into ${path} on ${m}. Follow events_wait for project.clone_progress, then project.added or project.add_failed with data.addId ${run.addId}.`,
    machineId: m,
    path,
    created: true,
    addId: run.addId,
  };
}

const cantMake = (m: MachineId) =>
  problemError(problem("node_too_old", `${m}'s node is too old to make a new project's folder`, `Run fleetd update on ${m}, or pick another machine`));

/** Whether the node's message names the folder at `path`: as given, or `~/x` as the node expands it (`/home/me/x`). */
export function namesFolder(message: string, path: string): boolean {
  return message.includes(path) || (path.startsWith("~/") && message.includes(path.slice(1)));
}

/**
 * Why the node didn't make the folder at `path`: it holds files already, or it can't be made there. The node names the
 * folder in each of its own refusals; anything else (a dropped link, no answer) is the machine's problem.
 */
function folderRefused(m: MachineId, path: string) {
  return (e: unknown): never => {
    const message = e instanceof ExecutorError && e.kind === "node_failed" ? e.extra.nodeMessage : undefined;
    if (message?.includes(FOLDER_NOT_EMPTY)) {
      throw problemError(
        problem("dest_exists", `${path} on ${m} already holds files`, "Pick another folder for the new project, or add that one as it is by typing its path"),
      );
    }
    if (message !== undefined && namesFolder(message, path)) throw new ToolError("invalid", message, "Pick another folder for the new project");
    throw problemError(nodeProblem(m, e));
  };
}

/** `slug_or` (navi/mod.rs): a folder name from a title, at most 40 bytes, `fallback` when nothing is left. */
export function slugOr(name: string, fallback: string): string {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (out !== "" && !out.endsWith("-")) out += "-";
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/, "");
  return out === "" ? fallback : out;
}

/**
 * `project_add` with `create`: the node makes the folder (`path`, else `<projectsRoot>/<name>`), empty or new, and
 * `git init`s it when asked; then it is added as a `path` is, a plain folder with no repo unless it was.
 */
async function create(hub: Hub, m: MachineId, input: ProjectAddInput, dryRun: boolean, onlyMe: OnlyMe): Promise<ProjectAddOutput> {
  if (!link(hub).can(m, CAP_FOLDER_MAKE)) throw cantMake(m);
  const title = input.title?.trim();
  let path: string;
  if (input.path !== undefined) path = stripSlash(input.path);
  else {
    const root = (await repoScan(hub, m).catch(nodeError(m))).projectsRoot;
    if (root === undefined) throw cantMake(m);
    path = `${root.replace(/\/+$/, "")}/${slugOr(title ?? "", "project")}`;
  }
  const gitInit = input.gitInit === true;
  // Checked first, making nothing: the folder as the node names it, and whether it could be made.
  path = await folderMake(hub, m, path, false, true).catch(folderRefused(m, path));
  // An empty folder that is already a project is that project, never a new one under another name, and it is left as
  // it is: no git init.
  const id = projectAt(hub, m, path);
  if (id !== undefined) {
    const named = store(hub).projectGet({ machineId: m, projectId: id })?.title ?? id;
    throw problemError(problem("dest_exists", `${path} on ${m} is already the project ${named}`, "Open that project, or pick another folder for the new one"));
  }
  if (dryRun) return { ...dry(m, path, folder()), next: `project_add with create makes ${path} on ${m}, a new project.` };
  path = await folderMake(hub, m, path, gitInit, false).catch(folderRefused(m, path));
  const facts = await checkout(hub, m, path);
  const inspect = await inspectCheckout(hub, facts);
  const added = await registerAt(hub, m, path, title, facts, inspect, undefined, onlyMe);
  return {
    next: `${added.inspect.leadNeeds}. Write to its lead with chat_send; project_repo_add adds a repo later.`,
    machineId: m,
    path,
    projectId: added.projectId,
    created: added.created,
    inspect: added.inspect,
  };
}

/** Why a clone can't go to `target`, which already exists. */
export function destTaken(m: MachineId, repo: GitHubRepo, target: { path: string; sameRemote: boolean }): ToolError {
  return problemError(
    target.sameRemote
      ? problem(
          "dest_exists",
          `${m} already has a checkout of ${repo} at ${target.path}`,
          "Add that checkout instead (useExisting), or clone into another folder (dest)",
        )
      : problem(
          "dest_exists",
          `${target.path} already exists on ${m} and is not a checkout of ${repo}`,
          "Clone into another folder (dest), or move that one away",
        ),
  );
}

// ---- Clones.

/**
 * What a finished clone becomes (Rust `CloneInto`): a project, or a repo of one; `fix` is said when that fails.
 * `failed` hears why the clone or the add failed, after its `project.add_failed`.
 */
export type CloneInto = {
  add(path: string, facts: RepoFacts, inspect: ProjectInspect, addId: string): Promise<unknown>;
  fix: string;
  failed?(problem: ProjectProblem): void;
};

function intoProject(hub: Hub, m: MachineId, title: string | undefined, onlyMe: OnlyMe, end?: CloneEnd): (path: string) => CloneInto {
  return (path) => ({
    add: async (p, facts, inspect, addId) => {
      const added = await registerAt(hub, m, p, title, facts, inspect, addId, onlyMe);
      try {
        end?.added(added.projectId, p);
      } catch (error) {
        console.warn("a finished clone was not told on:", error);
      }
      return added;
    },
    fix: `Add the checkout at ${path} on ${m} as a project`,
    ...(end ? { failed: end.failed } : {}),
  });
}

/** A running clone: its id, and its progress frames to whoever watches them until it ends. */
export type CloneRun = { addId: string; watch(fn: (frame: CloneProgressFrame) => void): void; end(): void };

/** The clones running now, by add id; the executor hands each `clone_progress` frame here. */
export class Clones {
  private readonly watchers = new Map<string, (frame: CloneProgressFrame) => void>();

  progress(frame: CloneProgressFrame): void {
    this.watchers.get(frame.addId)?.(frame);
  }

  /** Registers a clone's progress stream; pass the run to `cloneAndRegister`. */
  start(): CloneRun {
    const addId = newUuid();
    return {
      addId,
      watch: (fn) => this.watchers.set(addId, fn),
      end: () => this.watchers.delete(addId),
    };
  }
}

export const clones = (hub: Hub) =>
  hub.area("project_clones", (h) => {
    const c = new Clones();
    executors(h).sinks.clone = (frame) => c.progress(frame);
    return c;
  });

type Last = { atMs: number; phase: CloneProgressData["phase"]; percent: number };

/** Progress events: on each phase change and its 100 %, else every 5 percent at most once a second. */
export function progressDue(last: Last | undefined, phase: CloneProgressData["phase"], percent: number, nowMs: number): boolean {
  if (!last) return true;
  return (
    last.phase !== phase ||
    (percent === 100 && last.percent !== 100) ||
    (percent >= Math.min(last.percent + 5, 255) && nowMs - last.atMs >= 1000)
  );
}

export async function cloneAndRegister(
  hub: Hub,
  m: MachineId,
  repo: GitHubRepo,
  path: string,
  into: (path: string) => CloneInto,
  run: CloneRun,
): Promise<void> {
  const addId = run.addId;
  const emit = (type: HubEventType, summary: string, data: unknown) => {
    try {
      events(hub).append({ at: now(hub), type, machineId: m, summary: jsPrefix(summary, 200), data });
    } catch (error) {
      console.warn("a clone's event was not logged:", error);
    }
  };
  const progress = (phase: CloneProgressData["phase"], percent: number | undefined, detail: string | undefined) => {
    const data: CloneProgressData = {
      addId,
      repo,
      path: cutPath(path, 500),
      phase,
      ...(percent !== undefined ? { percent } : {}),
      ...(detail !== undefined ? { detail: jsPrefix(detail, 120) } : {}),
    };
    const pct = percent !== undefined ? ` ${percent}%` : "";
    emit("project.clone_progress", `cloning ${repo} on ${m}: ${phase.replaceAll("_", " ")}${pct}`, data);
  };
  progress("starting", undefined, undefined);
  let last: Last | undefined = { atMs: Date.now(), phase: "starting", percent: 0 };
  run.watch((frame) => {
    const pct = Math.min(Math.max(Math.trunc(frame.percent ?? 0), 0), 255);
    if (progressDue(last, frame.phase, pct, Date.now())) {
      last = { atMs: Date.now(), phase: frame.phase, percent: pct };
      progress(frame.phase, frame.percent, frame.detail);
    }
  });
  const target = into(path);
  const failed = (p: ProjectProblem) => {
    emit("project.add_failed", p.message, fitFailed({ addId, repo, path, problem: p }));
    try {
      target.failed?.(p);
    } catch (error) {
      console.warn("a failed clone was not told on:", error);
    }
  };
  let facts: RepoFacts;
  try {
    facts = await repoClone(hub, m, addId, `https://github.com/${repo}`, path);
  } catch (e) {
    const message = e instanceof ExecutorError && e.kind === "node_failed" ? (e.extra.nodeMessage ?? e.message) : (e as Error).message;
    failed(cloneProblem(message, repo, m, path));
    return;
  } finally {
    run.end();
  }
  progress("inspecting", undefined, undefined);
  let inspect: ProjectInspect;
  try {
    inspect = await readGithub(hub, repo, facts);
  } catch {
    inspect = build(repo, noAnswers(), facts, [], true);
  }
  try {
    await target.add(path, facts, inspect, addId);
  } catch (e) {
    const why = e instanceof ToolError ? e.message : (e as Error).message;
    failed(problem("other", `${repo} was cloned to ${path} on ${m}, but adding it failed: ${why}`, target.fix));
  }
}

/**
 * Clones whose progress is in the event log with no `project.added` or `project.add_failed` after it: running now, or
 * cut off by a hub restart before `failInterrupted` ran.
 */
export function openClones(log: EventLog): [MachineId | undefined, CloneProgressData][] {
  const types: HubEventType[] = ["project.clone_progress", "project.added", "project.add_failed"];
  const open = new Map<string, [MachineId | undefined, CloneProgressData]>();
  for (let after = 0; ; ) {
    const page = log.page(after, types);
    for (const e of page.events) {
      const id = (e.data as { addId?: unknown } | undefined)?.addId;
      if (typeof id !== "string") continue;
      if (e.type === "project.clone_progress") {
        const d = e.data as CloneProgressData;
        if (typeof d.path === "string" && typeof d.phase === "string") open.set(id, [e.machineId, d]);
      } else open.delete(id);
    }
    if (!page.more) break;
    after = page.cursor;
  }
  // Rust keeps them in a BTreeMap by add id.
  return [...open.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/**
 * Clones a previous hub process started and never finished: their progress is in the event log but no
 * `project.added` or `project.add_failed` follows. Each gets its `project.add_failed`, so nothing reads as running
 * forever. Run once at startup, before any new clone starts.
 */
export function failInterrupted(log: EventLog, at: string): number {
  const open = openClones(log);
  for (const [machineId, d] of open) {
    const data = fitFailed({
      addId: d.addId,
      ...(d.repo !== undefined ? { repo: d.repo } : {}),
      path: d.path,
      problem: problem(
        "clone_failed",
        `the hub restarted while cloning ${d.repo ?? d.path}`,
        "Add it again; a clone that finished on the machine is offered for reuse",
      ),
    });
    log.append({ at, type: "project.add_failed", ...(machineId !== undefined ? { machineId } : {}), summary: data.message, data });
  }
  return open.length;
}
