// A PR that landed in a batch never goes back on the train (W769). On 2026-11-21 the hub restarted for an update
// between batch #498's landing comment on one member and that member's close: the PR stayed open, its merged Change
// carried no "not closed" note for reconcile, and the writers' ready pass put the landed head on the train again.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mergeOf, targetOf } from "../src/hub/tasks/ci_wait.ts";
import { upstream } from "../src/hub/train/next.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import { httpError, Kit, PROJECT, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

/** PR 11's close (its PATCH to closed): `fail` answers it with an HTTP error, `hang` never answers it, as a hub gone. */
type Close = { fail: number; hang: boolean; reached?: () => void };

/** A kit whose PRs 11 and 12, writers' ready PRs, are green and ready, with PR 11's close as `close` says. */
async function batched(close: Close): Promise<Kit> {
  const wrap = (gh: GhRunner): GhRunner => ({
    run(args: string[]): Promise<GhOut> {
      const closing = args.includes("PATCH") && args.some((a) => a.endsWith("/pulls/11")) && args.includes("state=closed");
      if (closing && close.hang) {
        close.reached?.();
        return new Promise(() => {});
      }
      if (closing && close.fail > 0) {
        close.fail -= 1;
        return Promise.resolve(httpError(502, "Bad Gateway"));
      }
      return gh.run(args);
    },
  });
  const k = new Kit({}, wrap);
  kits.push(k);
  for (const [n, branch] of [
    [11, "fleetd/T11-one"],
    [12, "fleetd/T12-two"],
  ] as const) {
    k.pr(n, branch, { [`${n}.md`]: `${n}\n` });
    // A writer still at work: the ready pass looks at its open PR each pass.
    k.host.tasks.get(`T${n}`)!.state = "running";
    k.host.branches.set(`T${n}`, branch);
    await k.enqueue(n);
  }
  return k;
}

/** `n` passes of the train, a minute apart, whether or not they take anything. */
async function passes(k: Kit, n: number, train = k.train): Promise<void> {
  for (let i = 0; i < n; i++) {
    k.clock.ms += 61_000;
    await train.step(REPO);
  }
}

const landingComments = (k: Kit, n: number) => k.gh.pulls.get(n)!.comments.filter((c) => c.startsWith("Landed in #"));

test("a member whose close fails after its comment is closed on a later pass, commented once, and never queued again", async () => {
  const close: Close = { fail: 2, hang: false };
  const k = await batched(close);
  await k.settle();
  await passes(k, 3);
  const landed = k.change(11);
  expect(landed.state).toBe("merged");
  expect(k.change(12).state).toBe("merged");
  // Every pass tried its close again, until GitHub took it, with the comment that went out first.
  expect(close.fail).toBe(0);
  expect(k.gh.pulls.get(11)!.state).toBe("closed");
  expect(landingComments(k, 11)).toHaveLength(1);
  expect(landed.lastError).toBeUndefined();
  // No new Change of the landed head, and no review of it.
  expect(k.train.records.list({ repo: REPO, limit: 50 }).filter((c) => c.prNumber === 11).map((c) => c.changeId)).toEqual([landed.changeId]);
  expect(k.gate.reviewed.filter((id) => id === landed.changeId)).toHaveLength(1);
});

test("a hub gone between a member's landing comment and its close: the restarted train closes it and queues nothing", async () => {
  let reached!: () => void;
  const atClose = new Promise<void>((r) => (reached = r));
  const close: Close = { fail: 0, hang: true, reached };
  const k = await batched(close);
  // The pass lands the batch, comments on PR 11 and never hears back from its close: the hub restarts there.
  void k.settle();
  await atClose;
  expect(landingComments(k, 11)).toHaveLength(1);
  expect(k.gh.pulls.get(11)!.state).toBe("open");
  close.hang = false;
  const train = k.restarted();
  const reviewed = k.gate.reviewed.length;
  await passes(k, 5, train);
  // PR 12 is finished by the restart's recovery, PR 11 by reconcile: both closed, each commented once.
  expect(k.gh.pulls.get(11)!.state).toBe("closed");
  expect(k.gh.pulls.get(12)!.state).toBe("closed");
  expect(landingComments(k, 11)).toHaveLength(1);
  expect(landingComments(k, 12)).toHaveLength(1);
  const changes = train.records.list({ repo: REPO, limit: 50 });
  expect(changes.map((c) => [c.prNumber, c.state]).sort()).toEqual([
    [11, "merged"],
    [12, "merged"],
  ]);
  expect(k.gate.reviewed.length).toBe(reviewed);
  expect(k.host.eventsOf("change.queued")).toHaveLength(2);
});

test("an open PR whose head already landed is refused at intake, and a new push to it is new work", async () => {
  // Its close keeps failing: the PR stays open at the head that landed.
  const k = await batched({ fail: 1_000, hang: false });
  await k.settle();
  await passes(k, 2);
  const landed = k.change(11);
  expect(landed.state).toBe("merged");
  expect(k.gh.pulls.get(11)!.state).toBe("open");
  await expect(k.enqueue(11)).rejects.toMatchObject({
    message: `The train refused https://github.com/${REPO}/pull/11: Its head ${landed.headSha.slice(0, 12)} already landed as ${landed.changeId} (${landed.mergedSha!.slice(0, 12)}), so nothing of it is left to merge; the train closes it.`,
    fix: "nothing for this head; push new commits to the PR for new work",
  });
  // No refused Change either: the landed one stays the PR's newest.
  expect(k.change(11).changeId).toBe(landed.changeId);

  // The writer pushes again: its new head goes on the train as new work.
  k.pr(11, "fleetd/T11-one", { "more.md": "more\n" });
  const again = await k.enqueue(11);
  expect(again.changeId).not.toBe(landed.changeId);
  expect(again.headSha).not.toBe(landed.headSha);
  expect(["reviewing", "ready"]).toContain(again.state);
});

test("a wait for a batched PR to merge ends when the batch lands, also while its close fails", async () => {
  const k = await batched({ fail: 1_000, hang: false });
  const url = `https://github.com/${REPO}/pull/11`;
  const merges = { upstream: (u: string) => upstream(k.train, u) };
  expect(await mergeOf(merges, PROJECT, targetOf(url)!)).toEqual({ kind: "pending" });
  await k.settle();
  expect(k.gh.pulls.get(11)!.state).toBe("open");
  expect(k.change(11).lastError).toStartWith("landed, but its PR is not closed yet: GitHub: ");
  expect(await mergeOf(merges, PROJECT, targetOf(url)!)).toEqual({ kind: "merged" });
  // Later passes take nothing of it again, so the wait's answer stays merged.
  await passes(k, 3);
  expect(await mergeOf(merges, PROJECT, targetOf(url)!)).toEqual({ kind: "merged" });
});
