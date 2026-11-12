// The landing scanner: every commit that reaches a watched base is recorded,
// however it got there (the merge train, a PR merged by hand or by another tool, or a direct push), with plain git on
// the project's machine, so it works on any host.
//
// Every SCAN_EVERY_MS it reads each project's repo and base from its root (`bind`), then, once per (repo, base),
// `git ls-remote origin refs/heads/<base>`. When the base moved: fetch it, list its new first-parent commits and read
// each one. Its route: a Change's merge commit is the train's; a message that names a PR (each host's default merge
// message) is a PR merged outside the train; anything else is a direct push. On GitHub, its merged PRs add the PR and
// head branch of a squash merge, and of each commit of a rebase merge. Each landing ends the active claims it matches
// exactly (branch, PR, a closing reference to its issue), and a direct push ends its own author's claim when it
// strongly matches the claim's title; it then wakes every lead on the scope, for outside routes only. While a node is
// offline its watch waits: nothing is guessed, and the next scan catches up. When git there can't reach the remote,
// the project's lead is told once. When git on a machine can't reach GitHub at all, `work(hub).onGithubReach` is told
// once per flip (the tasks area tells the agents running there).
import type { Database } from "bun:sqlite";
import type { Change, Claim, LandingRoute, MachineId, ProjectRef } from "../../shared/contracts.ts";
import { jsPrefix } from "../../shared/text.ts";
import { leadWakes, trainLine } from "../api/leads.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/server.ts";
import { store as hubStore } from "../store/hub_store.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { every } from "../sweep/index.ts";
import { TaskRecords } from "../tasks/records.ts";
import { systemGh } from "../train/gh.ts";
import { type MergedPull, TrainGitHub } from "../train/github.ts";
import { changeRecords } from "../train/index.ts";
import { fresh } from "../train/seams.ts";
import { bindWith, type NodeGit, nodeGit } from "./bind.ts";
import { type Landings, work } from "./index.ts";
import {
  claimMatch,
  COMMIT_FORMAT,
  cutLines,
  fetchError,
  type GitOut,
  gitOk,
  LANDING_PATHS_MAX,
  type Landing,
  landed,
  lsRemoteSha,
  MERGED_CHANGES,
  MERGED_LOOKBACK_MS,
  MERGING_GRACE_MS,
  onGithub,
  originOf,
  parseCommit,
  prUrl,
  rewriteKey,
  SCAN_EVERY_MS,
  SCAN_MAX,
  wakeLine,
} from "./landing_rules.ts";
import { hasLanding, landingsSince, projectsIn, rewriteOf, sameScope, taskOnBranch, type WorkScope } from "./store.ts";
import { isLine, isWorkPath } from "./view.ts";

export {
  claimMatch,
  closes,
  type Commit,
  cutLines,
  fetchError,
  type GitHost,
  issueRefs,
  LANDING_PATHS_MAX,
  type Landing,
  landed,
  landingEvent,
  lsRemoteSha,
  type Origin,
  originOf,
  parseCommit,
  pathMatches,
  prNumberIn,
  prUrl,
  rewriteKey,
  SCAN_EVERY_MS,
  stronglyMatches,
  wakeLine,
  words,
} from "./landing_rules.ts";

/** The landings table, as the digest and work_list read it. */
export const landingStore = (db: Database): Landings => ({
  outside: (scope: WorkScope, sinceMs: number, limit: number) => landingsSince(db, scope, sinceMs, limit, true).map(landed),
});

/** What the scanner asks beyond git: GitHub's merged PRs, for the PR and head branch of a squash or rebase merge. */
export type LandingPorts = NodeGit & {
  /** The GitHub repo's (`owner/name`) recently merged PRs; undefined when they could not be read. */
  mergedPulls(repo: string): Promise<MergedPull[] | undefined>;
  /** The merged PRs the commit came from; undefined when they could not be read. */
  mergedPullsOf(repo: string, sha: string): Promise<MergedPull[] | undefined>;
};

/** The hub's own: git over the node link, GitHub through `gh`, as the train reads it. */
export function hubLandingPorts(hub: Hub): LandingPorts {
  const github = new TrainGitHub(systemGh, fresh(hub), () => hub.clock.now(), Bun.sleep);
  return {
    ...nodeGit(hub),
    async mergedPulls(repo) {
      try {
        return await github.mergedPulls(repo, hub.clock.now() - MERGED_LOOKBACK_MS);
      } catch (error) {
        console.warn(`landings: merged PRs not read repo=${repo}: ${(error as Error).message}`);
        return undefined;
      }
    },
    async mergedPullsOf(repo, sha) {
      try {
        return await github.mergedPullsOf(repo, sha);
      } catch (error) {
        console.warn(`landings: a commit's PRs not read repo=${repo} sha=${sha}: ${(error as Error).message}`);
        return undefined;
      }
    },
  };
}

