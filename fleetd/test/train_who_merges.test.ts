// Who merges a bot's PRs, as the train enforces it: where people merge, a PR is reviewed and kept up to date but never
// merged, with no `hold` label; the lead hears once per reviewed green patch; a merge on GitHub is recorded; a PR whose
// every file matches a merges-itself rule merges all the same, and one touching an always-a-person rule never does.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { trainFacts } from "../src/hub/train/digest.ts";
import { leadTrainLines, PEOPLE_MERGE_LINE } from "../src/hub/train/digest_lines.ts";
import { DEFAULT_RISK_RULES } from "../src/hub/train/merge_rules.ts";
import { changeNext, PEOPLE } from "../src/hub/train/notes.ts";
import { git, Kit, REPO, WS } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

/** A kit whose bot people merge, by the default risk rules. */
const peopleKit = () => {
  const k = new Kit();
  kits.push(k);
  k.host.who = { merges: "people", rules: DEFAULT_RISK_RULES };
  return k;
};

const merges = (k: Kit) => k.gh.log.filter((l) => l.startsWith("merge #"));
const pushes = (k: Kit) => k.gh.log.filter((l) => /^(rebase|update) #/.test(l));
const wakesWith = (k: Kit, words: string) => k.host.wakes.filter((w) => w.includes(words));
const digest = (k: Kit, peopleMerge: boolean) => leadTrainLines({ ...trainFacts(k.train.records, () => true), peopleMerge }).join("\n");

/** `n` passes of the train a minute apart, whether it takes anything or not. */
async function passes(k: Kit, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    k.clock.ms += 61_000;
    await k.train.step(REPO);
  }
}

test("where people merge, a PR with no label is reviewed, never merged, and the lead hears once per reviewed green patch", async () => {
  const k = peopleKit();
  k.pr(51, "fleetd/T51-x", { "src/x.ts": "export const x = 1;\n" });
  const enqueued = await k.enqueue(51);
  expect(changeNext(enqueued, k.train.peopleMerge(enqueued))).toContain("people merge this bot's PRs");
  await passes(k, 8);
  expect(k.gate.reviewed).toContain(k.change(51).changeId);
  expect(k.change(51)).toMatchObject({ state: "ready", lastError: PEOPLE });
  expect(k.change(51).mergeRule).toBe("waits for a person: people merge this bot's PRs, and src/x.ts matches no merges-itself rule");
  expect(merges(k)).toEqual([]);
  const told = () => wakesWith(k, "reviewed and green");
  expect(told().length).toBe(1);
  expect(told()[0]).toContain("ready for a person to merge on GitHub");
  expect(told()[0]).toContain("pull/51");
  expect(digest(k, true)).toContain(PEOPLE_MERGE_LINE);
  expect(digest(k, true)).toContain(`${k.change(51).changeId} reviewed, for a person to merge`);
  expect(digest(k, true).replace(PEOPLE_MERGE_LINE, "")).not.toContain("queued to merge");
  // More passes and a restart say nothing more.
  const again = k.restarted();
  for (let i = 0; i < 3; i++) {
    k.clock.ms += 61_000;
    await again.step(REPO);
  }
  expect(told().length).toBe(1);
  // Its author pushes a new patch: reviewed again, and said again once.
  git(k.clone, ["checkout", "-q", "fleetd/T51-x"]);
  writeFileSync(join(k.clone, "src/x.ts"), "export const x = 2;\n");
  git(k.clone, ["commit", "-q", "-am", "more"]);
  git(k.clone, ["push", "-q", "origin", "fleetd/T51-x:fleetd/T51-x"]);
  for (let i = 0; i < 6; i++) {
    k.clock.ms += 61_000;
    await again.step(REPO);
  }
  expect(told().length).toBe(2);
  expect(merges(k)).toEqual([]);
});

