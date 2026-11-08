// What adding a project reads before it adds anything (crates/fleetd/src/hub/projects/mod.rs): the node calls behind
// it (executor/repos.rs: scan a machine for checkouts, look at a path, make a folder, clone, `gh repo list` there),
// GitHub's view of a repository through the hub's gh, the machine a clone goes to, and project_discover. The node does
// the filesystem and git work on its machine; gh runs on the hub machine, and `gh repo list` falls back to the target
// worker when the hub has no gh login.
import type {
  CloneTarget,
  GitHubCandidate,
  GitHubRepo,
  GitHubRepos,
  MachineId,
  MachineRepos,
  ProjectDiscoverInput,
  ProjectDiscoverOutput,
  ProjectId,
  ProjectInspect,
  ProjectProblem,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_REPOS } from "../../shared/node_link.ts";
import type { GhRepo, GhRepos, RepoFacts, ScannedRepo, SessionCall } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import { ghRepoList } from "../../node/actions/clone.ts";
import type { Hub } from "../api/hub.ts";
import { unknownMachine } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { ExecutorError, executors, type NodeOperation } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { systemGh } from "../train/gh.ts";
import { GhError, TrainGitHub } from "../train/github.ts";
import {
  bestWorker as best,
  build,
  folder,
  type GitHubAnswers,
  githubRepo,
  isGitHubRepo,
  noAnswers,
  repoGate,
  shortRemote,
  type Worker,
} from "./inspect.ts";

/** A scan reads at most a few hundred directories; an older node never answers the call at all. */
export const SCAN_TIMEOUT_MS = 10_000;
/** gh lists the user's repos and each org's, one call per owner. */
export const GH_TIMEOUT_MS = 120_000;
/** A large repository over a slow link. */
export const CLONE_TIMEOUT_MS = 60 * 60_000;

/**
 * Where gh runs for adding a project: on the hub machine. An inspection is not a train read, so it feeds no status
 * source. Tests set their own before the first call.
 */
export type AddingGh = { github: () => TrainGitHub; repoList: () => Promise<GhRepos> };

const noFresh = { expect() {}, forget() {}, touch() {}, fail() {} };

export const addingGh = (hub: Hub) =>
  hub.area<AddingGh>("project_adding_gh", () => ({
    github: () => new TrainGitHub(systemGh, noFresh, Date.now, Bun.sleep),
    repoList: ghRepoList,
  }));

export const problem = (code: ProjectProblem["code"], message: string, fix: string): ProjectProblem => ({ code, message, fix });

export function problemError(p: ProjectProblem): ToolError {
  const code =
    p.code === "machine_offline"
      ? "machine_offline"
      : p.code === "gh_no_access" || p.code === "path_missing"
        ? "not_found"
        : p.code === "no_worker" || p.code === "not_a_git_repo" || p.code === "dest_exists"
          ? "invalid"
          : "failed";
  return new ToolError(code, p.message, p.fix ?? "");
}

/** Whether `m`'s node can take the repo calls now. An older node drops its link on a call it can't decode, so it is never sent one. */
export const repoNode = (hub: Hub, m: MachineId): ProjectProblem | undefined =>
  repoGate(m, executors(hub).isConnected(m), link(hub).can(m, CAP_REPOS));

/** Throws the problem `repoNode` names. */
export function requireRepoNode(hub: Hub, m: MachineId): void {
  const p = repoNode(hub, m);
  if (p) throw problemError(p);
}

export function nodeProblem(m: MachineId, e: unknown): ProjectProblem {
  if (e instanceof ExecutorError && e.kind === "not_connected") {
    return problem("machine_offline", `${m} is offline`, `Start the node on ${m} (fleetd node run) or check its network, then retry`);
  }
  // An older node can't decode the call and never answers it.
  if (e instanceof ExecutorError && e.kind === "node_failed" && e.extra.nodeMessage?.startsWith("no answer within")) {
    return problem("node_too_old", `${m}'s node did not answer: it may predate adding projects`, `Run fleetd update on ${m}`);
  }
  return problem("other", e instanceof Error ? e.message : String(e), `fleetd doctor shows what is wrong on ${m}`);
}

/** Throws `nodeProblem`'s error for a failed node call. */
export const nodeError = (m: MachineId) => (e: unknown): never => {
  throw problemError(nodeProblem(m, e));
};

// ---- The node calls (executor/repos.rs).

