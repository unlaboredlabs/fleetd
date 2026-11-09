// project_repo_add, project_repo_list and project_repo_remove (W79): the
// repos a project holds besides its own directory. A repo's files are a node checkout, a node "project" like any
// other, on the project's machine: adding one by path or by clone goes the way project_add does, then records the
// checkout as a repo of the project. While a project holds it, the checkout doesn't show as a project of its own; one
// that was a project with its own chat and history is archived read-only (`holder`): its lead is stopped, and refused
// every start, wake and spawn. Its tasks end when the repo is removed (the leads area's removals); nothing on disk is
// deleted.
import type {
  MachineId,
  ProjectId,
  ProjectInspect,
  ProjectRef,
  ProjectRepo,
  ProjectRepoAddInput,
  ProjectRepoAddOutput,
  ProjectRepoListOutput,
  ProjectRepoRemoveOutput,
  ProjectSummary,
  RepoName,
  Role,
  TaskId,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_PROJECT_ENV_COPY } from "../../shared/node_link.ts";
import type { RepoFacts } from "../../shared/sessions.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { newUuid } from "../executor/index.ts";
import { projectEnvCopy, projectUpsert, stop } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { leads } from "../leads/index.ts";
import { link } from "../link/index.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { TaskRecords } from "../tasks/records.ts";
import { scopeOf } from "../work/store.ts";
import { appendAdded, bindScope, type CloneInto, cloneAndRegister, clones, destTaken, ensureOwn, now } from "./add.ts";
import { checkout, cloneTarget, inspectCheckout, problem, problemError, projectAt, readGithub, repoOf, requireRepoNode } from "./discover.ts";
import { fitAdded } from "./inspect.ts";
import { repoNamed } from "./settings.ts";

const same = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
const stripSlash = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);

/**
 * The first other project holding the checkout as a repo, with that repo (repos/mod.rs `holder`): while there is one,
 * the checkout's own project is archived read-only (its chat and history stay; its lead doesn't run and takes no message).
 */
export const holder = (hub: Hub, checkout: ProjectRef) => repos.holders(hub.db.conn, checkout)[0];

/** Why an archived project refuses, and the fix (repos/mod.rs `archived_note`). */
export function archivedNote(holding: ProjectRef, repo: ProjectRepo): [string, string] {
  return [
    `This project is archived: its directory is repo ${repo.name} of project ${holding.projectId} on ${holding.machineId}.`,
    "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
  ];
}

/** Refused for a project archived as another project's repo checkout. */
function notArchived(hub: Hub, r: ProjectRef): void {
  const held = holder(hub, r);
  if (!held) return;
  const [message, fix] = archivedNote(held.project, held.repo);
  throw new ToolError("invalid", message, fix);
}

/** The project, if the caller may act on it with `role` and it isn't itself archived as another project's repo. */
function target(hub: Hub, caller: Caller, role: Role, machineId: MachineId, projectId: ProjectId): [ProjectRef, ProjectSummary] {
  requireRole(caller, role, machineId);
  const r = { machineId, projectId };
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  if (role !== "read") notArchived(hub, r);
  return [r, project];
}

/** The checkouts of the project's repos other than its own directory, on its machine: where its environment also goes. */
export function otherCheckouts(hub: Hub, r: ProjectRef): ProjectRef[] {
  return repos
    .of(hub.db.conn, r)
    .map((repo) => repo.checkout)
    .filter((c) => !same(c, r) && c.machineId === r.machineId);
}

const ownDirectory = (path: string) => new ToolError("invalid", `${path} is the project's own directory.`, "Give another checkout");

/** The contracts' `checked!` rules on ProjectRepoAddInput, with their words. */
function checkInput(input: ProjectRepoAddInput): void {
  const bad = (why: string) => new ToolError("invalid", why);
  if (input.path !== undefined && input.url !== undefined) throw bad("give path or url, not both");
  if (input.path === undefined && input.url === undefined) throw bad("give path (a checkout on the project's machine) or url (a GitHub repository)");
  if (input.path !== undefined && (input.dest !== undefined || input.useExisting !== undefined)) throw bad("dest and useExisting go with url only");
}

/** The directory at `path`, which must be a git checkout to be a repo. */
async function gitCheckout(hub: Hub, m: MachineId, path: string): Promise<RepoFacts> {
  const facts = await checkout(hub, m, path);
  if (!facts.isGit) {
    throw problemError(
      problem("not_a_git_repo", `${path} on ${m} is not a git repository`, "Give the repository's root directory, or run `git init` there first"),
    );
  }
  return facts;
}