/** Scans every SCAN_EVERY_MS until the hub shuts down. */
export function run(hub: Hub, ports: LandingPorts = hubLandingPorts(hub)): void {
  every(hub, SCAN_EVERY_MS, () => scan(hub, ports));
}

type Roots = { scope: WorkScope; roots: [ProjectRef, string][] };

/** One scan: binds every project from its root, then reads each watched base once, through the first of its projects whose node answers. */
export async function scan(hub: Hub, ports: LandingPorts): Promise<void> {
  let projects;
  try {
    projects = hubStore(hub).projectsList();
  } catch (error) {
    return console.warn(`landings: projects not read: ${error}`);
  }
  const scopes: Roots[] = [];
  // Whether git on each machine this poll asked reached GitHub: one answer from it is enough.
  const reach = new Map<MachineId, boolean>();
  for (const p of projects) {
    const project = { machineId: p.machineId, projectId: p.projectId };
    let scope: WorkScope | undefined;
    try {
      scope = await bindWith(hub, ports, project, p.workspaceRoot);
    } catch (error) {
      console.warn(`landings: the project's repo and base were not recorded: ${error}`);
      continue;
    }
    if (!scope) continue;
    const found = scopes.find((s) => sameScope(s.scope, scope));
    if (found) found.roots.push([project, p.workspaceRoot]);
    else scopes.push({ scope, roots: [[project, p.workspaceRoot]] });
  }
  for (const { scope, roots } of scopes) {
    for (const [project, root] of roots) {
      try {
        if (await new Scanner(hub, ports, scope, project, root, reach).scan()) break;
      } catch (error) {
        console.warn(`landings: scan failed repo=${scope.repoKey} base=${scope.base}: ${error}`);
        break;
      }
    }
  }
  await askTheRest(hub, ports, scopes, reach);
  const w = work(hub);
  for (const [machine, reached] of reach) {
    // With no IPv4 there too, the machine shows degraded until either is back (hub/link/network.ts).
    link(hub).githubReached(machine, reached);
    if (!w.githubReached(machine, reached)) continue;
    try {
      await w.onGithubReach(machine, reached);
    } catch (error) {
      console.warn(`landings: its agents not told whether GitHub answers machine=${machine}: ${error}`);
    }
  }
}

/**
 * Asks each machine the scan didn't whether git there reaches GitHub, with one `ls-remote` on one of its roots, while
 * it has running agents or was found down: else its agents would never hear that GitHub is down, or that it is back.
 */
async function askTheRest(hub: Hub, ports: LandingPorts, scopes: Roots[], reach: Map<MachineId, boolean>): Promise<void> {
  const asked = new Set(reach.keys());
  for (const { scope, roots } of scopes) {
    if (!onGithub(scope)) continue;
    for (const [project, root] of roots) {
      const machine = project.machineId;
      if (asked.has(machine)) continue;
      asked.add(machine);
      const running = () => {
        try {
          return TaskRecords.runningOn(hub.db.conn, machine).length > 0;
        } catch {
          return false;
        }
      };
      if (!work(hub).githubDown(machine) && !running()) continue;
      // A node that doesn't answer says nothing of GitHub.
      const out = await ports.git(machine, root, ["ls-remote", "origin", `refs/heads/${scope.base}`]);
      if (!out) continue;
      if (gitOk(out) || fetchError(out.out).kind === "offline") note(reach, machine, gitOk(out));
    }
  }
}

/** Notes whether git on `machine` reached GitHub: an answer from any of its repos counts over another's failure. */
function note(reach: Map<MachineId, boolean>, machine: MachineId, reached: boolean): void {
  reach.set(machine, (reach.get(machine) ?? reached) || reached);
}

/** What one scan of a base read once and reuses for each commit. */
type Context = {
  projects: ProjectRef[];
  /** The scope's GitHub repo (`owner/name`), when it is on GitHub: where the train's Changes are. */
  github?: string;
  merged: Change[];
  /** The train has been merging a Change on the repo for under MERGING_GRACE_MS: a commit not recorded yet waits. */
  merging: boolean;
  pulls?: MergedPull[];
};

/** A commit read for a landing. */
type Read = { landing: Landing; rewriteKey: string; body: string };

class Scanner {
  constructor(
    private readonly hub: Hub,
    private readonly ports: LandingPorts,
    private readonly scope: WorkScope,
    private readonly project: ProjectRef,
    private readonly root: string,
    private readonly reach: Map<MachineId, boolean>,
  ) {}

  private git(args: string[]): Promise<GitOut | undefined> {
    return this.ports.git(this.project.machineId, this.root, args);
  }

