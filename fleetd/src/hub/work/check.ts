// New work against the work in flight: the in-flight view's items become the
// matcher's candidates, and its matches come back as `WorkMatch`es with the item they name. Callers decide what each
// strength does: `work_claim` here, `spawn_agent` in the tasks.
//
// Owners: a task or Change is held by its project, as `<machineId>/<projectId>` (a lead's `ClaimOwner.keyId`), so a
// lead splitting its own item is not a duplicate; a claim by its owner's key. Expired claims match as weak only.
import type { MatchStrength, ProjectRef, WorkItem, WorkKey, WorkMatch } from "../../shared/contracts.ts";
import { type Candidate, declared, keysIn, type MatchKey, matches, readWork, type Scope, sameKey, Strength, type Work } from "./matcher.ts";
import type { WorkScope } from "./repo_key.ts";

/** Who holds a project's tasks and Changes, as the matcher compares owners: `<machineId>/<projectId>`. */
export const projectOwner = (project: ProjectRef) => `${project.machineId}/${project.projectId}`;

/** The matcher's scope for a work scope: its repo turns the repo's own PR and issue URLs into `#12`. */
export const matcherScope = (scope: WorkScope): Scope => ({ repo: scope.repoKey, base: scope.base });

/** A declared key as the matcher keys it: issues and PRs by the ref they are written as, branches as they are. */
export function matcherKeys(key: WorkKey, scope: Scope): MatchKey[] {
  if ("branch" in key) return [{ branch: key.branch }];
  const text = "issue" in key ? key.issue : key.pr;
  const keys = keysIn(text, scope);
  return keys.length > 0 ? keys : [{ ref: text }];
}

/** Adds each key not there yet as declared. */
export function addDeclared(work: Work, keys: MatchKey[]): void {
  for (const key of keys) if (!work.keys.some((k) => sameKey(k.key, key))) work.keys.push(declared(key));
}

const ownerOf = (item: WorkItem) => (item.owner ? item.owner.keyId : item.projectRef ? projectOwner(item.projectRef) : undefined);

function candidate(item: WorkItem, scope: Scope): Candidate {
  const work = readWork(ownerOf(item), item.title, "", scope);
  addDeclared(work, item.keys.flatMap((k) => matcherKeys(k, scope)));
  work.paths.push(...item.paths);
  return { id: item.id, work, weakOnly: item.kind === "claim" && item.state === "expired" };
}

const STRENGTH: Record<Strength, MatchStrength> = { [Strength.Weak]: "weak", [Strength.Strong]: "strong", [Strength.Exact]: "exact" };

/** The items `intent` may repeat, strongest first, weak ones included. Pure: its callers read the items. */
export function matchesIn(items: WorkItem[], intent: Work, scope: WorkScope): WorkMatch[] {
  const ms = matcherScope(scope);
  const byId = new Map<string, WorkItem>();
  for (const i of items) byId.set(i.id, i);
  return matches(intent, items.map((i) => candidate(i, ms)), ms).flatMap((m) => {
    const item = byId.get(m.id);
    return item ? [{ strength: STRENGTH[m.strength], why: m.why, item }] : [];
  });
}