async function add(hub: Hub, caller: Caller, input: ProjectRepoAddInput): Promise<ProjectRepoAddOutput> {
  checkInput(input);
  const [r] = target(hub, caller, "operate", input.machineId, input.projectId);
  const m = r.machineId;
  if (input.name !== undefined && repos.byName(hub.db.conn, r, input.name)) {
    throw new ToolError(
      "invalid",
      `The project already has a repo named ${input.name}.`,
      "Give another name, or leave it out for one made from the repo's",
    );
  }
  requireRepoNode(hub, m);
  if (input.path !== undefined) {
    const path = stripSlash(input.path);
    if (projectAt(hub, m, path) === r.projectId) throw ownDirectory(path);
    const facts = await gitCheckout(hub, m, path);
    const inspect = await inspectCheckout(hub, facts);
    const [repo, archived] = await attachCheckout(hub, r, input.name, path, facts, inspect, undefined);
    return added(m, repo, archived);
  }
  const repo = repoOf(input.url as string);
  // Before cloning: does gh see it, and is the destination free?
  await readGithub(hub, repo, undefined);
  const t = await cloneTarget(hub, m, repo, input.dest);
  if (t.exists) {
    if (t.sameRemote && input.useExisting === true) {
      const facts = await gitCheckout(hub, m, t.path);
      const inspect = await inspectCheckout(hub, facts);
      const [got, archived] = await attachCheckout(hub, r, input.name, t.path, facts, inspect, undefined);
      return added(m, got, archived);
    }
    throw destTaken(m, repo, t);
  }
  const run = clones(hub).start();
  const path = t.path;
  const into = (p: string): CloneInto => ({
    add: (at, facts, inspect, addId) => attachCheckout(hub, r, input.name, at, facts, inspect, addId),
    fix: `Add the checkout at ${p} on ${m} with project_repo_add`,
  });
  void cloneAndRegister(hub, m, repo, path, into, run);
  return {
    path,
    addId: run.addId,
    next: `Cloning into ${path} on ${m}. Follow events_wait for project.clone_progress, then project.added or project.add_failed with data.addId ${run.addId}.`,
  };
}

function added(m: MachineId, repo: ProjectRepo, archived: ProjectRef | undefined): ProjectRepoAddOutput {
  const path = repo.path ?? "";
  let next = `${repo.name} is a repo of the project now, at ${path} on ${m}.`;
  if (archived) next += ` The project ${archived.projectId} it was is archived: its chat and history stay, its lead no longer runs.`;
  return { path, repo, ...(archived ? { archived } : {}), next };
}

/**
 * Records the checkout at `path` on the project's machine as a repo of the project: registered on the node when it
 * isn't a project yet, else archived when it is one of its own. The project's environment is copied to it, and
 * `project.added` (the project's) says so. Returns the repo, and the project archived.
 */
