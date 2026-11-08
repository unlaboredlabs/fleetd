// The landing scanner (crates/fleetd/src/hub/work/landings.rs): every commit that reaches a watched base is recorded,
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
import { bindWith, type GitOut, gitOk, type NodeGit, nodeGit } from "./bind.ts";
import type { Landed } from "./elsewhere.ts";
import { type Landings, work } from "./index.ts";
import { shortRemote } from "./repo_key.ts";
import { hasLanding, landingsSince, projectsIn, rewriteOf, sameScope, taskOnBranch, type WorkScope } from "./store.ts";
import { isLine, isWorkPath } from "./view.ts";

export const SCAN_EVERY_MS = 60_000;
/** Commits read per watched base per scan; a base further behind catches up over the next scans. */
const SCAN_MAX = 200;
/** What a node's command output keeps: its last this many characters. */
const OUTPUT_TAIL_MAX = 2000;
/** How far back GitHub's merged PRs are read for a commit's PR and branch. */
const MERGED_LOOKBACK_MS = 24 * 3_600_000;
/** Merged Changes searched for a commit's sha. */
const MERGED_CHANGES = 200;
/** A commit not yet known as the train's waits while a Change on the repo has been merging for less than this. */
const MERGING_GRACE_MS = 10 * 60_000;

/** The most paths a landing keeps. */
export const LANDING_PATHS_MAX = 200;

/** One commit on the first-parent line of a watched base, whoever made it and however it got there: a `landings` row. */
export type Landing = {
  repoKey: string;
  base: string;
  sha: string;
  /** The commit's committer time. */
  at: string;
  /** When the scanner saw it. */
  seenAt: string;
  route: LandingRoute;
  /** The PR or merge request it came from, when the merge message or the host names one. */
  prNumber?: number;
  prUrl?: string;
  /** The branch it came from, when the merge message or the host names one. */
  headBranch?: string;
  subject: string;
  authorEmail?: string;
  /** What it changed against its first parent; the first LANDING_PATHS_MAX. */
  paths: string[];
  /** The Change it is, or merged. */
  changeId?: string;
  /** The write task whose work it is. */
  taskId?: string;
  /** The claims it ended. */
  claimIds: string[];
};

/** A landing as the lead reads it. */
export function landed(l: Landing): Landed {
  const pr = l.prUrl ?? (l.prNumber !== undefined ? `#${l.prNumber}` : undefined);
  return {
    sha: l.sha,
    atMs: parseMs(l.at) ?? 0,
    route: l.route,
    ...(pr !== undefined ? { pr } : {}),
    subject: l.subject,
    ...(l.authorEmail !== undefined ? { authorEmail: l.authorEmail } : {}),
    covers: [...(l.taskId !== undefined ? [l.taskId] : []), ...l.claimIds],
  };
}

/** What `work.landed` says of a landing. */
export const landingEvent = (l: Landing) => ({
  repoKey: l.repoKey,
  base: l.base,
  sha: l.sha,
  route: l.route,
  ...(l.prNumber !== undefined ? { prNumber: l.prNumber } : {}),
  ...(l.headBranch !== undefined ? { headBranch: l.headBranch } : {}),
  subject: l.subject,
  claimIds: l.claimIds,
  ...(l.changeId !== undefined ? { changeId: l.changeId } : {}),
  ...(l.taskId !== undefined ? { taskId: l.taskId } : {}),
});

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

const onGithub = (scope: WorkScope) => scope.repoKey.startsWith("github.com/");

/** Notes whether git on `machine` reached GitHub: an answer from any of its repos counts over another's failure. */
function note(reach: Map<MachineId, boolean>, machine: MachineId, reached: boolean): void {
  reach.set(machine, (reach.get(machine) ?? reached) || reached);
}