function nonEmpty(m: MachineId, op: NodeOperation, what: string, value: string): string {
  if (value === "") throw ExecutorError.failed(m, op, `the ${what} is empty`);
  return value;
}

/** A machine's `repo_scan`: its checkouts, where a clone goes and where a new project's folder goes. */
export type RepoScan = { cloneRoot: string; projectsRoot?: string; repos: ScannedRepo[] };

export async function repoScan(hub: Hub, m: MachineId): Promise<RepoScan> {
  const out = await executors(hub).call(m, "read", { op: "repo_scan" }, SCAN_TIMEOUT_MS);
  if (out.kind !== "repos") throw ExecutorError.failed(m, "read", "the node sent no repo list");
  return { cloneRoot: out.cloneRoot, ...(out.projectsRoot !== undefined ? { projectsRoot: out.projectsRoot } : {}), repos: out.repos };
}

/** Makes a new project's folder at `path` (absolute, or `~/x`): its absolute path. Only to a node listing CAP_FOLDER_MAKE. */
export async function folderMake(hub: Hub, m: MachineId, path: string, gitInit: boolean, dryRun: boolean): Promise<string> {
  const call: SessionCall = { op: "folder_make", path: nonEmpty(m, "project", "path", path), gitInit, dryRun };
  const out = await executors(hub).call(m, "project", call, SCAN_TIMEOUT_MS);
  if (out.kind !== "folder") throw ExecutorError.failed(m, "project", "the node did not say where the folder is");
  return out.path;
}

export async function repoInspect(hub: Hub, m: MachineId, path: string): Promise<RepoFacts> {
  const out = await executors(hub).call(m, "read", { op: "repo_inspect", path: nonEmpty(m, "read", "path", path) }, SCAN_TIMEOUT_MS);
  if (out.kind !== "repo_facts") throw ExecutorError.failed(m, "read", "the node sent no repo facts");
  const { kind: _kind, ...facts } = out;
  return facts;
}

export async function ghRepoListOn(hub: Hub, m: MachineId): Promise<GhRepos> {
  const out = await executors(hub).call(m, "read", { op: "gh_repo_list" }, GH_TIMEOUT_MS);
  if (out.kind !== "gh_repos") throw ExecutorError.failed(m, "read", "the node sent no gh repo list");
  const { kind: _kind, ...repos } = out;
  return repos;
}

/** Clones on the node; its progress frames go to the run's watcher (`clones`) until this returns. */
export async function repoClone(hub: Hub, m: MachineId, addId: string, url: string, dest: string): Promise<RepoFacts> {
  const call: SessionCall = {
    op: "repo_clone",
    addId: nonEmpty(m, "project", "add id", addId),
    url: nonEmpty(m, "project", "url", url),
    dest: nonEmpty(m, "project", "destination", dest),
  };
  const out = await executors(hub).call(m, "project", call, CLONE_TIMEOUT_MS);
  if (out.kind !== "repo_facts") throw ExecutorError.failed(m, "project", "the node sent no repo facts");
  const { kind: _kind, ...facts } = out;
  return facts;
}

/** The node project whose directory is `workspaceRoot` on `m`, as the hub has the machine's projects cached. */
export function projectAt(hub: Hub, m: MachineId, workspaceRoot: string): ProjectId | undefined {
  return store(hub)
    .projectsList(m)
    .find((p) => p.workspaceRoot === workspaceRoot)?.projectId;
}

// ---- The machine a project goes to.

/** Every machine as a clone target, for `bestWorker`. */
function workers(hub: Hub): Worker[] {
  const ex = executors(hub);
  const running = ex.running();
  return store(hub)
    .machinesList()
    .map((m) => {
      const id = m.machineId;
      const load = link(hub).load(id);
      return {
        machineId: id,
        connected: ex.isConnected(id) && m.status !== "offline",
        capable: link(hub).can(id, CAP_REPOS),
        ready: ex.isReady(id),
        running: running.filter((r) => r.thread.machineId === id).length,
        ...(load ? { load: load.load1 / Math.max(load.cpus, 1) } : {}),
      };
    });
}

export const bestWorker = (hub: Hub): MachineId | undefined => best(workers(hub));