  /** False when the node didn't answer (another project's root may). */
  async scan(): Promise<boolean> {
    const baseRef = `refs/heads/${this.scope.base}`;
    const remote = await this.git(["ls-remote", "origin", baseRef]);
    if (!remote) return false;
    if (!gitOk(remote)) {
      this.unreachable(remote);
      return false;
    }
    this.reached(true);
    const head = lsRemoteSha(remote.out, baseRef);
    if (head === undefined) return true;
    const w = work(this.hub);
    const watch = w.watch(this.scope);
    if (!watch) {
      // The watch starts now: nothing older is reported.
      w.watchAt(this.scope, head);
      return true;
    }
    if (watch.lastSha === head) {
      w.scanOk(this.project);
      return true;
    }
    const fetched = await this.git(["fetch", "--no-tags", "--quiet", "origin", `+${baseRef}:refs/remotes/origin/${this.scope.base}`]);
    if (!fetched) return false;
    if (!gitOk(fetched)) {
      this.unreachable(fetched);
      return false;
    }
    w.scanOk(this.project);
    const cx = this.context();
    let last = watch.lastSha;
    let read = 0;
    while (read < SCAN_MAX) {
      const listed = await this.newCommits(last, head, watch.sinceMs);
      if (!listed) return false;
      const [shas, rewritten] = listed;
      if (shas.length === 0) {
        w.watchAt(this.scope, head);
        break;
      }
      for (const sha of shas) {
        const one = await this.read(sha, cx);
        if (!one) return false;
        // Likely the train's own merge, not recorded yet: the next scan reads it again.
        if (cx.merging && one.landing.route !== "train") return true;
        // After a force push, a commit rewritten from one already recorded is not new work.
        if (rewritten && rewriteOf(this.hub.db.conn, this.scope, one.rewriteKey, one.landing.prNumber)) w.watchAt(this.scope, sha);
        else this.land(one, cx);
        last = sha;
        read++;
      }
    }
    return true;
  }

  /** Git on this project's machine can't reach the remote: its lead is told once, with why. */
  private unreachable(out: GitOut): void {
    const error = fetchError(out.out);
    if (error.kind === "offline") this.reached(false);
    console.warn(`landings: the base was not read repo=${this.scope.repoKey} project=${this.project.projectId}: ${error.why}`);
    if (!work(this.hub).scanFailed(this.project, error.why)) return;
    const line =
      `fleetd can't see what lands on ${this.scope.base} of ${this.scope.repoKey}: git on ${this.project.machineId} can't reach origin from ${this.root} ` +
      `(fetch failed: ${error.why}). Merges and pushes made outside fleetd stay unseen until it can (an SSH key in ssh-agent, or a credential helper).`;
    leadWakes(this.hub).trigger(this.project, trainLine(line));
  }

  /** Notes whether git on this project's machine reached GitHub, for a scope there. */
  private reached(reached: boolean): void {
    if (onGithub(this.scope)) note(this.reach, this.project.machineId, reached);
  }

  private context(): Context {
    const projects = projectsIn(this.hub.db.conn, this.scope);
    const github = this.scope.repoKey.startsWith("github.com/") ? this.scope.repoKey.slice("github.com/".length) : undefined;
    if (github === undefined) return { projects, merged: [], merging: false };
    const records = changeRecords(this.hub);
    const now = this.hub.clock.now();
    return {
      projects,
      github,
      merged: records.list({ repo: github, state: "merged", limit: MERGED_CHANGES }),
      merging: records.inTrain(github, ["merging"]).some((c) => {
        const at = parseMs(c.updatedAt);
        return at !== undefined && now - at < MERGING_GRACE_MS;
      }),
    };
  }