test("where people merge, a waiting PR is kept up to date with main, and a merge on GitHub is recorded", async () => {
  const k = peopleKit();
  k.pr(52, "fleetd/T52-x", { "src/y.ts": "y\n" });
  await k.enqueue(52);
  await passes(k, 3);
  k.commitMain({ "one.md": "1\n" });
  await passes(k, 3);
  expect(pushes(k)).toEqual(["rebase #52"]);
  expect(merges(k)).toEqual([]);
  Object.assign(k.gh.pulls.get(52)!, { state: "closed", merged: true, mergedAt: new Date(k.clock.ms + 60_000).toISOString(), mergeSha: "e".repeat(40) });
  await passes(k, 2);
  // A person's merge counts as merged: the Change, its order and Factory see it land, and the lead isn't told it left.
  expect(k.change(52)).toMatchObject({ state: "merged", mergedSha: "e".repeat(40), byHand: true });
  expect(k.change(52).lastError).toBeUndefined();
  expect(k.host.eventsOf("pr.merged")).toMatchObject([
    { repo: REPO, prNumber: 52, workstreamId: WS, mergedSha: "e".repeat(40), byHand: true, mergedBy: "ada-lovelace", mergedByKind: "human", base: "main" },
  ]);
  expect(wakesWith(k, "left the train")).toEqual([]);
  // The PRs behind it carry on: the next one waits for a person too, and is told once.
  k.pr(53, "fleetd/T53-x", { "src/z.ts": "z\n" });
  await k.enqueue(53);
  await passes(k, 6);
  expect(k.change(53).state).toBe("ready");
  expect(wakesWith(k, "pull/53").filter((w) => w.includes("reviewed and green")).length).toBe(1);
  expect(merges(k)).toEqual([]);
});

test("where people merge, a docs-only PR merges itself, and the PR says by which rule", async () => {
  const k = peopleKit();
  k.pr(54, "fleetd/T54-x", { "docs/guide.md": "# Guide\n", "README.md": "hello\n" });
  await k.enqueue(54);
  await k.settle();
  expect(k.change(54).state).toBe("merged");
  expect(k.change(54).mergeRule).toBe("merges itself: every file matches the merges-itself rule docs");
  expect(wakesWith(k, "reviewed and green")).toEqual([]);
});

test("where people merge, a PR touching a migration always waits for a person, even beside docs", async () => {
  const k = peopleKit();
  k.pr(55, "fleetd/T55-x", { "docs/a.md": "a\n", "db/migrations/0002_add.sql": "-- add\n" });
  await k.enqueue(55);
  await passes(k, 8);
  expect(k.change(55)).toMatchObject({ state: "ready", lastError: PEOPLE });
  expect(k.change(55).mergeRule).toBe("waits for a person: db/migrations/0002_add.sql matches the always-a-person rule migrations");
  expect(merges(k)).toEqual([]);
});

test("a PR waiting for a person takes no place in the merge line, and the PRs behind it count without it", async () => {
  const k = peopleKit();
  k.pr(61, "fleetd/T61-x", { "src/a.ts": "a\n" });
  await k.enqueue(61);
  await passes(k, 8);
  expect(k.change(61)).toMatchObject({ state: "ready", lastError: PEOPLE });
  k.pr(62, "fleetd/T62-x", { "src/b.ts": "b\n" });
  await k.enqueue(62);
  const placed = new Map(k.train.list({ repo: REPO, limit: 10 }).map((c) => [c.prNumber, c.position]));
  expect(placed.get(61)).toBeUndefined();
  expect(placed.get(62)).toBe(0);
  expect(k.train.records.inLine(REPO).map((c) => c.prNumber)).toEqual([62]);
  // The lead's train line still names it, as waiting for a person.
  expect(k.train.records.trainState(REPO).queue).toContain(k.change(61).changeId);
});

test("switching a bot to fleetd merges lets its waiting PR go, and back to people holds the next one", async () => {
  const k = peopleKit();
  k.pr(56, "fleetd/T56-x", { "src/a.ts": "a\n" });
  await k.enqueue(56);
  await passes(k, 6);
  expect(k.change(56).state).toBe("ready");
  k.host.who = { merges: "fleetd", rules: DEFAULT_RISK_RULES };
  await k.settle();
  expect(k.change(56).state).toBe("merged");
  expect(k.change(56).mergeRule).toBeUndefined();
});

test("a PR that turned people-merged while in CI isn't merged at the end of its CI", async () => {
  const k = new Kit();
  kits.push(k);
  k.pr(57, "fleetd/T57-x", { "src/a.ts": "a\n" });
  await k.enqueue(57);
  // Into CI as a fleetd bot's PR; the person switches the bot to people merging while its CI runs.
  k.gh.runs = () => {
    if (k.change(57)?.state === "ci") k.host.who = { merges: "people", rules: DEFAULT_RISK_RULES };
    return [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: `https://github.com/${REPO}/actions/runs/1` }];
  };
  await passes(k, 6);
  expect(merges(k)).toEqual([]);
  expect(k.change(57)).toMatchObject({ state: "ready", lastError: PEOPLE });
});

test("the hold label still holds a PR of a bot fleetd merges", async () => {
  const k = new Kit();
  kits.push(k);
  k.pr(58, "fleetd/T58-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(58);
  await k.settle();
  expect(k.change(58)).toMatchObject({ state: "ready", lastError: "held: the PR has the `hold` label; the train takes it once the label is gone" });
  expect(digest(k, false)).not.toContain(PEOPLE_MERGE_LINE);
});