/** Why a fetch failed, from git's output (node/worktree.rs `FetchError::of_text`), and its words. */
export function fetchError(text: string): { kind: "offline" | "no_ssh" | "auth" | "no_access" | "other"; why: string } {
  const has = (needles: string[]) => needles.some((n) => text.includes(n));
  // The first line git explains itself on, without our "git … failed: " prefix.
  const at = text.indexOf(" failed: ");
  const rest = at < 0 ? text : text.slice(at + " failed: ".length);
  const line = (rest.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  // The network first: a dropped or refused connection says nothing about access, whatever git adds after it.
  if (
    has([
      "timed out after",
      "kex_exchange_identification",
      "Connection closed by remote host",
      "Connection reset by peer",
      "Broken pipe",
      "Could not resolve host",
      "Could not resolve hostname",
      "Temporary failure in name resolution",
      "Connection refused",
      "Connection timed out",
      "Operation timed out",
      "Network is unreachable",
      "No route to host",
      "Failed to connect",
    ])
  ) {
    return { kind: "offline", why: "offline" };
  }
  if (has(["ssh: not found", "cannot run ssh", "ssh: No such file or directory"])) return { kind: "no_ssh", why: line };
  if (has(["Authentication failed", "Permission denied (publickey", "could not read Username", "could not read Password", "error: 403", "Host key verification failed"])) {
    return { kind: "auth", why: line };
  }
  if (has(["Repository not found", "does not appear to be a git repository", "could not be found"])) return { kind: "no_access", why: line };
  return { kind: "other", why: line };
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

/** The lead's line: "abc1234 "feat: dark mode" was pushed straight to main by ada@example.com; it ended claim C7." */
export function wakeLine(l: Landing): string {
  const short = l.sha.slice(0, 7);
  const by = l.authorEmail !== undefined ? ` by ${l.authorEmail}` : "";
  let how: string;
  if (l.route === "direct_push") how = `was pushed straight to ${l.base}${by}`;
  else {
    const pr = l.prUrl !== undefined ? ` from ${l.prUrl}` : l.prNumber !== undefined ? ` from PR #${l.prNumber}` : "";
    how = `was merged into ${l.base}${pr}${by} without the merge train`;
  }
  let line = `${short} "${l.subject}" ${how}`;
  if (l.claimIds.length > 0) line += `; it ended claim ${l.claimIds.join(", ")}`;
  if (l.taskId !== undefined) line += `; it is ${l.taskId}'s work`;
  return `${line}.`;
}

/** The body first: when the node keeps only the tail, the fields after it are whole. */
const COMMIT_FORMAT = "--format=%b%x1e%H%x1f%ct%x1f%ae%x1f%P%x1f%at%x1f%s";

/** One commit as `git show -s` prints it with COMMIT_FORMAT. */
export type Commit = {
  sha: string;
  atSecs: number;
  email: string;
  parents: string[];
  /** Its author time, which a rebase or cherry-pick keeps. */
  authoredSecs: number;
  subject: string;
  /** What the node's output kept of it: its end. */
  body: string;
};

const int = (s: string | undefined) => (s !== undefined && /^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

export function parseCommit(out: string): Commit | undefined {
  const at = out.lastIndexOf("\u001e");
  if (at < 0) return undefined;
  const body = out.slice(0, at);
  const f = out.slice(at + 1).split("\u001f");
  // splitn(6): the subject keeps any separator it holds.
  if (f.length < 6) return undefined;
  const subjectRaw = f.slice(5).join("\u001f");
  const atSecs = int(f[1]);
  const authoredSecs = int(f[4]);
  if (atSecs === undefined || authoredSecs === undefined) return undefined;
  return {
    sha: f[0]!.trim().toLowerCase(),
    atSecs,
    email: f[2]!.trim(),
    parents: f[3]!.split(/\s+/).filter(Boolean),
    authoredSecs,
    subject: subjectRaw.replace(/\n+$/, ""),
    body,
  };
}

/** What a rebase, an amend of the committer or a cherry-pick keeps: the author, the author time and the subject. */
export const rewriteKey = (c: Commit) => `${c.email.toLowerCase()}\u001f${c.authoredSecs}\u001f${c.subject}`;

/** The lines of an output the node may have cut: a cut first line is dropped. */
export function cutLines(out: string): string[] {
  const cut = out.length >= OUTPUT_TAIL_MAX;
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .slice(cut ? 1 : 0)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** `<sha>\trefs/heads/main` in `git ls-remote origin refs/heads/main`. */
export function lsRemoteSha(out: string, baseRef: string): string | undefined {
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [sha, name] = [line.slice(0, tab), line.slice(tab + 1)];
    if (name.trim() === baseRef && /^[0-9a-fA-F]+$/.test(sha) && sha.length >= 40) return sha.toLowerCase();
  }
  return undefined;
}

/** The host whose merge message named the PR: GitHub (and Gitea, Forgejo), GitLab, Bitbucket, Azure DevOps. */
export type GitHost = "github" | "gitlab" | "bitbucket" | "azure";

/** What a commit's message says about where it came from. */
export type Origin = { pr?: number; head?: string; host?: GitHost };

function numberAfter(text: string, marker: string): [number, string] | undefined {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length);
  const digits = /^[0-9]*/.exec(rest)![0];
  if (digits === "") return undefined;
  return [Number(digits), rest.slice(digits.length)];
}

/** The first `'quoted'` name in `text`. */
function quoted(text: string): string | undefined {
  const a = text.indexOf("'");
  if (a < 0) return undefined;
  const b = text.indexOf("'", a + 1);
  if (b < 0) return undefined;
  const name = text.slice(a + 1, b);
  return name === "" ? undefined : name;
}

/**
 * Reads each host's default merge message: GitHub's `Merge pull request #12 from owner/branch` (Gitea's and Forgejo's
 * `Merge pull request 'title' (#12) from branch into main`), a squash subject ending in `(#12)`, GitLab's `See merge
 * request group/proj!12` and `Merge branch 'feature' into 'main'`, Bitbucket's `Merged in branch (pull request #12)`,
 * Azure DevOps' `Merged PR 12: title`, and a local merge pushed: `Merge branch 'feature'`.
 */
export function originOf(subjectRaw: string, body: string): Origin {
  const subject = subjectRaw.trim();
  const origin: Origin = {};
  if (subject.startsWith("Merge pull request ")) {
    const rest = subject.slice("Merge pull request ".length);
    origin.host = "github";
    const n = numberAfter(rest, "#");
    if (n) origin.pr = n[0];
    const from = rest.lastIndexOf(" from ");
    if (from >= 0) {
      const words = rest.slice(from + 6).split(/\s+/).filter(Boolean);
      const first = words[0] ?? "";
      const head = words[1] === "into" ? first : first.includes("/") ? first.slice(first.indexOf("/") + 1) : undefined;
      if (head) origin.head = head;
    }
    return origin;
  }
  if (subject.startsWith("Merged in ")) {
    const rest = subject.slice("Merged in ".length);
    const n = numberAfter(rest, "(pull request #");
    if (n) {
      origin.host = "bitbucket";
      origin.pr = n[0];
      const head = rest.split(/\s+/).filter(Boolean)[0];
      if (head !== undefined) origin.head = head;
      return origin;
    }
  }
  if (subject.startsWith("Merged PR ")) {
    const n = numberAfter(subject, "Merged PR ");
    if (n && n[1].startsWith(":")) {
      origin.host = "azure";
      origin.pr = n[0];
      return origin;
    }
  }
  for (const line of [...body.split("\n"), subject]) {
    const t = line.trim();
    if (!t.startsWith("See merge request ")) continue;
    const rest = t.slice("See merge request ".length);
    const bang = rest.lastIndexOf("!");
    if (bang < 0) continue;
    const n = rest.slice(bang + 1).trim().replace(/\.+$/, "");
    if (/^\+?[0-9]+$/.test(n)) {
      origin.host = "gitlab";
      origin.pr = Number(n);
      break;
    }
  }
  for (const prefix of ["Merge branch ", "Merge remote-tracking branch "]) {
    if (!subject.startsWith(prefix)) continue;
    const name = quoted(subject.slice(prefix.length));
    if (name === undefined) continue;
    origin.head = prefix === "Merge branch " || !name.includes("/") ? name : name.slice(name.indexOf("/") + 1);
    return origin;
  }
  if (origin.pr === undefined && subject.endsWith(")")) {
    const open = subject.lastIndexOf("(#");
    const n = open >= 0 ? subject.slice(open + 2, -1) : "";
    if (/^\+?[0-9]+$/.test(n)) {
      origin.host = "github";
      origin.pr = Number(n);
    }
  }
  return origin;
}

/** The PR's URL on hosts whose URLs fleetd knows: github.com, bitbucket.org, and GitLab wherever its message said so. */
export function prUrl(repoKey: string, host: GitHost | undefined, n: number): string | undefined {
  if (host === "github" && repoKey.startsWith("github.com/")) return `https://${repoKey}/pull/${n}`;
  if (host === "bitbucket" && repoKey.startsWith("bitbucket.org/")) return `https://${repoKey}/pull-requests/${n}`;
  if (host === "gitlab" && !repoKey.startsWith("/")) return `https://${repoKey}/-/merge_requests/${n}`;
  return undefined;
}

/** A PR URL's number when it is on the repo: `/pull/57`, `/pulls/57`, `/-/merge_requests/57`, `/pull-requests/57`. */
export function prNumberIn(url: string, repoKey: string): number | undefined {
  const short = shortRemote(url).toLowerCase();
  if (!short.startsWith(repoKey)) return undefined;
  const after = short.slice(repoKey.length);
  if (!after.startsWith("/")) return undefined;
  const parts = after.slice(1).split("/").filter((p) => p !== "-");
  const kind = parts[0];
  if (kind !== "pull" && kind !== "pulls" && kind !== "merge_requests" && kind !== "pull-requests") return undefined;
  const n = parts[1];
  return n !== undefined && /^\+?[0-9]+$/.test(n) ? Number(n) : undefined;
}

/** Words that close an issue in a commit message, on GitHub, GitLab, Gitea and Bitbucket alike. */
const CLOSING = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "implement", "implements", "implemented"]);

