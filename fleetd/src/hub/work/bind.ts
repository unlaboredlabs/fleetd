// Which repo and base a project's work lands on, read from its root on its
// machine with plain git, so it works on any host: the repo key from `remote.origin.url` as configured, the base from
// `origin/HEAD` (what the node branches worktrees from). Projects are bound at hub start and whenever their node
// connects (`run`); the landing scanner refreshes it every scan; callers that find a project unbound read it here. A
// project whose origin goes away is unbound.
import type { MachineId, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { type CmdResult, link } from "../link/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { work } from "./index.ts";
import { type GitOut, gitOk, remoteHead } from "./landing_rules.ts";
import { repoKeyOf } from "./repo_key.ts";
import type { WorkScope } from "./store.ts";
import { isLine } from "./view.ts";

export { type GitOut, gitOk, remoteHead } from "./landing_rules.ts";

/** How the hub runs git in a directory on a machine: the node link, or real git in tests. Undefined when it couldn't. */
export type NodeGit = { git(machine: MachineId, cwd: string, args: string[]): Promise<GitOut | undefined> };

/** Long enough for a fetch of a busy base. */
const GIT_TIMEOUT_SEC = 300;
/** How long one project's bind may take before the pass moves on to the next. */
const BIND_TIMEOUT_MS = 20_000;
/** How long a pass waits for a node that just connected to be reachable. */
const LINK_WAIT_MS = 30_000;

/** git over the node link (`cmd_check`). */
export function nodeGit(hub: Hub): NodeGit {
  return {
    async git(machine, cwd, args) {
      try {
        const out = (await link(hub).commands.run(machine, { cwd, argv: ["git", ...args], timeoutSec: GIT_TIMEOUT_SEC })) as unknown as CmdResult;
        return { code: out.exitCode, out: out.outputTail };
      } catch {
        return undefined;
      }
    },
  };
}

/** Resolves to undefined after `ms` unless `p` settles first. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Reads the project's repo key and base from its root on its own node, records them when they changed, and returns them. */
export async function bindFromRoot(hub: Hub, project: ProjectRef): Promise<WorkScope | undefined> {
  const summary = store(hub).projectGet(project);
  if (!summary) return undefined;
  return bindWith(hub, nodeGit(hub), project, summary.workspaceRoot);
}

/**
 * `bindFromRoot` through `node` with the project's root: undefined when the project has no remote. While its node
 * can't answer, what was recorded before.
 */
export async function bindWith(hub: Hub, node: NodeGit, project: ProjectRef, root: string): Promise<WorkScope | undefined> {
  const w = work(hub);
  const bound = w.scopeOf(project);
  const machine = project.machineId;
  const remote = await node.git(machine, root, ["config", "--get", "remote.origin.url"]);
  if (!remote) return bound;
  // `config --get` exits 1 when the key is unset: a checkout with no origin.
  const repoKey = gitOk(remote) ? repoKeyOf(remote.out.trim()) : undefined;
  if (repoKey === undefined) {
    // Its origin went away: its work no longer lands anywhere fleetd can see.
    if (bound) w.unbindProject(project);
    return undefined;
  }
  const base = await readBase(node, machine, root, repoKey, bound);
  if (base === undefined) {
    // Pointed at another repo whose base can't be read yet: the old scope is wrong either way.
    if (bound && bound.repoKey !== repoKey) {
      w.unbindProject(project);
      return undefined;
    }
    return bound;
  }
  const scope = { repoKey, base };
  if (!bound || bound.repoKey !== repoKey || bound.base !== base) w.bindProject(project, scope);
  return scope;
}

/** Binds the projects not bound yet (on `machine`, when given), one at a time, each for at most BIND_TIMEOUT_MS. How many it bound. */
export async function bindUnbound(hub: Hub, node: NodeGit, machine?: MachineId): Promise<number> {
  let projects;
  try {
    projects = store(hub).projectsList(machine);
  } catch (error) {
    console.warn(`work: projects not read for binding: ${error}`);
    return 0;
  }
  let bound = 0;
  for (const p of projects) {
    const project = { machineId: p.machineId, projectId: p.projectId };
    if (work(hub).scopeOf(project)) continue;
    try {
      const scope = await within(bindWith(hub, node, project, p.workspaceRoot).then((s) => s ?? null), BIND_TIMEOUT_MS);
      if (scope === undefined) console.warn(`work: bind timed out project=${project.projectId}`);
      else if (scope !== null) bound++;
    } catch (error) {
      console.warn(`work: bind failed project=${project.projectId}: ${error}`);
    }
  }
  return bound;
}

/** Binds every unbound project at hub start, then a machine's unbound projects each time its node connects. */
export async function run(hub: Hub, node: NodeGit = nodeGit(hub)): Promise<void> {
  const signal = hub.shutdown.signal;
  let cursor = events(hub).head();
  await bindUnbound(hub, node);
  while (!signal.aborted) {
    let machines: MachineId[] = [];
    try {
      const page = await events(hub).wait({ cursor, types: ["machine.online"], timeoutSec: 3600 }, signal);
      machines = page.events.flatMap((e) => (e.machineId !== undefined ? [e.machineId] : []));
      cursor = Math.max(cursor, page.cursor);
    } catch (error) {
      if (signal.aborted) return;
      console.warn(`work: machine.online not read: ${error}`);
      await Bun.sleep(1000);
    }
    for (const machine of machines) {
      // machine.online can be logged before the hub's link to the node is live.
      await within(executors(hub).awaitLive(machine, signal).catch(() => {}), LINK_WAIT_MS);
      await bindUnbound(hub, node, machine);
    }
  }
}

/** `origin/HEAD` as the checkout has it; else what was recorded for the same repo; else the remote's own HEAD. */
async function readBase(node: NodeGit, machine: MachineId, root: string, repoKey: string, bound: WorkScope | undefined): Promise<string | undefined> {
  const head = await node.git(machine, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (!head) return undefined;
  const trimmed = head.out.trim();
  if (gitOk(head) && trimmed.startsWith("origin/") && isLine(trimmed.slice(7), 250)) return trimmed.slice(7);
  if (bound && bound.repoKey === repoKey) return bound.base;
  const remote = await node.git(machine, root, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (!remote || !gitOk(remote)) return undefined;
  const base = remoteHead(remote.out);
  return base !== undefined && isLine(base, 250) ? base : undefined;
}