export function targetMachine(hub: Hub, given: MachineId | undefined): MachineId {
  const m = given ?? bestWorker(hub);
  if (m === undefined) {
    throw problemError(
      problem("no_worker", "no machine is online to add the project on", "Start a node (fleetd node run on the machine) or pass a machine id"),
    );
  }
  const machine = store(hub).machineGet(m);
  if (!machine) throw unknownMachine(m);
  if (machine.agentsMac === true) {
    throw new ToolError(
      "invalid",
      `${m} is the agents' Mac: a tool for every project's agents, where no project lives`,
      "Add the project on another machine; its agents use the Mac with `mac run` and `mac sim`",
    );
  }
  requireRepoNode(hub, m);
  return m;
}

export function repoOf(text: string): GitHubRepo {
  const repo = githubRepo(text);
  if (repo === undefined) {
    throw new ToolError(
      "invalid",
      `${text} is not a GitHub repository`,
      "Give https://github.com/owner/repo, git@github.com:owner/repo.git or owner/repo",
    );
  }
  return repo;
}

const remoteRepo = (facts: RepoFacts) => (facts.remote !== undefined ? githubRepo(facts.remote) : undefined);

// ---- GitHub's view, and a checkout's.

/** GitHub's view of `repo` through the hub's gh. Throws only when gh is logged in but cannot see the repository. */
export async function readGithub(hub: Hub, repo: GitHubRepo, local: RepoFacts | undefined): Promise<ProjectInspect> {
  const gh = addingGh(hub).github();
  const r = repo;
  const answers: GitHubAnswers = noAnswers();
  const notes: string[] = [];
  let ghOk = true;
  try {
    const got = await gh.get(`repos/${r}`);
    if (got.ok) answers.repo = got.value;
    else if (got.status === 404) {
      throw problemError(
        problem(
          "gh_no_access",
          `gh on the hub can't see ${r}: it is private to another account, renamed, or misspelled`,
          `Check the name; or run \`gh auth login\` on the hub machine with an account that can read ${r}`,
        ),
      );
    } else answers.unread.push(`${r} (HTTP ${got.status}: ${got.message})`);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    if (e.kind === "failed" || e.kind === "unavailable") answers.unread.push(`${r} (${e.message})`);
    else {
      ghOk = false;
      notes.push(e.message);
    }
  }
  if (answers.repo !== undefined) {
    const v = answers.repo as { default_branch?: unknown } | null;
    const branch = typeof v?.default_branch === "string" ? v.default_branch : "main";
    const read = async (path: string): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> => {
      try {
        const got = await gh.get(path);
        return got.ok ? got : { ok: false, why: `HTTP ${got.status}: ${got.message}` };
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
        return { ok: false, why: e.message };
      }
    };
    const [b, rules, sets, wf] = await Promise.all([
      read(`repos/${r}/branches/${branch}`),
      read(`repos/${r}/rules/branches/${branch}`),
      read(`repos/${r}/rulesets`),
      read(`repos/${r}/actions/workflows`),
    ]);
    const take = (what: string, got: { ok: true; value: unknown } | { ok: false; why: string }) => {
      if (got.ok) return got.value;
      answers.unread.push(`${what} (${got.why})`);
      return undefined;
    };
    answers.branch = take("branch protection", b);
    answers.rules = take("branch rules", rules);
    answers.workflows = take("workflows", wf);
    // Without ruleset names the rules still apply; they show as "ruleset <id>".
    if (sets.ok) answers.rulesets = sets.value;
  }
  return build(repo, answers, local, notes, ghOk);
}

/** A checkout's inspect: GitHub's view when its remote is on GitHub, else what the checkout itself shows; a plain folder's says so. */
export async function inspectCheckout(hub: Hub, facts: RepoFacts): Promise<ProjectInspect> {
  if (!facts.isGit) return folder();
  const repo = remoteRepo(facts);
  return repo !== undefined ? readGithub(hub, repo, facts) : build(undefined, noAnswers(), facts, [], true);
}

/** The directory at `path` on `m` (a git checkout, or a plain folder), or why it can't be a project. */
export async function checkout(hub: Hub, m: MachineId, path: string): Promise<RepoFacts> {
  requireRepoNode(hub, m);
  const facts = await repoInspect(hub, m, path).catch(nodeError(m));
  if (!facts.exists) {
    throw problemError(
      problem(
        "path_missing",
        `${path} does not exist on ${m}`,
        `Check the path on ${m}, or clone the repo there by giving its GitHub URL instead`,
      ),
    );
  }
  return facts;
}

