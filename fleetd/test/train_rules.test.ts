// The train under the repo's own GitHub rules, over the fake GitHub of train_kit.ts: a required approval waits, PRs
// into such a base merge one at a time, the merge method the repo allows, CI from any provider, and a PR a person
// merges (the `hold` label). First, what must not change for a repo with one required check and squash merges.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

const kit = (...a: ConstructorParameters<typeof Kit>) => {
  const k = new Kit(...a);
  kits.push(k);
  return k;
};

/** The GraphQL queries the train sent that read `field`. */
const asked = (k: Kit, field: string) => k.gh.calls.filter((c) => c.includes("graphql") && c.some((a) => a.includes(field)));
const merges = (k: Kit) => k.gh.log.filter((l) => l.startsWith("merge #"));

test("one required check, no approval, squash on: nine ready PRs go as a batch of eight, squash-merged, no PR's reviews read", async () => {
  const k = kit();
  k.gh.required = ["ci"];
  for (let n = 1; n <= 9; n++) k.pr(n, `fleetd/T${n}-x`, { [`f${n}.md`]: `${n}\n` });
  for (let n = 1; n <= 9; n++) await k.enqueue(n);
  await k.settle(4);
  const batch = [...k.gh.pulls].find(([, p]) => p.branch === "fleetd/train/batch");
  expect(batch).toBeDefined();
  expect(batch![1].title.split(";").length).toBe(8);
  expect(merges(k)[0]).toBe(`merge #${batch![0]}`);
  await k.settle(10);
  for (let n = 1; n <= 9; n++) expect(k.change(n).state).toBe("merged");
  // Every merge a squash, and no branch updated by a merge of the base.
  expect(merges(k).every((l) => /^merge #\d+$/.test(l))).toBe(true);
  expect(k.gh.log.some((l) => l.startsWith("update #"))).toBe(false);
  expect(asked(k, "reviewDecision")).toEqual([]);
});

test("a batch member sent back to review while the batch's CI runs does not land with it", async () => {
  const k = kit();
  k.pr(11, "fleetd/T11-one", { "one.md": "1\n" });
  k.pr(12, "fleetd/T12-two", { "two.md": "2\n" });
  await k.enqueue(11);
  await k.enqueue(12);
  let sent = false;
  k.gh.runs = (sha) => {
    // The batch's head is in CI: a person's review sends PR 12 back.
    if (!sent && sha === k.gh.headOf("fleetd/train/batch")) {
      sent = true;
      k.gate.blocking.add(k.change(12).changeId);
      k.train.toReview(k.change(12));
    }
    return [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: `https://github.com/${REPO}/actions/runs/1` }];
  };
  await k.settle();
  expect(sent).toBe(true);
  expect(k.change(12).state).toBe("reviewing");
  expect(k.gh.pulls.get(12)!.state).toBe("open");
  expect(k.mainLog().some((l) => l.includes("PR 12"))).toBe(false);
  expect(k.change(11).state).toBe("merged");
});

test("a PR with the hold label is reviewed, never merged by the train, and a merge by hand is recorded", async () => {
  const k = kit();
  k.pr(19, "fleetd/T19-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(19);
  await k.settle();
  expect(k.gate.reviewed).toContain(k.change(19).changeId);
  expect(k.change(19).state).toBe("ready");
  expect(k.change(19).reviews.length).toBe(1);
  expect(merges(k)).toEqual([]);
  // A person merges it on GitHub.
  Object.assign(k.gh.pulls.get(19)!, { state: "closed", merged: true, mergedAt: new Date(k.clock.ms + 60_000).toISOString(), mergeSha: "e".repeat(40) });
  k.clock.ms += 2 * 60_000;
  await k.train.step(REPO);
  k.clock.ms += 2 * 60_000;
  await k.train.step(REPO);
  expect(k.change(19)).toMatchObject({ state: "abandoned", lastError: "was merged outside the train" });
  expect(k.host.eventsOf("pr.merged_outside")).toMatchObject([{ repo: REPO, prNumber: 19, base: "main" }]);
  expect(merges(k)).toEqual([]);
});
