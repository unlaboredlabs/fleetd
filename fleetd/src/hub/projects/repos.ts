// project_repo_add, project_repo_list and project_repo_remove (W79): the
// repos a project holds besides its own directory. A repo's files are a node checkout, a node "project" like any
// other, on the project's machine: adding one by path or by clone goes the way project_add does, then records the
// checkout as a repo of the project. While a project holds it, the checkout doesn't show as a project of its own. A
// folder that is another bot's is never taken (W845): its repo is cloned as a separate copy beside it. A project held
// as another's repo before then stays archived read-only (`holder`): its lead refused every start, wake and spawn. Its
// tasks end when the repo is removed (the leads area's removals); nothing on disk is deleted.
import type {
  CloneTarget,
  GitHubRepo,
  MachineId,
  ProjectId,
  ProjectInspect,
  ProjectProblem,
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
import { SAME_REPO_THERE } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_PROJECT_ENV_COPY } from "../../shared/node_link.ts";
import type { RepoFacts } from "../../shared/sessions.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { newUuid } from "../executor/index.ts";
import { projectEnvCopy, projectUpsert } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/index.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { scopeOf } from "../work/store.ts";
import { appendAdded, bindScope, type CloneInto, cloneAndRegister, clones, destTaken, ensureOwn, now } from "./add.ts";
import { checkout, cloneTarget, inspectCheckout, problem, problemError, projectAt, readGithub, repoOf, requireRepoNode } from "./discover.ts";
import { fitAdded, githubRepo } from "./inspect.ts";
import { adoptSharedMode, repoNamed } from "./settings.ts";
import { archivedNote } from "./adding.ts";

export { archivedNote } from "./adding.ts";

const same = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
const stripSlash = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);

/**
 * The first other project holding the checkout as a repo, with that repo (repos/mod.rs `holder`): while there is one,
 * the checkout's own project is archived read-only (its chat and history stay; its lead doesn't run and takes no message).
 */
export const holder = (hub: Hub, checkout: ProjectRef) => repos.holders(hub.db.conn, checkout)[0];


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
  return known(hub, { machineId, projectId }, role !== "read");
}

/** The project `r`; to change it, it must not be archived as another project's repo. */
function known(hub: Hub, r: ProjectRef, change: boolean): [ProjectRef, ProjectSummary] {
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  if (change) notArchived(hub, r);
  return [r, project];
}

/** The checkouts of the project's repos other than its own directory, on its machine: where its environment also goes. */
export function otherCheckouts(hub: Hub, r: ProjectRef): ProjectRef[] {
  return repos
    .of(hub.db.conn, r)
    .map((repo) => repo.checkout)
    .filter((c) => !same(c, r) && c.machineId === r.machineId);
}

const ownDirectory = (path: string) => new ToolError("invalid", `${path} is the bot's own directory.`, "Give another checkout");