  /**
   * The base's first-parent commits after `last` that aren't recorded yet, oldest first, as many as the node's output
   * kept, and whether the base was rewritten. Undefined when the node didn't answer.
   */
  private async newCommits(last: string, head: string, sinceMs: number): Promise<[string[], boolean] | undefined> {
    const ancestor = await this.git(["merge-base", "--is-ancestor", last, head]);
    if (!ancestor) return undefined;
    let range: string;
    if (gitOk(ancestor)) range = `${last}..${head}`;
    else {
      // Rewritten: the new line from where it left the old one, if git still has the old one; never older than the watch.
      const fork = await this.git(["merge-base", last, head]);
      const forkSha = fork && gitOk(fork) ? fork.out.trim() : undefined;
      range = forkSha !== undefined && forkSha.length === head.length ? `${forkSha}..${head}` : head;
    }
    const args = ["rev-list", "--first-parent", range];
    if (!gitOk(ancestor)) args.push(`--since=${Math.floor(sinceMs / 1000)}`);
    const listed = await this.git(args);
    if (!listed) return undefined;
    if (!gitOk(listed)) return [[], false];
    // Newest first, so the tail the node kept is the oldest; a cut first line is shorter than a sha.
    const shas = listed.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length === head.length && /^[0-9a-fA-F]+$/.test(l))
      .reverse();
    return [shas.filter((sha) => !hasLanding(this.hub.db.conn, this.scope, sha)), !gitOk(ancestor)];
  }

  /** The landing `sha` is, with its route and links; undefined when the node didn't answer. */
  private async read(sha: string, cx: Context): Promise<Read | undefined> {
    // The body first: when the node keeps only the tail, the fields after it are whole.
    const header = await this.git(["show", "-s", COMMIT_FORMAT, sha]);
    if (!header) return undefined;
    const commit = parseCommit(header.out);
    if (!commit) return undefined;
    let paths: string[] = [];
    const parent = commit.parents[0];
    if (parent !== undefined) {
      const diff = await this.git(["diff", "--name-only", "--no-renames", parent, sha]);
      if (!diff) return undefined;
      if (gitOk(diff)) paths = cutLines(diff.out);
    }
    const origin = originOf(commit.subject, commit.body);
    let change = cx.merged.find((c) => c.mergedSha === commit.sha);
    let route: LandingRoute = change ? "train" : origin.pr !== undefined ? "pr_outside" : "direct_push";
    if (cx.github !== undefined) {
      const repo = cx.github;
      if (origin.head === undefined || origin.pr === undefined) {
        cx.pulls ??= (await this.ports.mergedPulls(repo)) ?? [];
        let pull = cx.pulls.find((p) => origin.pr === p.number || p.mergeSha?.toLowerCase() === commit.sha);
        if (!pull && route === "direct_push") {
          // A rebase merge's earlier commits: GitHub names only its last one as the merge commit.
          pull = ((await this.ports.mergedPullsOf(repo, commit.sha)) ?? []).find((p) => p.base === this.scope.base);
        }
        if (pull) {
          origin.pr = pull.number;
          origin.head ??= pull.head;
          origin.host ??= "github";
          if (route === "direct_push") route = "pr_outside";
        }
      }
      if (!change && origin.pr !== undefined) {
        change = changeRecords(this.hub).latestFor(repo, origin.pr);
        if (change?.state === "merged") route = "train";
      }
    }
    const head = origin.head ?? change?.branch;
    let task;
    try {
      if (change?.taskId !== undefined) task = TaskRecords.get(this.hub.db.conn, change.taskId)?.task;
      else if (head !== undefined) task = taskOnBranch(this.hub.db.conn, cx.projects, head);
    } catch {}
    const prUrlOf = origin.pr !== undefined ? prUrl(this.scope.repoKey, origin.host, origin.pr) : undefined;
    const email = jsPrefix(commit.email, 200);
    const landing: Landing = {
      repoKey: this.scope.repoKey,
      base: this.scope.base,
      sha: commit.sha,
      at: isoMs(commit.atSecs * 1000),
      seenAt: isoMs(this.hub.clock.now()),
      route,
      ...(origin.pr !== undefined && origin.pr >= 1 ? { prNumber: origin.pr } : {}),
      ...(prUrlOf !== undefined ? { prUrl: prUrlOf } : {}),
      ...(head !== undefined && isLine(head, 250) ? { headBranch: head } : {}),
      subject: jsPrefix(commit.subject, 300),
      ...(isLine(email, 200) ? { authorEmail: email } : {}),
      paths: paths.filter(isWorkPath).slice(0, LANDING_PATHS_MAX),
      ...(change ? { changeId: change.changeId } : {}),
      ...(task ? { taskId: task.taskId } : {}),
      claimIds: [],
    };
    return { landing, rewriteKey: rewriteKey(commit), body: commit.body };
  }

  /** Records the landing, ends the claims it matches and wakes the scope's leads for an outside route. */
  private land(read: Read, cx: Context): void {
    const w = work(this.hub);
    const landing = read.landing;
    const ending: [Claim, string][] = [];
    const renewing: Claim[] = [];
    for (const claim of w.activeClaims(this.scope)) {
      const m = claimMatch(claim, landing, read.body);
      if (m?.ends !== undefined) ending.push([claim, m.ends]);
      else if (m?.renews) renewing.push(claim);
    }
    landing.claimIds = ending.map(([c]) => c.claimId);
    if (!w.recordLanding(landing, read.rewriteKey, this.project)) return;
    const short = landing.sha.slice(0, 7);
    for (const [claim, why] of ending) w.end(claim.claimId, "landed", `${short} landed on ${landing.base}: ${why}`, landing.sha);
    for (const claim of renewing) w.renew(claim.claimId);
    if (landing.route !== "train") {
      const line = wakeLine(landing);
      for (const project of cx.projects) leadWakes(this.hub).trigger(project, trainLine(line));
    }
  }
}