/** Whether `text` closes `key` ("#12", "SHOP-12"): the key as a whole word right after a closing word. */
export function closes(textRaw: string, keyRaw: string): boolean {
  const [text, key] = [textRaw.toLowerCase(), keyRaw.toLowerCase()];
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    const after = [...text.slice(at + key.length)][0];
    if (after !== undefined && /[\p{Alphabetic}\p{N}]/u.test(after)) continue;
    const head = text.slice(0, at);
    const before = head.replace(/[\s:]+$/u, "");
    if (before.length === head.length && before !== "") continue;
    const word = before.split(/[^\p{Alphabetic}\p{N}]/u).at(-1) ?? "";
    if (CLOSING.has(word)) return true;
  }
  return false;
}

/** The keys a closing reference to the claim's issue may use. An issue URL counts only on the landing's own repo. */
export function issueRefs(issue: string, repoKey: string): string[] {
  if (!issue.includes("://")) return [issue];
  const short = shortRemote(issue).toLowerCase();
  if (!short.startsWith(repoKey) || short[repoKey.length] !== "/") return [];
  let rest = short.slice(repoKey.length + 1);
  while (rest.startsWith("-/")) rest = rest.slice(2);
  const refs = [issue];
  if (rest.startsWith("issues/")) {
    const n = rest.slice("issues/".length).split("/")[0] ?? "";
    if (/^[0-9]+$/.test(n)) refs.push(`#${n}`);
  }
  return refs;
}