export async function cloneTarget(hub: Hub, m: MachineId, repo: GitHubRepo, dest: string | undefined): Promise<CloneTarget> {
  requireRepoNode(hub, m);
  let path: string;
  if (dest !== undefined) path = dest.endsWith("/") ? dest.slice(0, -1) : dest;
  else {
    const root = (await repoScan(hub, m).catch(nodeError(m))).cloneRoot;
    const name = repo.split("/").pop() ?? repo;
    path = `${root.replace(/\/+$/, "")}/${name}`;
  }
  const facts = await repoInspect(hub, m, path).catch(nodeError(m));
  const projectId = projectAt(hub, m, path);
  return {
    machineId: m,
    path,
    exists: facts.exists,
    sameRemote: facts.isGit && remoteRepo(facts) === repo,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

// ---- project_discover.

export async function discover(hub: Hub, caller: Caller, input: ProjectDiscoverInput): Promise<ProjectDiscoverOutput> {
  const machines = store(hub)
    .machinesList()
    .map((m) => m.machineId)
    .filter((m) => input.machineId === undefined || input.machineId === m)
    .filter((m) => allows(caller, "read", m));
  const scans = await Promise.all(
    machines.map(async (m): Promise<MachineRepos> => {
      const gate = repoNode(hub, m);
      if (gate) return { machineId: m, online: executors(hub).isConnected(m), repos: [], problem: gate };
      try {
        const scan = await repoScan(hub, m);
        return {
          machineId: m,
          online: true,
          cloneRoot: scan.cloneRoot,
          ...(scan.projectsRoot !== undefined ? { projectsRoot: scan.projectsRoot } : {}),
          repos: scan.repos.map((r) => {
            const projectId = projectAt(hub, m, r.path);
            const repo = r.remote !== undefined ? githubRepo(r.remote) : undefined;
            return {
              path: r.path,
              name: r.path.split("/").pop() ?? r.path,
              ...(r.remote !== undefined ? { remote: shortRemote(r.remote) } : {}),
              ...(repo !== undefined ? { repo } : {}),
              ...(projectId !== undefined ? { projectId } : {}),
            };
          }),
        };
      } catch (e) {
        return { machineId: m, online: true, repos: [], problem: nodeProblem(m, e) };
      }
    }),
  );
  const bestMachine = bestWorker(hub);
  const github: GitHubRepos =
    input.github === false ? { owners: [], repos: [] } : await ghList(hub, input.machineId ?? bestMachine, scans);
  return {
    machines: scans,
    github,
    ...(bestMachine !== undefined ? { best: bestMachine } : {}),
    next: "Add one with project_add (path on a machine, or url to clone); project_add with dryRun shows its CI and merge rules first.",
  };
}

/** `gh repo list` on the hub, else on `fallback`'s node. */
async function ghList(hub: Hub, fallback: MachineId | undefined, scans: MachineRepos[]): Promise<GitHubRepos> {
  let listed = await addingGh(hub).repoList();
  let ghOn: string | undefined = "hub";
  if (listed.problem !== undefined && fallback !== undefined && repoNode(hub, fallback) === undefined) {
    try {
      const theirs = await ghRepoListOn(hub, fallback);
      if (theirs.problem === undefined) {
        listed = theirs;
        ghOn = fallback;
      }
    } catch {}
  }
  const p =
    listed.problem !== undefined
      ? problem(
          "gh_unavailable",
          `gh repo list did not run: ${listed.problem} on the hub${ghOn === "hub" ? "" : " or the worker"}`,
          "Run `gh auth login` on the hub machine, or paste the repository's URL",
        )
      : undefined;
  if (p) ghOn = undefined;
  const repos: GitHubCandidate[] = [];
  for (const r of listed.repos as GhRepo[]) {
    const repo = r.nameWithOwner;
    if (!isRepo(repo)) continue;
    const checkouts = scans.flatMap((s) =>
      s.repos
        .filter((f) => f.repo === repo)
        .map((f) => ({ machineId: s.machineId, path: f.path, ...(f.projectId !== undefined ? { projectId: f.projectId } : {}) })),
    );
    repos.push({
      repo,
      url: r.url,
      private: r.isPrivate ?? false,
      ...(r.description != null ? { description: jsPrefix(r.description, 300) } : {}),
      ...(r.pushedAt != null ? { pushedAt: r.pushedAt } : {}),
      checkouts,
    });
  }
  return { ...(ghOn !== undefined ? { ghOn } : {}), owners: listed.owners, repos, ...(p ? { problem: p } : {}) };
}

const isRepo = (s: unknown): s is string => typeof s === "string" && isGitHubRepo(s);
