// "Merge, then verify"'s line: no batches. Each ready PR is rebased onto its base as the base is then, its own fast set
// runs, and it merges the moment that is green, while others do the same beside it: up to `ciAtOnce` PRs of a repo in
// CI at once (`.fleetd/train.json`, 4 by default). A PR that merges after another merged meanwhile lands if GitHub sees
// no conflict; what the two break only together, the base's own CI finds after the merge (verify.ts). A revert the
// train opened goes before any other PR.
import type { Change } from "../../shared/contracts.ts";
import * as batch from "./batch.ts";
import * as next from "./next.ts";
import { repoChecks } from "./repo_checks.ts";
import type { Train } from "./service.ts";
import { ciAtOnce } from "./settings.ts";

const FULL = "waiting for a free place in CI: ";
/** A PR GitHub refused to merge for being behind its base: it goes again, rebased, as no failed try. */
export const BEHIND = "another PR merged during its CI and its base requires it up to date, so it is rebased and tested again on ";
/** The line's own note on a ready PR it leaves waiting. */
export const lanesFull = (n: number) => `${FULL}${n === 1 ? "1 PR is" : `${n} PRs are`} in CI at once here, the most this repo allows`;

/** The Changes of each repo the train is working on in its line, by id. */
export class Lanes {
  private readonly busy = new Map<string, Set<string>>();

  of(repo: string): Set<string> {
    let set = this.busy.get(repo);
    if (!set) {
      set = new Set();
      this.busy.set(repo, set);
    }
    return set;
  }

  /** Whether the train works on any of the repo's Changes in its line now. */
  any(repo: string): boolean {
    return (this.busy.get(repo)?.size ?? 0) > 0;
  }

  private readonly running = new Set<Promise<void>>();

  /** Keeps `work`, one Change's place in the line, until it ends. */
  hold(work: Promise<void>): void {
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
  }

  /** Once every place in every line has ended, those started meanwhile too. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}

/** The ready Changes in the order the line takes them: the train's reverts first, the rest as they stand. */
export function lineOrder(t: Train, repo: string, ready: Change[]): Change[] {
  const reverts = ready.filter((c) => t.records.isRevert(repo, c.prNumber));
  return [...reverts, ...ready.filter((c) => !reverts.includes(c))];
}

/**
 * After refresh, in "Merge, then verify": each ready Change that has a free place goes on its own, not waited for
 * here (`start`); the others wait, saying why. True when it took or settled one.
 */
export async function laneNext(t: Train, repo: string): Promise<boolean> {
  const ready = t.records.inTrain(repo, ["reviewing", "ready"]).filter((c) => c.state === "ready" || batch.rereviewing(t, c));
  const busy = t.lanes.of(repo);
  const [cands, settled] = await batch.candidates(
    t,
    repo,
    lineOrder(t, repo, ready).filter((c) => !busy.has(c.changeId)),
  );
  next.pruneHeads(t, repo);
  let took = false;
  for (const c of cands) {
    const cap = ciAtOnce(await repoChecks(t, repo, c.pull.base.ref));
    if (busy.size >= cap) {
      waits(t, c.change, lanesFull(cap));
      continue;
    }
    waits(t, c.change, undefined);
    start(t, repo, c.change);
    took = true;
  }
  // The label stays on every PR in CI here; `take` puts it on each one it takes.
  const kept = [...busy].map((id) => t.records.get(id)?.prNumber).filter((n): n is number => n !== undefined);
  await next.relabel(t, repo, [], kept);
  return took || settled;
}

/** Shows `why` the ready Change waits (undefined: it doesn't), replacing only the line's own note. */
function waits(t: Train, change: Change, why: string | undefined): void {
  const shown = change.lastError;
  const ours = shown?.startsWith(FULL) ?? false;
  if (why === shown || (why === undefined && !ours)) return;
  if (why !== undefined && shown !== undefined && !ours) return;
  t.update(change.changeId, ["ready"], (c) => {
    const { lastError: _, ...rest } = c;
    return why === undefined ? rest : { ...rest, lastError: why };
  });
}

/** Takes the Change in its own place: its rebase, CI and merge run beside the repo's passes and the other places. */
export function start(t: Train, repo: string, change: Change, run: () => Promise<void> = () => t.take(change)): void {
  const busy = t.lanes.of(repo);
  busy.add(change.changeId);
  t.lanes.hold((async () => {
    try {
      await run();
    } catch (error) {
      console.warn(`train: ${change.changeId} failed in its place in the line:`, error);
      t.putBack(change, "the train hit an error working on it");
    } finally {
      busy.delete(change.changeId);
      t.kick(repo);
    }
  })());
}