/** It landed (why, for the claim's end), or its author's push touched its paths (its work is going on). */
type ClaimMatch = { ends?: string; renews?: true };

export function claimMatch(claim: Claim, landing: Landing, body: string): ClaimMatch | undefined {
  const head = landing.headBranch;
  const branches = [...(claim.branch !== undefined ? [claim.branch] : []), ...claim.keys.flatMap((k) => ("branch" in k ? [k.branch] : []))];
  for (const branch of branches) if (branch === head) return { ends: `branch ${branch}` };
  const message = `${landing.subject}\n${body}`;
  for (const key of claim.keys) {
    if ("pr" in key) {
      const n = prNumberIn(key.pr, landing.repoKey);
      if (n !== undefined && n === landing.prNumber) return { ends: `PR ${key.pr}` };
    } else if ("issue" in key && issueRefs(key.issue, landing.repoKey).some((r) => closes(message, r))) {
      return { ends: `issue ${key.issue}` };
    }
  }
  const own = claim.authorEmail !== undefined && landing.authorEmail !== undefined && asciiLower(claim.authorEmail) === asciiLower(landing.authorEmail);
  if (!own) return undefined;
  const claimPaths = [...claim.paths, ...(claim.observed?.paths ?? [])];
  const sameFile = landing.paths.some((p) => claimPaths.some((g) => pathMatches(g, p)));
  if (landing.route === "direct_push" && stronglyMatches(claim.title, landing.subject, sameFile)) {
    return { ends: `pushed by ${landing.authorEmail ?? "its author"} and matching its title` };
  }
  return sameFile ? { renews: true } : undefined;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `app/settings/**`, `app/*.ts` or a plain path against a repo-relative path. */
export function pathMatches(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3);
    return path === dir || path.startsWith(`${dir}/`);
  }
  if (!glob.includes("*")) return glob === path;
  const parts = glob.split("*");
  const [first, last] = [parts[0]!, parts.at(-1)!];
  if (!path.startsWith(first) || !path.endsWith(last) || path.length < first.length + last.length) return false;
  let rest = path.slice(first.length, path.length - last.length);
  for (const part of parts.slice(1, -1)) {
    const at = rest.indexOf(part);
    if (at < 0) return false;
    rest = rest.slice(at + part.length);
  }
  return true;
}