export async function attachCheckout(
  hub: Hub,
  r: ProjectRef,
  name: RepoName | undefined,
  given: string,
  facts: RepoFacts,
  inspect: ProjectInspect,
  addId: string | undefined,
): Promise<[ProjectRepo, ProjectRef | undefined]> {
  const m = r.machineId;
  // Again, for a clone that ends after the project was removed or archived.
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  notArchived(hub, r);
  const path = stripSlash(given);
  const existing = projectAt(hub, m, path);
  const created = existing === undefined;
  let archived: ProjectRef | undefined;
  let checkout: ProjectRef;
  if (existing === r.projectId) throw ownDirectory(path);
  if (existing !== undefined) {
    checkout = { machineId: m, projectId: existing };
    const mine = repos.of(hub.db.conn, r).find((repo) => same(repo.checkout, checkout));
    if (mine) throw new ToolError("invalid", `${path} is already the project's repo ${mine.name}.`, "project_repo_list shows its repos");
    if (repos.of(hub.db.conn, checkout).some((repo) => !same(repo.checkout, checkout))) {
      throw new ToolError(
        "invalid",
        `${path} is a project that holds repos of its own.`,
        "Remove its other repos first (project_repo_remove), or add those repos to this project instead",
      );
    }
    // A project of its own until now (no project held it yet): it is archived, once nothing runs in it.
    if (repos.holders(hub.db.conn, checkout).length === 0) {
      if (TaskRecords.live(hub.db.conn, checkout, 1).length > 0) {
        throw new ToolError(
          "invalid",
          `${path} is the project ${checkout.projectId} and its agents still run.`,
          "Stop them first (project_stop, or the chat's Stop), then add it",
        );
      }
      archived = checkout;
    }
  } else {
    const id = newUuid();
    await projectUpsert(hub, m, id, path.split("/").pop() ?? path, path).catch((e) => {
      throw fromExecutor(e);
    });
    checkout = { machineId: m, projectId: id };
  }
  bindScope(hub, m, checkout.projectId, facts);
  ensureOwn(hub, checkout, path, "the checkout's own repo");
  const repo = hub.db.transaction((c) => {
    // Named as asked, else from its remote or folder, made unique in the project.
    const named = name ?? repos.freeName(c, r, repos.nameFor(scopeOf(c, checkout)?.repoKey ?? path));
    return repos.attach(c, r, named, checkout);
  });
  repo.path ??= path;
  // Archived from here: its lead is refused every start and wake, and the session it has now is stopped.
  const lead = archived ? leads(hub).records.leadGet(archived) : undefined;
  if (lead) {
    await stop(hub, { machineId: m, threadId: lead.threadId }, false).catch((error) =>
      console.warn("the archived project's lead was not stopped:", error),
    );
  }
  if (link(hub).can(m, CAP_PROJECT_ENV_COPY)) {
    await projectEnvCopy(hub, m, r.projectId, checkout.projectId).catch((error) =>
      console.warn("the project's environment was not copied to its new repo:", error),
    );
  }
  const title = store(hub).projectGet(r)?.title ?? r.projectId;
  const data = fitAdded({ ...(addId !== undefined ? { addId } : {}), title, path, created, inspect });
  appendAdded(hub, m, r.projectId, `${repo.name} added to ${title} on ${m}: ${inspect.leadNeeds}`, data);
  return [repo, archived];
}

function list(hub: Hub, caller: Caller, input: { machineId: MachineId; projectId: ProjectId }): ProjectRepoListOutput {
  const [r] = target(hub, caller, "read", input.machineId, input.projectId);
  const got = repos.of(hub.db.conn, r);
  const next =
    got.length === 0
      ? "A plain folder: project_repo_add adds a repo by path or GitHub URL."
      : "project_repo_add adds another; project_repo_remove takes one out.";
  return { repos: got, next };
}

/**
 * The leads area's removals, `hub.area("lead_removals")` (Rust's `leads.removals`), made at the leads area's start:
 * `endRemovedRepos` cancels the live tasks whose repo is gone and names them. Until it is made, a removal cancels none
 * here, and the tasks end at their next start.
 */
type Removals = { reconcile(r: ProjectRef): Promise<void>; endRemovedRepos(): Promise<string[]> };

async function remove(hub: Hub, caller: Caller, input: { machineId: MachineId; projectId: ProjectId; name: RepoName }): Promise<ProjectRepoRemoveOutput> {
  const [r] = target(hub, caller, "operate", input.machineId, input.projectId);
  const repo = repoNamed(hub, r, input.name) as ProjectRepo;
  if (same(repo.checkout, r)) {
    throw new ToolError("invalid", `${repo.name} is the project's own directory.`, "project_remove removes the project itself");
  }
  repos.detach(hub.db.conn, r, repo.name);
  // Keyed on `repos`: a stop before this ends them at the next start.
  const cancelled: TaskId[] = (await hub.peek<Removals>("lead_removals")?.endRemovedRepos()) ?? [];
  // Every client lists the project's repos and its projects again.
  events(hub).append({
    at: now(hub),
    type: "project.settings",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `${repo.name} removed from the project`,
    data: { repoRemoved: repo.name },
  });
  const path = repo.path ?? repo.checkout.projectId;
  let next = `Its checkout stays at ${path} on ${repo.checkout.machineId}, files and all.`;
  if (repos.holders(hub.db.conn, repo.checkout).length === 0) {
    next += " No project holds it now, so it shows as a project of its own again; project_remove forgets it (its files stay).";
  }
  return { removed: repo, cancelled, next };
}

export function register(tools: Registry): void {
  tools.add("project_repo_add", (hub, caller, input) => add(hub, caller, input));
  tools.add("project_repo_list", (hub, caller, input) => list(hub, caller, input));
  tools.add("project_repo_remove", (hub, caller, input) => remove(hub, caller, input));
}