/** The contracts' `checked!` rules on ProjectRepoAddInput, with their words. */
function checkInput(input: ProjectRepoAddInput): void {
  const bad = (why: string) => new ToolError("invalid", why);
  if (input.path !== undefined && input.url !== undefined) throw bad("give path or url, not both");
  if (input.path === undefined && input.url === undefined) throw bad("give path (a checkout on the bot's machine) or url (a GitHub repository)");
  if (input.path !== undefined && (input.dest !== undefined || input.useExisting !== undefined || input.copy !== undefined)) {
    throw bad("dest, useExisting and copy go with url only");
  }
  if (input.useExisting === true && input.copy === true) throw bad("give useExisting or copy, not both");
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

/** What a lead's `repo_add` adds to the add (projects/calls.ts): a clone's end reaches `cloned` or `cloneFailed`. */
export type AddHooks = {
  /**
   * An Undo of the bot's own repo removal (projects/calls.ts): the checkout it held, which no bot has held since, is
   * taken back as it is, though it shows as a bot of its own since the removal.
   */
  takeBack?: boolean;
  cloned?(repo: ProjectRepo): void;
  cloneFailed?(problem: ProjectProblem): void;
};

function add(hub: Hub, caller: Caller, input: ProjectRepoAddInput): Promise<ProjectRepoAddOutput> {
  checkInput(input);
  requireRole(caller, "operate", input.machineId);
  return addTo(hub, input, {});
}

/**
 * `project_repo_add` once its caller may: the checkout attached, or its clone started. Adding a repo never touches
 * another bot: a folder that is another bot's, or a repo some bot holds, is never shared or archived; its repo is
 * cloned as a separate copy into a free folder beside it.
 */
export async function addTo(hub: Hub, input: ProjectRepoAddInput, hooks: AddHooks): Promise<ProjectRepoAddOutput> {
  checkInput(input);
  const [r] = known(hub, { machineId: input.machineId, projectId: input.projectId }, true);
  const m = r.machineId;
  if (input.name !== undefined && repos.byName(hub.db.conn, r, input.name)) {
    throw new ToolError(
      "invalid",
      `The bot already has a repo named ${input.name}.`,
      "Give another name, or leave it out for one made from the repo's",
    );
  }
  requireRepoNode(hub, m);
  if (input.path !== undefined) {
    const path = stripSlash(input.path);
    const at = projectAt(hub, m, path);
    if (at === r.projectId) throw ownDirectory(path);
    const facts = await gitCheckout(hub, m, path);
    const mine = repos.of(hub.db.conn, r).find((repo) => at !== undefined && same(repo.checkout, { machineId: m, projectId: at }));
    if (mine) throw new ToolError("invalid", `${path} is already the bot's repo ${mine.name}.`);
    if (at === undefined || free(hub, { machineId: m, projectId: at }, hooks.takeBack === true)) {
      const inspect = await inspectCheckout(hub, facts);
      return added(m, await attachCheckout(hub, r, input.name, path, facts, inspect, undefined, hooks.takeBack === true));
    }
    // Another bot's folder: a separate copy of its repo, cloned beside it.
    const repo = facts.remote !== undefined ? githubRepo(facts.remote) : undefined;
    if (repo === undefined) {
      throw new ToolError(
        "invalid",
        `${path} is the bot ${whose(hub, { machineId: m, projectId: at })}'s folder, and its repo isn't on GitHub to copy.`,
        "Copy that folder yourself and add the copy, or add the repo to that bot instead",
      );
    }
    alreadyHas(hub, r, repo);
    await readGithub(hub, repo, undefined);
    const t = await cloneTarget(hub, m, repo, path);
    return startClone(hub, r, input.name, repo, await freeFolder(hub, m, repo, path), t, hooks);
  }
  const repo = repoOf(input.url as string);
  alreadyHas(hub, r, repo);
  // Before cloning: does gh see it, and is the destination free?
  await readGithub(hub, repo, undefined);
  const t = await cloneTarget(hub, m, repo, input.dest);
  if (!t.exists) return startClone(hub, r, input.name, repo, t, undefined, hooks);
  // A folder no bot uses, holding this repo: it is used as it is, or copied, as asked. A bot's folder is never
  // shared with another bot (its sessions would take this bot's environment): it is copied.
  const unused = t.sameRemote && (t.projectId === undefined || free(hub, { machineId: m, projectId: t.projectId }, false));
  if (unused && input.useExisting === true) {
    const facts = await gitCheckout(hub, m, t.path);
    const inspect = await inspectCheckout(hub, facts);
    return added(m, await attachCheckout(hub, r, input.name, t.path, facts, inspect, undefined));
  }
  if (unused && input.copy !== true) throw sameRepoThere(m, repo, t.path);
  if (input.dest !== undefined && input.copy !== true) throw t.projectId === undefined ? destTaken(m, repo, t) : botsFolder(hub, m, t.path, t.projectId);
  return startClone(hub, r, input.name, repo, await freeFolder(hub, m, repo, t.path), t, hooks);
}

/** Whether the checkout may be added as it is: no live bot's (`repos.inUse`), or one an Undo takes back that no bot holds. */
const free = (hub: Hub, checkout: ProjectRef, takeBack: boolean) =>
  takeBack ? repos.holders(hub.db.conn, checkout).length === 0 : !repos.inUse(hub.db.conn, checkout);

/** Refused when the bot already has the GitHub repo `repo`, before anything is cloned. */
function alreadyHas(hub: Hub, r: ProjectRef, repo: GitHubRepo): void {
  const had = repos.of(hub.db.conn, r).find((x) => x.repoKey?.toLowerCase() === `github.com/${repo}`.toLowerCase());
  if (had) throw new ToolError("invalid", `The bot already has ${repo}: its repo ${had.name}.`);
}

/**
 * Starts cloning `repo` into `t` as a repo of the project. `beside`: the taken folder a separate copy goes next to, said
 * in the answer (`separateFrom`).
 */
function startClone(
  hub: Hub,
  r: ProjectRef,
  name: RepoName | undefined,
  repo: GitHubRepo,
  t: CloneTarget,
  beside: CloneTarget | undefined,
  hooks: AddHooks,
): ProjectRepoAddOutput {
  const m = r.machineId;
  const run = clones(hub).start();
  const path = t.path;
  const into = (p: string): CloneInto => ({
    add: async (at, facts, inspect, addId) => {
      const got = await attachCheckout(hub, r, name, at, facts, inspect, addId);
      hooks.cloned?.(got);
    },
    fix: `Add the folder ${p} on ${m} as a repo again: the copy there is added as it is`,
    ...(hooks.cloneFailed ? { failed: hooks.cloneFailed } : {}),
  });
  void cloneAndRegister(hub, m, repo, path, into, run);
  const owner = beside?.projectId !== undefined ? whose(hub, { machineId: m, projectId: beside.projectId }) : undefined;
  const why = beside === undefined ? "" : owner !== undefined ? `${beside.path} is the bot ${owner}'s, so this is a separate copy. ` : `${beside.path} is taken, so this is a separate copy. `;
  return {
    path,
    addId: run.addId,
    ...(beside !== undefined ? { separateFrom: beside.path } : {}),
    next: `${why}Cloning into ${path} on ${m}. Follow events_wait for project.clone_progress, then project.added or project.add_failed with data.addId ${run.addId}.`,
  };
}

/** How many folders next to a taken one a separate copy tries: `<path>-2` up to `<path>-<COPIES_MAX>`. */
const COPIES_MAX = 20;

/** The first folder next to `taken` that is free for a separate copy: `<taken>-2`, `<taken>-3`… */
async function freeFolder(hub: Hub, m: MachineId, repo: GitHubRepo, taken: string): Promise<CloneTarget> {
  for (let n = 2; n <= COPIES_MAX; n++) {
    const t = await cloneTarget(hub, m, repo, `${taken}-${n}`);
    if (!t.exists && t.projectId === undefined) return t;
  }
  throw problemError(problem("dest_exists", `${taken}-2 to ${taken}-${COPIES_MAX} on ${m} are all taken`, "Move some of those folders away, then add it again"));
}

/** The title of the bot whose folder the checkout is: the bot holding it as a repo, else its own. */
function whose(hub: Hub, checkout: ProjectRef): string {
  const bot = holder(hub, checkout)?.project ?? checkout;
  return store(hub).projectGet(bot)?.title ?? bot.projectId;
}

/** A clone's `dest` is a bot's folder, which is never shared with another bot. */
function botsFolder(hub: Hub, m: MachineId, path: string, projectId: ProjectId): ToolError {
  return problemError(
    problem("dest_exists", `${path} on ${m} is the bot ${whose(hub, { machineId: m, projectId })}'s folder`, "Pick another folder, or leave it out for a separate copy beside it"),
  );
}

/** A folder no bot uses already holds the repo: the person picks between using it and a separate copy. */
function sameRepoThere(m: MachineId, repo: GitHubRepo, path: string): ToolError {
  return new ToolError(
    "invalid",
    `${m} already has a copy of ${repo} at ${path}`,
    "Add that copy as it is (useExisting), or make a separate one in a free folder next to it (copy)",
    SAME_REPO_THERE,
    "Use the same copy, or make a separate one",
  );
}

function added(m: MachineId, repo: ProjectRepo): ProjectRepoAddOutput {
  const path = repo.path ?? "";
  return { path, repo, next: `${repo.name} is a repo of the bot now, at ${path} on ${m}.` };
}

/**
 * Records the checkout at `path` on the project's machine, a folder no live bot uses (`free`), as a repo of the
 * project: registered on the node when it isn't a project yet, the project's environment copied to it, and
 * `project.added` (the project's) saying so.
 */
export async function attachCheckout(
  hub: Hub,
  r: ProjectRef,
  name: RepoName | undefined,
  given: string,
  facts: RepoFacts,
  inspect: ProjectInspect,
  addId: string | undefined,
  takeBack = false,
): Promise<ProjectRepo> {
  const m = r.machineId;
  // Again, for a clone that ends after the project was removed or archived.
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  notArchived(hub, r);
  const path = stripSlash(given);
  const there = projectAt(hub, m, path);
  if (there === r.projectId) throw ownDirectory(path);
  let checkout: ProjectRef;
  if (there !== undefined) {
    checkout = { machineId: m, projectId: there };
    const mine = repos.of(hub.db.conn, r).find((repo) => same(repo.checkout, checkout));
    if (mine) throw new ToolError("invalid", `${path} is already the bot's repo ${mine.name}.`);
    // A bot came to that folder meanwhile: it stays that bot's.
    if (!free(hub, checkout, takeBack)) throw new ToolError("invalid", `${path} is the bot ${whose(hub, checkout)}'s folder now.`, "Add the repo again for a separate copy");
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
  if (link(hub).can(m, CAP_PROJECT_ENV_COPY)) {
    await projectEnvCopy(hub, m, r.projectId, checkout.projectId).catch((error) =>
      console.warn("the project's environment was not copied to its new repo:", error),
    );
  }
  // A repo other bots share brings its train's merge mode with it.
  try {
    adoptSharedMode(hub, r);
  } catch (error) {
    console.warn("the shared repo's merge mode was not taken:", error);
  }
  const title = store(hub).projectGet(r)?.title ?? r.projectId;
  const data = fitAdded({ ...(addId !== undefined ? { addId } : {}), title, path, created: there === undefined, inspect });
  appendAdded(hub, m, r.projectId, `${repo.name} added to ${title} on ${m}: ${inspect.leadNeeds}`, data);
  return repo;
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

function remove(hub: Hub, caller: Caller, input: { machineId: MachineId; projectId: ProjectId; name: RepoName }): Promise<ProjectRepoRemoveOutput> {
  requireRole(caller, "operate", input.machineId);
  return removeFrom(hub, { machineId: input.machineId, projectId: input.projectId }, input.name);
}

/** `project_repo_remove` once its caller may: the repo out of the project, its tasks ended. */
export async function removeFrom(hub: Hub, project: ProjectRef, name: RepoName): Promise<ProjectRepoRemoveOutput> {
  const [r] = known(hub, project, true);
  const repo = repoNamed(hub, r, name) as ProjectRepo;
  if (same(repo.checkout, r)) {
    throw new ToolError("invalid", `${repo.name} is the bot's own directory.`, "project_remove removes the bot itself");
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
    summary: `${repo.name} removed from the bot`,
    data: { repoRemoved: repo.name },
  });
  const path = repo.path ?? repo.checkout.projectId;
  let next = `Its checkout stays at ${path} on ${repo.checkout.machineId}, files and all.`;
  if (repos.holders(hub.db.conn, repo.checkout).length === 0) {
    next += " No bot holds it now, so it shows as a bot of its own again; project_remove forgets it (its files stay).";
  }
  return { removed: repo, cancelled, next };
}

export function register(tools: Registry): void {
  tools.add("project_repo_add", (hub, caller, input) => add(hub, caller, input));
  tools.add("project_repo_list", (hub, caller, input) => list(hub, caller, input));
  tools.add("project_repo_remove", (hub, caller, input) => remove(hub, caller, input));
}