const COMMIT_TYPES = new Set(["feat", "fix", "chore", "docs", "refactor", "test", "tests", "perf", "build", "ci", "style"]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "add", "adds", "added", "update", "updates", "fix", "fixes",
  "make", "makes", "support", "use", "uses", "when", "now",
]);

/** A title's words: lowercase letters and digits, without the conventional-commit type, stop words, numbers or short words. */
export function words(title: string): string[] {
  let text = title.toLowerCase();
  const at = text.search(/[:(]/);
  if (at >= 0) {
    const first = text.slice(0, at).trim().replace(/!+$/, "");
    if (COMMIT_TYPES.has(first)) text = text.slice(first.length);
  }
  const out: string[] = [];
  for (const word of text.split(/[^\p{Alphabetic}\p{N}]/u)) {
    if ([...word].length >= 3 && !/^[0-9]*$/.test(word) && !STOP_WORDS.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

/** The strong tier: shared words over the smaller set ≥ 0.6 with ≥ 3 shared, or ≥ 0.4 with ≥ 2 shared and a file in common. */
export function stronglyMatches(a: string, b: string, sameFile: boolean): boolean {
  const [x, y] = [words(a), words(b)];
  const smaller = Math.min(x.length, y.length);
  if (smaller === 0) return false;
  const shared = x.filter((w) => y.includes(w)).length;
  const score = shared / smaller;
  return (score >= 0.6 && shared >= 3) || (score >= 0.4 && shared >= 2 && sameFile);
}
