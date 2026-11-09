// work_claim, work_list and work_done (crates/fleetd/src/hub/work/tools.rs): the work ledger for sessions fleetd
// doesn't run (a person's own Claude Code, or the `fleetd work` CLI). A claim is checked against the work in flight
// before it is stored: an exact match (someone else's issue, PR, branch or item) refuses it, and only a person's session
// may claim it `anyway`, so a lead or an agent never overrides a person's claim; a strong match refuses it once, until
// `notDuplicateOf` names it with a reason; weak matches are only listed.
import type {
  Claim,
  ClaimObserved,
  ClaimOwner,
  ProjectRef,
  RecentLanding,
  WorkClaimInput,
  WorkClaimOutput,
  WorkClaimStatus,
  WorkItem,
  WorkKey,
  WorkListInput,
  WorkListOutput,
  WorkMatch,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman, readable, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { cap, unknownProject } from "../api/refusals.ts";
import { mayUse, others, type Refs } from "../navi/owner.ts";
import { store as hubStore } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { bindWith, type NodeGit, nodeGit, within } from "./bind.ts";
import { addDeclared, matcherKeys, matcherScope, matchesIn } from "./check.ts";
import type { Landed } from "./elsewhere.ts";
import { type NewClaim, type Work, work } from "./index.ts";
import { declared, readWork, type Work as Intent } from "./matcher.ts";
import { repoKeyOf } from "./repo_key.ts";
import { basesOf, inScope, getClaim, putClaim, type WorkScope } from "./store.ts";
import * as view from "./view.ts";
import { isLine, keyEquals } from "./view.ts";

/** Matches a claim's answer shows. */
const MATCHES_MAX = 10;
/** Items work_list shows. */
const ITEMS_MAX = 100;
/** Landings outside the train work_list shows. */
const LANDINGS_MAX = 10;
/** The base when nothing says otherwise. */
const DEFAULT_BASE = "main";
/** How long a call waits on the nodes to read unbound projects' remotes before it answers without them. */
const BIND_WAIT_MS = 3000;

export function register(tools: Registry): void {
  tools.add("work_claim", (hub, caller, input) => claimOn(hub, caller, input, nodeGit(hub)));
  tools.add("work_list", (hub, caller, input) => listOn(hub, caller, input, nodeGit(hub)));
  tools.add("work_done", (hub, caller, input) => {
    const id = input.claimId;
    const notFound = () => new ToolError("not_found", `There is no claim ${id}.`, "work_list lists the claims in flight.");
    const claim = work(hub).get(id);
    if (!claim) throw notFound();
    if (claim.projectRef && (!readable(caller, claim.projectRef.machineId) || !mayUse(hub.db, caller, claim.projectRef))) throw notFound();
    if (claim.owner.keyId !== caller.keyId && !isHuman(caller)) {
      throw new ToolError("forbidden", `${id} is held by another key.`, "Only its owner, or a person's human key, can end it.");
    }
    if (claim.state !== "active") {
      throw new ToolError("invalid", `${id} has already ended: ${claim.state}.`, "Nothing to do; work_claim makes a new one.");
    }
    const [ending, said] = input.outcome === "landed" ? (["landed", "landed"] as const) : (["released", "dropped"] as const);
    const ended = work(hub).end(id, ending, input.reason ?? `${said} (work_done)`, input.landing);
    if (!ended) throw new ToolError("invalid", `${id} has already ended.`, "Nothing to do; work_claim makes a new one.");
    return { claim: ended };
  });
}

/** The contracts' `checked!` rules on work_claim's and work_list's input, with their words. */
function checkInput(input: { repo?: string; projectRef?: ProjectRef; notDuplicateOf?: string[]; notDuplicateWhy?: string }): void {
  if (input.repo === undefined && input.projectRef === undefined) throw new ToolError("invalid", "give repo (its origin remote) or projectRef");
  if (input.notDuplicateOf !== undefined && input.notDuplicateWhy === undefined) {
    throw new ToolError("invalid", "notDuplicateOf needs notDuplicateWhy: one line on why it is different work");
  }
}

/**
 * Binds every project on the caller's machines that has no repo and base recorded yet, reading each from its
 * checkout. It waits at most BIND_WAIT_MS; the rest are read on a later call.
 */
async function bindUnbound(hub: Hub, caller: Caller, node: NodeGit): Promise<void> {
  const unbound = hubStore(hub)
    .projectsList()
    .filter((p) => readable(caller, p.machineId) && !work(hub).scopeOf({ machineId: p.machineId, projectId: p.projectId }));
  const binds = Promise.all(unbound.map((p) => bindWith(hub, node, { machineId: p.machineId, projectId: p.projectId }, p.workspaceRoot)));
  await within(binds, BIND_WAIT_MS);
}

const repoBound = (hub: Hub, repoKey: string) => basesOf(hub.db.conn, repoKey).length > 0;

/**
 * The scope a call names: its repo (any remote form), else its project's. The base is the one given, else the
 * project's, else that of a project on the repo, else "main". A repo no project is bound to has the caller's unbound
 * projects read first; when still none is, the answer's warning says the agents' work may be missing.
 */
async function scopeFor(
  hub: Hub,
  caller: Caller,
  node: NodeGit,
  repo: string | undefined,
  project: ProjectRef | undefined,
  base: string | undefined,
): Promise<[WorkScope, string | undefined]> {
  let bound: WorkScope | undefined;
  if (project) {
    requireRole(caller, "read", project.machineId);
    const summary = hubStore(hub).projectGet(project);
    if (!summary) throw unknownProject(project);
    bound = work(hub).scopeOf(project) ?? (await bindWith(hub, node, project, summary.workspaceRoot));
  }
  let repoKey: string;
  if (repo !== undefined) {
    const key = repoKeyOf(repo);
    if (key === undefined) throw new ToolError("invalid", `'${repo}' is not a git remote.`, "Pass the repo's origin URL: git remote get-url origin.");
    repoKey = key;
  } else if (bound) repoKey = bound.repoKey;
  else {
    const r = project!;
    throw new ToolError("invalid", `${r.machineId}/${r.projectId} has no repo bound yet.`, "Pass repo (its origin URL) instead.");
  }
  let warning: string | undefined;
  if (!repoBound(hub, repoKey)) {
    await bindUnbound(hub, caller, node);
    if (!repoBound(hub, repoKey)) warning = `no project bound to ${repoKey} yet; agents' work may be missing`;
  }
  const chosen =
    base ?? (bound && bound.repoKey === repoKey ? bound.base : (basesOf(hub.db.conn, repoKey).find((b) => isLine(b, 250)) ?? DEFAULT_BASE));
  return [{ repoKey, base: chosen }, warning];
}

/**
 * A person's own session only with a human key. Any other key may be a fleetd agent that loaded the person's MCP
 * config, so its claims are an agent key's, and it never claims taken work.
 */
function ownerOf(caller: Caller): ClaimOwner {
  const label = [...caller.name].slice(0, 120).join("");
  return {
    kind: isHuman(caller) ? "human_session" : "agent_key",
    keyId: isLine(caller.keyId, 200) ? caller.keyId : [...caller.keyId].slice(0, 200).join(""),
    ...(isLine(label, 120) ? { label } : {}),
  };
}

/** Items on machines the key can't read, and those of another person's Only me project, are left out of what it is shown. */
const visible = (caller: Caller, navis: Refs, item: WorkItem) =>
  !item.projectRef || (readable(caller, item.projectRef.machineId) && !navis.has(item.projectRef));

const isMine = (caller: Caller, item: WorkItem) => item.owner?.keyId === caller.keyId;

/** "T12 (an agent of devbox/shop): dark mode toggle". */
export function describe(item: WorkItem): string {
  const project = item.projectRef ? `${item.projectRef.machineId}/${item.projectRef.projectId}` : "";
  let who: string;
  if (item.kind === "task") who = `an agent of ${project}`;
  else if (item.kind === "change") who = `a PR on ${project}'s merge train`;
  else if (item.kind === "claim" && item.owner) {
    const name = item.owner.label ?? item.owner.keyId;
    who = item.owner.kind === "human_session" ? `${name}'s session` : item.owner.kind === "agent_key" ? `a session on key ${name}` : `the lead of ${name}`;
  } else if (item.kind === "claim") who = "a claim";
  else who = "an open PR";
  return `${item.id} (${who}${item.state === "expired" ? ", expired" : ""}): ${item.title}`;
}

/** What the claim is, as the matcher reads it: its title's own keys and paths, and the ones declared. */
function intentOf(owner: ClaimOwner, input: WorkClaimInput, scope: WorkScope): Intent {
  const ms = matcherScope(scope);
  const intent = readWork(owner.keyId, input.title, "", ms);
  const keys: WorkKey[] = [...(input.keys ?? []), ...(input.branch !== undefined ? [{ branch: input.branch }] : [])];
  addDeclared(intent, keys.flatMap((k) => matcherKeys(k, ms)));
  intent.paths.push(...(input.paths ?? []), ...(input.changed ?? []));
  return intent;
}

function observedOf(input: WorkClaimInput, now: number): ClaimObserved | undefined {
  if (!input.changed) return undefined;
  return { paths: input.changed, ...(input.headSha !== undefined ? { headSha: input.headSha } : {}), at: isoMs(now) };
}

/** The owner's active claim in the scope on the same branch (or, with no branch, the same title). */
function ownClaim(hub: Hub, scope: WorkScope, owner: ClaimOwner, branch: string | undefined, title: string): Claim | undefined {
  return inScope(hub.db.conn, scope, Number.MAX_SAFE_INTEGER).find(
    (c) =>
      c.state === "active" &&
      c.owner.keyId === owner.keyId &&
      (branch !== undefined ? c.branch === branch : c.branch === undefined && asciiLower(c.title) === asciiLower(title)),
  );
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Renews the claim and replaces what it says with `next`'s; the observed paths only when given. */
function revise(hub: Hub, w: Work, claimId: string, next: NewClaim, observed: ClaimObserved | undefined): Claim | undefined {
  if (!w.renew(claimId, observed)) return undefined;
  return hub.db.transaction((c) => {
    const claim = getClaim(c, claimId);
    if (!claim) return undefined;
    const out: Claim = {
      ...claim,
      title: next.title,
      keys: next.keys,
      paths: next.paths,
      ...(next.authorEmail !== undefined ? { authorEmail: next.authorEmail } : {}),
      ...(next.projectRef ? { projectRef: next.projectRef } : {}),
    };
    putClaim(c, out);
    return out;
  });
}

/** `items` with its claims replaced by `claims`, as read where the claim is saved. */
const withClaims = (items: WorkItem[], claims: Claim[]): WorkItem[] => [
  ...items.filter((i) => i.kind !== "claim"),
  ...view.items({ ...view.emptySources(), claims }),
];

/** work_claim, reading unbound projects through `node`. */
export async function claimOn(hub: Hub, caller: Caller, input: WorkClaimInput, node: NodeGit): Promise<WorkClaimOutput> {
  checkInput(input);
  if (input.projectRef) requireRole(caller, "operate", input.projectRef.machineId);
  const [scope, warning] = await scopeFor(hub, caller, node, input.repo, input.projectRef, input.base);
  // Reading the view asks each writer's node for its paths, which takes a while; `settle` reads the claims again
  // where it saves the claim.
  const items = await work(hub).inFlight(scope);
  const out = settle(hub, caller, input, scope, items);
  return warning !== undefined ? { ...out, warning } : out;
}

type Refusal = { refused: WorkClaimOutput };

/** What `found` says about the claim: go ahead, with a note for `work.claimed` when it overrides one; or the answer that refuses it. */
function decide(caller: Caller, navis: Refs, person: boolean, input: WorkClaimInput, found: WorkMatch[]): { note?: string } | Refusal {
  const theirs = found.filter((m) => !isMine(caller, m.item));
  const nameOf = (m: WorkMatch) => (visible(caller, navis, m.item) ? describe(m.item) : `${m.item.id} (on a machine or project this key can't read)`);
  const refuse = (status: WorkClaimStatus, message: string, next: string): Refusal => ({
    refused: answer(caller, navis, found, status, undefined, message, next),
  });
  const exact = theirs.find((m) => m.strength === "exact");
  if (exact) {
    const held = nameOf(exact);
    if (person && input.anyway === true) return { note: `anyway, though ${exact.item.id} holds it: ${exact.why}` };
    const next = person
      ? `Tell the user before going on: ${held}. To claim it anyway, call again with anyway: true.`
      : `Tell the user before going on: ${held}. Only a person can claim taken work, with a human key: \`fleetd work claim --anyway\`.`;
    return refuse("taken", `taken by ${held} (${exact.why})`, next);
  }
  const acknowledged = input.notDuplicateOf;
  const unacknowledged = theirs.filter((m) => m.strength === "strong" && !(acknowledged ?? []).includes(m.item.id));
  const first = unacknowledged[0];
  if (first) {
    const ids = unacknowledged.map((m) => `"${m.item.id}"`);
    return refuse(
      "possible_duplicate",
      `may repeat ${nameOf(first)} (${first.why})`,
      `Tell the user before going on. If it is different work, call again with notDuplicateOf: [${ids.join(", ")}] and notDuplicateWhy.`,
    );
  }
  if (acknowledged && input.notDuplicateWhy !== undefined) return { note: `not a duplicate of ${acknowledged.join(", ")}: ${input.notDuplicateWhy}` };
  return {};
}

/** The answer, with the matches the caller may see (not its own), strongest first. */
function answer(
  caller: Caller,
  navis: Refs,
  found: WorkMatch[],
  status: WorkClaimStatus,
  claim: Claim | undefined,
  message: string,
  next: string,
): WorkClaimOutput {
  const shown = cap(
    found.filter((m) => visible(caller, navis, m.item) && !isMine(caller, m.item)),
    MATCHES_MAX,
  );
  return {
    status,
    ...(claim ? { claim } : {}),
    matches: shown.items,
    message,
    next,
    ...(shown.truncated ? { truncated: true } : {}),
  };
}

/**
 * Decides the claim against the work in flight (`items`, read before) and saves it. The claims are read again in the
 * transaction that saves it, and the decision is made again on them, so two claims made at once can't both pass.
 */
export function settle(hub: Hub, caller: Caller, input: WorkClaimInput, scope: WorkScope, items: WorkItem[]): WorkClaimOutput {
  const owner = ownerOf(caller);
  const person = owner.kind === "human_session";
  const navis = others(hub.db, caller);
  const w = work(hub);
  const intent = intentOf(owner, input, scope);
  const now = hub.clock.now();
  const next: NewClaim = {
    scope,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    owner,
    title: input.title,
    keys: input.keys ?? [],
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    paths: input.paths ?? [],
    ...(input.authorEmail !== undefined ? { authorEmail: input.authorEmail } : {}),
  };
  const found = matchesIn(items, intent, scope);
  const nextDone = (id: string) => `Call work_done with claimId ${id} when it lands or you drop it.`;

  // A fleetd agent on its own task's branch: the task is the claim, so there is nothing to add or refuse.
  if (!person && input.branch !== undefined) {
    const branch = input.branch;
    const task = items.find((i) => (i.kind === "task" || i.kind === "change") && i.keys.some((k) => keyEquals(k, { branch })));
    if (task) {
      const id = task.taskId ?? task.id;
      return answer(
        caller,
        navis,
        found.filter((m) => m.item.id !== task.id),
        "yours",
        undefined,
        `yours (task ${id})`,
        `Nothing to claim: fleetd tracks ${branch} as task ${id}. Go on with it; work_claim is for work fleetd doesn't track yet.`,
      );
    }
  }

  // The caller's own claim on this branch is the same work: renewed and updated, never claimed twice. Keys and paths
  // the renewal adds are checked as a new claim's would be: adding an issue someone else holds is taken.
  const own = ownClaim(hub, scope, owner, input.branch, input.title);
  if (own) {
    const addedKeys = next.keys.filter((k) => !own.keys.some((o) => keyEquals(o, k)));
    const addedPaths = next.paths.filter((p) => !own.paths.includes(p));
    if (addedKeys.length > 0 || addedPaths.length > 0) {
      const ms = matcherScope(scope);
      const added: Intent = { owner: owner.keyId, title: "", keys: addedKeys.flatMap((k) => matcherKeys(k, ms)).map(declared), paths: addedPaths };
      const decided = decide(caller, navis, person, input, matchesIn(items, added, scope));
      if ("refused" in decided) return decided.refused;
    }
    const claim = revise(hub, w, own.claimId, next, observedOf(input, now)) ?? own;
    return answer(caller, navis, found, "renewed", claim, `renewed ${claim.claimId}`, nextDone(claim.claimId));
  }
  const decided = decide(caller, navis, person, input, found);
  if ("refused" in decided) return decided.refused;
  const saved = w.claimIf(next, observedOf(input, now), (claims) => {
    const again = matchesIn(withClaims(items, claims), intent, scope);
    const d = decide(caller, navis, person, input, again);
    if ("refused" in d) return d;
    return { ok: [d.note, { note: d.note, found: again }] as const };
  });
  if ("refused" in saved) return saved.refused;
  const id = saved.claim.claimId;
  const message = saved.out.note !== undefined ? `claimed ${id} (${saved.out.note})` : `claimed ${id}`;
  return answer(caller, navis, saved.out.found, "claimed", saved.claim, message, nextDone(id));
}

/** work_list, reading unbound projects through `node`. */
export async function listOn(hub: Hub, caller: Caller, input: WorkListInput, node: NodeGit): Promise<WorkListOutput> {
  checkInput(input);
  const [scope, warning] = await scopeFor(hub, caller, node, input.repo, input.projectRef, input.base);
  const w = work(hub);
  const all = input.paths === false ? w.inFlightStored(scope) : await w.inFlight(scope);
  const navis = others(hub.db, caller);
  const items = cap(
    all.filter((i) => visible(caller, navis, i)),
    ITEMS_MAX,
  );
  const next =
    items.items.length === 0
      ? "Nothing is in flight here. Before a code change, call work_claim with a one-line title."
      : "Before a code change, call work_claim: it checks against these and claims in one call.";
  return {
    scope,
    items: items.items,
    ...(warning !== undefined ? { warning } : {}),
    recentLandings: w.outsideLandings(scope, LANDINGS_MAX).map(recentLanding),
    next,
    ...(items.truncated ? { truncated: true } : {}),
  };
}

function recentLanding(l: Landed): RecentLanding {
  return {
    sha: l.sha,
    at: isoMs(l.atMs),
    route: l.route,
    ...(l.pr !== undefined ? { pr: l.pr } : {}),
    subject: l.subject,
    ...(l.authorEmail !== undefined ? { authorEmail: l.authorEmail } : {}),
    covers: l.covers,
  };
}
