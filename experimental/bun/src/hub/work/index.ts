// The work ledger (crates/fleetd/src/hub/work/mod.rs): one view of the work in flight on a repo's base branch, across
// every project on that repo, so nothing is built twice. Tasks and Changes stay their own source of truth; this area
// adds claims (intent fleetd can't otherwise see, such as a human's own session) and the repo and base each project's
// work lands on. (`hub/ledger` is the decision log, a different thing.)
//
// A claim lasts CLAIM_TTL_MS from its last renewal; the sweep expires it, and the view keeps an expired claim, as
// weak, for EXPIRED_SHOWN_MS. Other areas reach it as `work(hub)`: the tasks' duplicate check through `scopeOf`,
// `bindFromRoot`, `observe`, `checkObserved` and `matcher.intent`, the leads' digest through `elsewhere(r)`.
import type {
  Change,
  Claim,
  ClaimId,
  ClaimObserved,
  ClaimOwner,
  ClaimState,
  HubEventType,
  MachineId,
  ProjectRef,
  RepoId,
  Task,
  TaskId,
  ThreadRef,
  WorkEventData,
  WorkItem,
  WorkKey,
  WorkMatch,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { executors, READ_TIMEOUT_MS } from "../executor/index.ts";
import { ensureOwn } from "../repos/store.ts";
import { events } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { changeRecords } from "../train/index.ts";
import { addDeclared, matcherKeys, matcherScope, matchesIn } from "./check.ts";
import { bindFromRoot } from "./bind.ts";
import { intent } from "./intent.ts";
import * as elsewhere from "./elsewhere.ts";
import type { Landing } from "./landings.ts";
import * as matcher from "./matcher.ts";
import * as store from "./store.ts";
import type { WorkScope } from "./store.ts";
import * as view from "./view.ts";

export type { WorkScope };

/** A claim lasts this long from its last renewal (fleetd-contracts work.rs). */
export const CLAIM_TTL_MS = 12 * 3_600_000;
/** An expired claim stays in the view, as weak, this long. */
export const EXPIRED_SHOWN_MS = 24 * 3_600_000;
/** Tasks and Changes read per project for the view. */
const PROJECT_ROWS = 200;
/** A failure after this long without one is a new outage, told to the lead again. */
export const OUTAGE_GAP_MS = 3_600_000;

/** What the view asks the nodes: the paths a thread's worktree has changed so far; undefined when its node couldn't say. */
export type WorkPorts = { changedPaths(thread: ThreadRef): Promise<string[] | undefined> };

/** The scope's writers' changed paths, by task, and the writers whose node didn't say (or not in time). */
export type Observed = { paths: Map<TaskId, string[]>; unknown: Set<TaskId> };

/** A claim as asked for; the hub numbers it and sets its state and times. */
export type NewClaim = {
  scope: WorkScope;
  projectRef?: ProjectRef;
  owner: ClaimOwner;
  title: string;
  keys: WorkKey[];
  branch?: string;
  paths: string[];
  authorEmail?: string;
};

/** How a claim ends, other than expiring. */
export type Ending = "landed" | "released";

/** Where landings outside the train are read from (elsewhere.rs `Landings`); the landing scanner sets it. */
export type Landings = { outside(scope: WorkScope, sinceMs: number, limit: number): elsewhere.Landed[] };

type ScanFailure = { why: string; atMs: number; failing: boolean };

const refKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/** The tasks' own ports: a writer's changed paths, asked of its node. */
function taskPaths(hub: Hub): WorkPorts {
  return {
    async changedPaths(thread) {
      try {
        const out = await executors(hub).call(thread.machineId, "read", { op: "changes", sessionId: thread.threadId }, READ_TIMEOUT_MS);
        return out.kind === "changes" ? out.paths : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Whether a Change's `owner/name` is the repo the key names, on whatever host it is: the key's path after its host
 * (`github.com`, a GitHub Enterprise or GitLab host, `host:port` of an ssh remote).
 */
export function onRepo(key: string, repo: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && key.slice(slash + 1) === repo.toLowerCase();
}

function ended(claim: Claim, state: ClaimState, now: number, reason: string, landing?: string): Claim {
  const cut = [...reason].slice(0, 200).join("");
  return {
    ...claim,
    state,
    end: { at: isoMs(now), reason: view.isLine(cut, 200) ? cut : "ended", ...(landing !== undefined ? { landing } : {}) },
  };
}

export class Work {
  /** The matcher, with a spawn's intent as it reads one, for the tasks area's duplicate check. */
  readonly matcher = { ...matcher, intent };
  private ports: WorkPorts;
  private landingSource: Landings | undefined;
  /** Each project's last failure to read its base. */
  private readonly scanFailures = new Map<string, ScanFailure>();
  /** Machines whose git couldn't reach GitHub at the scanner's last poll of them. */
  private readonly down = new Set<MachineId>();

  constructor(private readonly hub: Hub) {
    this.ports = taskPaths(hub);
  }

  private get db() {
    return this.hub.db;
  }

  private now(): number {
    return this.hub.clock.now();
  }

  /** What the view asks the nodes; tests set a fake. */
  setPorts(ports: WorkPorts): void {
    this.ports = ports;
  }

  /** Where landings are read from; set by the landing scanner. Until then there are none. */
  setLandings(landings: Landings): void {
    this.landingSource ??= landings;
  }

  /** The scope's landings outside the train from the last LANDINGS_SHOWN_MS, newest first, at most `limit`. */
  outsideLandings(scope: WorkScope, limit: number): elsewhere.Landed[] {
    return this.landingSource ? this.landingSource.outside(scope, this.now() - elsewhere.LANDINGS_SHOWN_MS, limit) : [];
  }

  /** The lead digest's Elsewhere lines for the project; undefined when its repo and base aren't known. No node is asked. */
  elsewhere(project: ProjectRef): string[] | undefined {
    const scope = this.scopeOf(project);
    if (!scope) return undefined;
    return elsewhere.lines(project, scope, this.inFlightStored(scope), this.outsideLandings(scope, elsewhere.LANDINGS_SHOWN));
  }

  /** Records the repo and base the project's work lands on; a directory with a remote gets its own repo with them. */
  bindProject(project: ProjectRef, scope: WorkScope): void {
    const now = this.now();
    this.db.transaction((c) => {
      store.bind(c, project, scope, now);
      ensureOwn(c, project);
    });
  }

  /** Forgets the project's repo and base: its origin went away. Its own repo stays, with no key or base. */
  unbindProject(project: ProjectRef): void {
    this.db.transaction((c) => {
      store.unbind(c, project);
      ensureOwn(c, project);
    });
  }

  /** How far the landing scanner has read the scope's base; undefined before its first scan. */
  watch(scope: WorkScope): store.Watch | undefined {
    return store.watch(this.db.conn, scope);
  }

  /** Whether the landing scanner watches the scope's base, and so tells its leads about merges outside the train. */
  watches(scope: WorkScope): boolean {
    return this.watch(scope) !== undefined;
  }

  /** Starts the scope's watch at `sha`, or moves it there. */
  watchAt(scope: WorkScope, sha: string): void {
    store.watchAt(this.db.conn, scope, sha, this.now());
  }

  /** The scope's active claims, oldest first. */
  activeClaims(scope: WorkScope): Claim[] {
    return store.inScope(this.db.conn, scope, Number.MAX_SAFE_INTEGER).reverse();
  }

  /** The scope's landings committed at or after `sinceMs`, newest first. */
  landings(scope: WorkScope, sinceMs: number, limit: number): Landing[] {
    return store.landingsSince(this.db.conn, scope, sinceMs, limit, false);
  }

  /**
   * Stores the landing (with what a rebase keeps of its commit) and moves its base's watch to it, in one transaction,
   * and announces it (`work.landed`). False when the commit was already recorded.
   */
  recordLanding(landing: Landing, rewriteKey: string, via: ProjectRef): boolean {
    const scope = { repoKey: landing.repoKey, base: landing.base };
    const now = this.now();
    const added = this.db.transaction((c) => {
      const added = store.insertLanding(c, landing, rewriteKey);
      store.watchAt(c, scope, landing.sha, now);
      return added;
    });
    if (!added) return false;
    const how =
      landing.route === "train"
        ? "landed by the merge train"
        : landing.route === "pr_outside"
          ? "merged without the merge train"
          : `pushed straight to ${landing.base}`;
    events(this.hub).append({
      at: isoMs(now),
      type: "work.landed",
      machineId: via.machineId,
      projectId: via.projectId,
      summary: [...`${landing.sha.slice(0, 7)} ${how}: ${landing.subject}`].slice(0, 200).join(""),
      data: landingEvent(landing),
    });
    return true;
  }

  /** Notes why the scanner can't read the project's base. True when this starts an outage, and its lead is told. */
  scanFailed(project: ProjectRef, why: string): boolean {
    const now = this.now();
    const last = this.scanFailures.get(refKey(project));
    this.scanFailures.set(refKey(project), { why, atMs: now, failing: true });
    return last === undefined || now - last.atMs >= OUTAGE_GAP_MS;
  }

  /** The scanner read the project's base. */
  scanOk(project: ProjectRef): void {
    const failure = this.scanFailures.get(refKey(project));
    if (failure) failure.failing = false;
  }

  /** Why the scanner last failed to read the project's base, while it does. */
  scanFailure(project: ProjectRef): string | undefined {
    const failure = this.scanFailures.get(refKey(project));
    return failure?.failing ? failure.why : undefined;
  }

  /** What a poll found of git on `machine` reaching GitHub. True when that flipped since the last poll that found out. */
  githubReached(machine: MachineId, reached: boolean): boolean {
    if (reached) return this.down.delete(machine);
    if (this.down.has(machine)) return false;
    this.down.add(machine);
    return true;
  }

  /** The scanner last found git on `machine` unable to reach GitHub. */
  githubDown(machine: MachineId): boolean {
    return this.down.has(machine);
  }

  /** Reads the project's repo and base from its root on its node, records them when they changed, and returns them. */
  bindFromRoot(project: ProjectRef): Promise<WorkScope | undefined> {
    return bindFromRoot(this.hub, project);
  }

  /** The repo and base the project's work lands on: its own repo's. */
  scopeOf(project: ProjectRef): WorkScope | undefined {
    return store.scopeOf(this.db.conn, project);
  }

  /** The repo and base the repo's work lands on; undefined for an unknown repo or one with no remote. */
  scopeOfRepo(repoId: RepoId): WorkScope | undefined {
    return store.scopeOfRepo(this.db.conn, repoId);
  }

  get(claimId: ClaimId): Claim | undefined {
    return store.getClaim(this.db.conn, claimId);
  }

  /** Stores an active claim, good for CLAIM_TTL_MS, and announces it (`work.claimed`), with a note in its summary. */
  claim(input: NewClaim, note?: string): Claim {
    const done = this.claimIf(input, undefined, () => ({ ok: [note, undefined] as const }));
    if ("refused" in done) throw new Error("unreachable");
    return done.claim;
  }

  /**
   * Stores an active claim, with what its branch changed when given, only if `check` passes on the scope's claims
   * (active ones, and those expired in the last EXPIRED_SHOWN_MS) as read in the same transaction, so two claims made
   * at once can't both pass a check that each would fail against the other. `check` returns the note for
   * `work.claimed` and what to hand back, or why the claim is refused.
   */
  claimIf<T, R>(
    input: NewClaim,
    observed: ClaimObserved | undefined,
    check: (claims: Claim[]) => { ok: readonly [string | undefined, T] } | { refused: R },
  ): { claim: Claim; out: T } | { refused: R } {
    const now = this.now();
    const at = isoMs(now);
    const draft: Claim = {
      claimId: "C0",
      repoKey: input.scope.repoKey,
      base: input.scope.base,
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      owner: input.owner,
      title: input.title,
      keys: input.keys,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      paths: input.paths,
      ...(observed ? { observed } : {}),
      ...(input.authorEmail !== undefined ? { authorEmail: input.authorEmail } : {}),
      state: "active",
      createdAt: at,
      renewedAt: at,
      expiresAt: isoMs(now + CLAIM_TTL_MS),
    };
    const saved = this.db.transaction((c) => {
      const decided = check(store.inScope(c, input.scope, now - EXPIRED_SHOWN_MS));
      if ("refused" in decided) return decided;
      return { claim: store.insertClaim(c, draft), note: decided.ok[0], out: decided.ok[1] };
    });
    if ("refused" in saved) return saved;
    const note = saved.note !== undefined ? ` (${saved.note})` : "";
    this.emit("work.claimed", saved.claim, `${saved.claim.claimId} claimed: ${saved.claim.title}${note}`);
    return { claim: saved.claim, out: saved.out };
  }

  /**
   * Extends an active or expired claim by CLAIM_TTL_MS from now, with what its branch changed when given. An expired
   * claim is active again, unless it has dropped out of the view and someone else has taken the same work since: then
   * it is released, saying who. Undefined for that, and for an unknown, landed or released one.
   */
  renew(claimId: ClaimId, observed?: ClaimObserved): Claim | undefined {
    const now = this.now();
    const current = this.get(claimId);
    const taker = current ? this.takenSince(current, now) : undefined;
    if (taker !== undefined) {
      const reason = `${taker} took the same work after this claim expired`;
      const released = this.db.transaction((c) => {
        const claim = store.getClaim(c, claimId);
        if (!claim || claim.state !== "expired") return undefined;
        const out = ended(claim, "released", now, reason);
        store.putClaim(c, out);
        return out;
      });
      if (released) this.announceEnd(released);
      return undefined;
    }
    const renewed = this.db.transaction((c) => {
      const claim = store.getClaim(c, claimId);
      if (!claim || (claim.state !== "active" && claim.state !== "expired")) return undefined;
      const revived = claim.state === "expired";
      const { end: _end, ...rest } = claim;
      const out: Claim = { ...rest, state: "active", renewedAt: isoMs(now), expiresAt: isoMs(now + CLAIM_TTL_MS), ...(observed ? { observed } : {}) };
      store.putClaim(c, out);
      return { claim: out, revived };
    });
    if (!renewed) return undefined;
    if (renewed.revived) this.emit("work.claimed", renewed.claim, `${renewed.claim.claimId} is active again: ${renewed.claim.title}`);
    return renewed.claim;
  }

  /**
   * For an expired claim no longer in the view: the id of work in flight that is newer than its expiry, held by
   * someone else, and shares one of its exact keys.
   */
  private takenSince(claim: Claim, now: number): string | undefined {
    if (claim.state !== "expired" || !claim.end) return undefined;
    const endAt = claim.end.at;
    const endMs = parseMs(endAt);
    if (endMs !== undefined && endMs > now - EXPIRED_SHOWN_MS) return undefined;
    const scope = { repoKey: claim.repoKey, base: claim.base };
    // Timestamps are all the hub's own ISO form, so they compare as text.
    const items = view.items(this.sources(scope)).filter((i) => i.since > endAt && i.claimId !== claim.claimId);
    const ms = matcherScope(scope);
    const intent = matcher.readWork(claim.owner.keyId, claim.title, "", ms);
    const declared = [...claim.keys, ...(claim.branch !== undefined ? [{ branch: claim.branch }] : [])];
    addDeclared(intent, declared.flatMap((k) => matcherKeys(k, ms)));
    return matchesIn(items, intent, scope).find((m) => m.strength === "exact")?.item.id;
  }

  /** Ends an active claim as landed or released, and announces it (`work.ended`). Undefined when unknown or not active. */
  end(claimId: ClaimId, ending: Ending, reason: string, landing?: string): Claim | undefined {
    const now = this.now();
    const done = this.db.transaction((c) => {
      const claim = store.getClaim(c, claimId);
      if (!claim || claim.state !== "active") return undefined;
      const out = ended(claim, ending, now, reason, landing);
      store.putClaim(c, out);
      return out;
    });
    if (done) this.announceEnd(done);
    return done;
  }

  /** Releases every active claim the owner key holds: what happens when the key is revoked. */
  releaseOwner(keyId: string, reason: string): Claim[] {
    const now = this.now();
    const released = this.db.transaction((c) =>
      store.activeOfOwner(c, keyId).map((claim) => {
        const out = ended(claim, "released", now, reason);
        store.putClaim(c, out);
        return out;
      }),
    );
    for (const claim of released) this.announceEnd(claim);
    return released;
  }

  /** Expires every active claim not renewed in time; the sweep's check. Returns how many. */
  expireDue(): number {
    const now = this.now();
    const expired = this.db.transaction((c) =>
      store.due(c, now).map((claim) => {
        const out = ended(claim, "expired", now, `not renewed for ${CLAIM_TTL_MS / 3_600_000} h`);
        store.putClaim(c, out);
        return out;
      }),
    );
    for (const claim of expired) this.announceEnd(claim);
    return expired.length;
  }

  /** The work in flight on the scope; each writer's changed paths are asked of its node. */
  async inFlight(scope: WorkScope): Promise<WorkItem[]> {
    const observed = await this.observe(scope);
    return this.inFlightObserved(scope, observed.paths);
  }

  /**
   * What each of the scope's writers has changed so far, asked of their nodes at once. With `timeoutMs`, a node that
   * hasn't answered by then is not waited on: its writers are `unknown`, like those whose node couldn't say.
   */
  async observe(scope: WorkScope, timeoutMs?: number): Promise<Observed> {
    const sources = this.sources(scope);
    const threads = [...sources.tasks, ...sources.changeTasks]
      .filter((t) => t.kind === "write")
      .flatMap((t) => (t.threadRef ? [[t.taskId, t.threadRef] as const] : []));
    const paths = await Promise.all(
      threads.map(([, thread]) => {
        const asked = this.ports.changedPaths(thread);
        if (timeoutMs === undefined) return asked;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        });
        return Promise.race([asked, late]).finally(() => clearTimeout(timer));
      }),
    );
    const observed: Observed = { paths: new Map(), unknown: new Set() };
    threads.forEach(([taskId], i) => {
      const p = paths[i];
      if (p) observed.paths.set(taskId, p);
      else observed.unknown.add(taskId);
    });
    return observed;
  }

  /** `inFlight` with the writers' changed paths already gathered: reads the store only, asks no node. */
  inFlightObserved(scope: WorkScope, paths: Map<TaskId, string[]>): WorkItem[] {
    return view.items({ ...this.sources(scope), observed: new Map(paths) });
  }

  /** The matches of `intent` with the writers' changed paths already gathered: reads the store only. */
  checkObserved(scope: WorkScope, intent: matcher.Work, paths: Map<TaskId, string[]>): WorkMatch[] {
    return matchesIn(this.inFlightObserved(scope, paths), intent, scope);
  }

  /** `inFlight` from the hub alone: no node is asked what its writers changed, so a writer carries no paths. */
  inFlightStored(scope: WorkScope): WorkItem[] {
    return view.items(this.sources(scope));
  }

  private sources(scope: WorkScope): view.Sources {
    const c = this.db.conn;
    const since = this.now() - EXPIRED_SHOWN_MS;
    const projects = store.projectsIn(c, scope);
    const tasks: Task[] = [];
    for (const project of projects) {
      // A project's tasks in its other repos land elsewhere.
      for (const task of TaskRecords.live(c, project, PROJECT_ROWS)) {
        if (store.sameScope(store.scopeOfTask(c, task), scope)) tasks.push(task);
      }
    }
    const claims = store.inScope(c, scope, since);
    const records = changeRecords(this.hub);
    const changes: Change[] = projects
      .flatMap((projectRef) => records.list({ projectRef, limit: PROJECT_ROWS }))
      .filter((ch) => onRepo(scope.repoKey, ch.repo) && !view.ENDED_CHANGE_STATES.includes(ch.state));
    const known = new Set(tasks.map((t) => t.taskId));
    const changeTasks = changes
      .flatMap((ch) => (ch.taskId !== undefined && !known.has(ch.taskId) ? [ch.taskId] : []))
      .flatMap((id) => {
        const stored = TaskRecords.get(c, id);
        return stored ? [stored.task] : [];
      });
    return { tasks, changes, changeTasks, claims, observed: new Map() };
  }

  private announceEnd(claim: Claim): void {
    const how = { landed: "landed", released: "was released", expired: "expired", active: "is active" }[claim.state];
    this.emit("work.ended", claim, `${claim.claimId} ${how}: ${claim.title}`);
  }

  private emit(type: HubEventType, claim: Claim, summary: string): void {
    const data: WorkEventData = {
      claimId: claim.claimId,
      repoKey: claim.repoKey,
      base: claim.base,
      ...(claim.projectRef ? { projectRef: claim.projectRef } : {}),
      ownerKind: claim.owner.kind,
      state: claim.state,
      ...(claim.end ? { reason: claim.end.reason } : {}),
      ...(claim.end?.landing !== undefined ? { landing: claim.end.landing } : {}),
    };
    events(this.hub).append({
      at: isoMs(this.now()),
      type,
      ...(claim.projectRef ? { machineId: claim.projectRef.machineId, projectId: claim.projectRef.projectId } : {}),
      summary: [...summary].slice(0, 200).join(""),
      data,
    });
  }
}

/** What `work.landed` says of a landing. */
export function landingEvent(l: Landing) {
  return {
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
  };
}

/** The hub's work ledger. */
export const work = (hub: Hub): Work => hub.area("work", (h) => new Work(h));
