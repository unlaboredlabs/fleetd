// The train under the repo's own GitHub rules, over the fake GitHub of train_kit.ts: a required approval waits, PRs
// into such a base merge one at a time, the merge method the repo allows, CI from any provider, and a PR a person
// merges (the `hold` label). First, what must not change for a repo with one required check and squash merges.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { queue } from "../src/hub/prs/join.ts";
import { leadTrainLines, trainFacts } from "../src/hub/train/digest.ts";
import { rulesFromAnswers } from "../src/hub/train/github.ts";
import { APPROVAL } from "../src/hub/train/person.ts";
import { Fast, oneLine, ruleRefusal, statusRuns } from "../src/hub/train/rules.ts";
import { git, httpError, Kit, REPO } from "./train_kit.ts";

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

/** `n` passes of the train a minute apart, whether it takes anything or not. */
async function passes(k: Kit, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    k.clock.ms += 61_000;
    await k.train.step(REPO);
  }
}

const mergeCalls = (k: Kit) => k.gh.calls.filter((c) => c.some((a) => a.endsWith("/merge")));
const pushes = (k: Kit) => k.gh.log.filter((l) => /^(rebase|update) #/.test(l));
const wakesWith = (k: Kit, words: string) => k.host.wakes.filter((w) => w.includes(words));
const digest = (k: Kit) => leadTrainLines(trainFacts(k.train.records, () => true)).join("\n");

// A required approval waits.

test("a base that requires an approval: a reviewed, green PR waits untouched, says so once, and merges by itself once approved", async () => {
  const k = kit();
  k.gh.required = ["ci"];
  k.gh.approvals = {};
  k.pr(1, "fleetd/T1-x", { "x.md": "x\n" });
  await k.enqueue(1);
  // Main moves on: the PR is behind it while it waits.
  k.commitMain({ "other.md": "o\n" });
  const head = k.gh.headOf("fleetd/T1-x");
  await passes(k, 8);
  expect(k.change(1)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(APPROVAL).toContain("waiting for a person's approval");
  // No merge tried, and no push to a branch a person is to approve.
  expect(mergeCalls(k)).toEqual([]);
  expect(pushes(k)).toEqual([]);
  expect(k.gh.headOf("fleetd/T1-x")).toBe(head);
  // The lead hears it once, the digest and the PR's own row show it on every read.
  expect(wakesWith(k, "waiting for a person's approval").length).toBe(1);
  expect(wakesWith(k, "gave up")).toEqual([]);
  expect(digest(k)).toContain(`${k.change(1).changeId} waiting for a person's approval`);
  expect(queue(k.change(1), 1).reason).toStartWith("waiting for a person's approval");
  k.approve(1);
  await k.settle();
  expect(k.change(1).state).toBe("merged");
  expect(merges(k)).toEqual(["merge #1"]);
  expect(mergeCalls(k).length).toBe(1);
});

test("classic branch protection that requires an approval waits the same way", async () => {
  const k = kit();
  k.gh.approvals = { classic: true };
  k.pr(2, "fleetd/T2-x", { "x.md": "x\n" });
  await k.enqueue(2);
  await passes(k, 4);
  expect(k.change(2)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(mergeCalls(k)).toEqual([]);
  k.approve(2);
  await k.settle();
  expect(k.change(2).state).toBe("merged");
});

test("a person asks for changes on a PR that waits for approval: it keeps waiting, and is not merged", async () => {
  const k = kit();
  k.gh.approvals = {};
  k.pr(3, "fleetd/T3-x", { "x.md": "x\n" });
  k.gh.pulls.get(3)!.changesRequested = true;
  await k.enqueue(3);
  await passes(k, 4);
  expect(k.change(3)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(mergeCalls(k)).toEqual([]);
});

test("rules that can't be read: the train merges as before, and a merge refused for a missing approval waits instead of failing", async () => {
  const k = kit();
  k.gh.approvals = { classic: true };
  k.gh.unreadable = ["classic"];
  k.pr(4, "fleetd/T4-x", { "x.md": "x\n" });
  k.pr(5, "fleetd/T5-y", { "y.md": "y\n" });
  await k.enqueue(4);
  await passes(k, 6);
  // One try, refused; GitHub's own answer on the PR says why, and it waits.
  expect(mergeCalls(k).length).toBe(1);
  expect(k.change(4)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(wakesWith(k, "gave up")).toEqual([]);
  expect(wakesWith(k, "waiting for a person's approval").length).toBe(1);
  // The base is known to require one now: the next PR waits without a try.
  await k.enqueue(5);
  await passes(k, 4);
  expect(k.change(5)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(mergeCalls(k).length).toBe(1);
  // A restart forgets what the refusal taught: the PRs that wait keep waiting, untried and unannounced.
  const again = k.restarted();
  for (let i = 0; i < 4; i++) {
    k.clock.ms += 61_000;
    await again.step(REPO);
  }
  expect(k.change(4)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(mergeCalls(k).length).toBe(1);
  expect(wakesWith(k, "waiting for a person's approval").length).toBe(2);
  k.approve(4);
  for (let i = 0; i < 6; i++) {
    k.clock.ms += 61_000;
    if (!(await again.step(REPO))) break;
  }
  expect(k.change(4).state).toBe("merged");
  expect(k.change(5)).toMatchObject({ state: "ready", lastError: APPROVAL });
});

test("neither the rules nor the PR's reviews can be read: the train never stalls, it tries and gives up as it does today", async () => {
  const k = kit();
  k.gh.approvals = { classic: true };
  k.gh.unreadable = ["classic", "decision"];
  k.pr(6, "fleetd/T6-x", { "x.md": "x\n" });
  await k.enqueue(6);
  await k.settle();
  expect(k.change(6).state).toBe("ci_failed");
  expect(k.change(6).lastError).toContain("At least 1 approving review is required");
  expect(mergeCalls(k).length).toBe(3);
});

test("a merge GitHub refuses for a rule fleetd can't satisfy is said once, with the rule, and not retried", async () => {
  const k = kit();
  k.pr(7, "fleetd/T7-x", { "x.md": "x\n" });
  k.gh.mergeReplies = [httpError(405, "Repository rule violations found\n\nCommits must have verified signatures.\n")];
  await k.enqueue(7);
  await k.settle();
  await passes(k, 4);
  expect(k.change(7).state).toBe("ci_failed");
  expect(k.change(7).lastError).toContain("Commits must have verified signatures");
  expect(mergeCalls(k).length).toBe(1);
  expect(wakesWith(k, "verified signatures").length).toBe(1);
  expect(wakesWith(k, "gave up")).toEqual([]);
});

test("an open conversation on a base that wants each resolved: GitHub answers no review decision, and the refusal names that rule, once", async () => {
  const k = kit();
  k.gh.approvals = {};
  k.pr(8, "fleetd/T8-x", { "x.md": "x\n" }, { conversation: true });
  await k.enqueue(8);
  await passes(k, 6);
  expect(k.change(8).state).toBe("ci_failed");
  expect(k.change(8).lastError).toBe(
    "GitHub refused the merge (HTTP 405): Repository rule violations found: A conversation must be resolved before this pull request can be merged.; fleetd can't satisfy this rule, and never goes around one",
  );
  expect(mergeCalls(k).length).toBe(1);
  expect(wakesWith(k, "A conversation must be resolved").length).toBe(1);
  expect(wakesWith(k, "waiting for a person's approval")).toEqual([]);
  // Resolved and handed in again: now GitHub answers on its reviews, and it waits for the approval.
  k.gh.pulls.get(8)!.conversation = false;
  await k.enqueue(8);
  await passes(k, 4);
  expect(k.change(8)).toMatchObject({ state: "ready", lastError: APPROVAL });
  expect(mergeCalls(k).length).toBe(1);
  k.approve(8);
  await k.settle();
  expect(k.change(8).state).toBe("merged");
});

test("a merge GitHub refuses for a reason the train doesn't know: its own words reach the lead as they are, after the tries of today", async () => {
  const k = kit();
  k.pr(9, "fleetd/T9-x", { "x.md": "x\n" });
  const unknown = () => httpError(405, "Repository rule violations found\n\nA rule nobody has heard of yet holds this pull request.\n\n");
  k.gh.mergeReplies = [unknown(), unknown(), unknown()];
  await k.enqueue(9);
  await k.settle();
  expect(k.change(9).state).toBe("ci_failed");
  expect(k.change(9).lastError).toBe(
    "GitHub refused the merge (HTTP 405): Repository rule violations found: A rule nobody has heard of yet holds this pull request.; gave up after 3 tries",
  );
  expect(mergeCalls(k).length).toBe(3);
  expect(wakesWith(k, "A rule nobody has heard of yet holds this pull request.").length).toBe(1);
});

// One at a time where approvals are required.

test("a base that requires an approval: approved PRs merge one at a time, each as itself, never as a batch", async () => {
  const k = kit();
  k.gh.required = ["ci"];
  k.gh.approvals = {};
  for (const n of [11, 12, 13]) k.pr(n, `fleetd/T${n}-x`, { [`f${n}.md`]: `${n}\n` });
  for (const n of [11, 12, 13]) await k.enqueue(n);
  k.approve(11);
  k.approve(12);
  await k.settle(12);
  expect([...k.gh.pulls.values()].some((p) => p.branch.startsWith("fleetd/train/"))).toBe(false);
  expect(merges(k)).toEqual(["merge #11", "merge #12"]);
  expect(k.change(13)).toMatchObject({ state: "ready", lastError: APPROVAL });
  k.approve(13);
  await k.settle();
  expect(merges(k)).toEqual(["merge #11", "merge #12", "merge #13"]);
});

test("a base that drops approvals on new commits: an approved PR behind it gets the base merged in, keeps its approval, and merges", async () => {
  const k = kit();
  k.gh.approvals = { dismissStale: true };
  k.pr(14, "fleetd/T14-x", { "x.md": "x\n" });
  k.pr(15, "fleetd/T15-y", { "y.md": "y\n" });
  await k.enqueue(14);
  await k.enqueue(15);
  k.approve(14);
  k.approve(15);
  await k.settle(12);
  // The second is behind once the first lands: a rebase would have cost it its approval.
  expect(pushes(k)).toEqual(["update #15"]);
  expect(merges(k)).toEqual(["merge #14", "merge #15"]);
  expect(k.change(15).state).toBe("merged");
});

// The merge method the repo allows.

test("squash merges off: the train merges by rebase, and one PR at a time", async () => {
  const k = kit();
  k.gh.methods = ["rebase", "merge"];
  k.pr(21, "fleetd/T21-x", { "x.md": "x\n" });
  k.pr(22, "fleetd/T22-y", { "y.md": "y\n" });
  await k.enqueue(21);
  await k.enqueue(22);
  await k.settle(12);
  expect(merges(k)).toEqual(["merge #21 by rebase", "merge #22 by rebase"]);
  expect([...k.gh.pulls.values()].some((p) => p.branch.startsWith("fleetd/train/"))).toBe(false);
  expect(k.change(22).state).toBe("merged");
});

test("only merge commits allowed, by the repo or by the base's ruleset: the train merges with a merge commit that names the Change", async () => {
  const k = kit();
  k.gh.methods = ["merge"];
  k.pr(23, "fleetd/T23-x", { "x.md": "x\n" });
  await k.enqueue(23);
  await k.settle();
  expect(merges(k)).toEqual(["merge #23 by merge"]);
  expect(git(k.origin, ["log", "-1", "--format=%B", "main"])).toContain(`Fleetd-Change: ${k.change(23).changeId}`);

  const r = kit();
  r.gh.ruleMethods = ["merge"];
  r.pr(24, "fleetd/T24-x", { "x.md": "x\n" });
  await r.enqueue(24);
  await r.settle();
  expect(merges(r)).toEqual(["merge #24 by merge"]);
});

test("GitHub doesn't show the repo's merge methods: the train squashes, as it does today", async () => {
  const k = kit();
  k.gh.unreadable = ["methods"];
  k.pr(25, "fleetd/T25-x", { "x.md": "x\n" });
  await k.enqueue(25);
  await k.settle();
  expect(merges(k)).toEqual(["merge #25"]);
});

// CI from any provider.

test("CI another provider reports as commit statuses, in a repo with no workflow: green merges", async () => {
  const k = kit();
  k.gh.noCi = true;
  k.gh.provider = () => [["ci/circleci: build", "success"]];
  k.pr(31, "fleetd/T31-x", { "x.md": "x\n" });
  k.pr(32, "fleetd/T32-y", { "y.md": "y\n" });
  await k.enqueue(31);
  await k.enqueue(32);
  await k.settle(12);
  expect(k.change(31).state).toBe("merged");
  expect(k.change(32).state).toBe("merged");
});

test("a required check a provider reports as a commit status, on heads with no check run: pending waits, green merges", async () => {
  const k = kit();
  k.gh.noCi = true;
  k.gh.required = ["buildkite/storefront"];
  let state = "pending";
  k.gh.provider = () => [
    ["buildkite/storefront", state],
    ["vercel", "failure"],
  ];
  k.pr(33, "fleetd/T33-x", { "x.md": "x\n" });
  await k.enqueue(33);
  await passes(k, 3);
  expect(k.change(33).state).not.toBe("merged");
  expect(mergeCalls(k)).toEqual([]);
  state = "success";
  await k.settle();
  // The status that is not required and failed doesn't hold it, as a check run that isn't required doesn't.
  expect(k.change(33).state).toBe("merged");
});

test("a provider's status that failed turns the PR red, with its page", async () => {
  const k = kit();
  k.gh.noCi = true;
  k.gh.provider = () => [["continuous-integration/jenkins/pr-merge", "failure"]];
  k.pr(34, "fleetd/T34-x", { "x.md": "x\n" });
  await k.enqueue(34);
  await k.settle();
  expect(k.change(34).state).toBe("ci_failed");
  expect(k.change(34).lastError).toContain("continuous-integration/jenkins/pr-merge");
  expect(mergeCalls(k)).toEqual([]);
});

test("a repo with workflows whose head gets only an unnamed commit status: it is not CI until named, and the timeout says how", async () => {
  const k = kit();
  k.gh.runs = () => [];
  k.gh.provider = () => [["continuous-integration/jenkins/pr-merge", "success"]];
  k.pr(36, "fleetd/T36-x", { "x.md": "x\n" });
  await k.enqueue(36);
  await k.settle();
  // A check run of its workflows may still come: a status alone never merges it.
  expect(mergeCalls(k)).toEqual([]);
  expect(k.change(36).state).toBe("ci_failed");
  expect(k.change(36).lastError).toContain("continuous-integration/jenkins/pr-merge reported as a commit status");
  expect(k.change(36).lastError).toContain(".fleetd/train.json names it");
  // Named in the repo's file, it is the PR's CI.
  k.trainFile(["continuous-integration/jenkins/pr-merge"]);
  await k.settle();
  expect(k.change(36).state).toBe("merged");
});

test("a repo with no CI of any provider is still held for having none", async () => {
  const k = kit();
  k.gh.noCi = true;
  k.pr(35, "fleetd/T35-x", { "x.md": "x\n" });
  await k.enqueue(35);
  await passes(k, 3);
  expect(k.change(35).state).toBe("ready");
  expect(k.change(35).lastError).toStartWith("held: this repo has no CI");
});

// A person merges: the `hold` label.

test("a PR with the hold label: the lead hears once that it is reviewed and green, and again only after a new patch", async () => {
  const k = kit();
  k.pr(41, "fleetd/T41-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(41);
  await passes(k, 8);
  const told = () => wakesWith(k, "reviewed and green");
  expect(told().length).toBe(1);
  expect(told()[0]).toContain("`hold` label");
  expect(told()[0]).toContain("PR #41");
  expect(merges(k)).toEqual([]);
  expect(digest(k)).toContain(`${k.change(41).changeId} held by its \`hold\` label`);
  // A restart doesn't say it again.
  const again = k.restarted();
  for (let i = 0; i < 3; i++) {
    k.clock.ms += 61_000;
    await again.step(REPO);
  }
  expect(told().length).toBe(1);
  // Its author pushes: reviewed again, and said again at the new head.
  git(k.clone, ["checkout", "-q", "fleetd/T41-x"]);
  writeFileSync(join(k.clone, "x.md"), "more\n");
  git(k.clone, ["commit", "-q", "-am", "more"]);
  git(k.clone, ["push", "-q", "origin", "fleetd/T41-x:fleetd/T41-x"]);
  for (let i = 0; i < 6; i++) {
    k.clock.ms += 61_000;
    await again.step(REPO);
  }
  expect(told().length).toBe(2);
  expect(told()[1]).toContain(k.gh.headOf("fleetd/T41-x")!.slice(0, 12));
});

test("a PR with the hold label whose own CI is red: its writer hears, and the lead is not told it is ready", async () => {
  const k = kit();
  k.pr(42, "fleetd/T42-x", { FAIL: "x\n" }, { labels: ["hold"] });
  await k.enqueue(42);
  await passes(k, 6);
  expect(k.host.sends.filter(([task, text]) => task === "T42" && text.includes("`ci`")).length).toBe(1);
  expect(wakesWith(k, "reviewed and green")).toEqual([]);
});

test("a PR with the hold label is kept up to date with main while it waits, an hour apart at most", async () => {
  const k = kit();
  k.pr(43, "fleetd/T43-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(43);
  await passes(k, 3);
  expect(pushes(k)).toEqual([]);
  k.commitMain({ "one.md": "1\n" });
  await passes(k, 3);
  expect(pushes(k)).toEqual(["rebase #43"]);
  // Main moves again within the hour: left as it is.
  k.commitMain({ "two.md": "2\n" });
  await passes(k, 5);
  expect(pushes(k)).toEqual(["rebase #43"]);
  k.clock.ms += 60 * 60_000;
  await passes(k, 3);
  expect(pushes(k)).toEqual(["rebase #43", "rebase #43"]);
  expect(k.change(43).state).toBe("ready");
  expect(merges(k)).toEqual([]);
});

test("a held PR on a base that drops approvals on new commits: approved, it is not pushed to; unapproved, the base is merged in", async () => {
  const k = kit();
  k.gh.approvals = { dismissStale: true };
  k.pr(44, "fleetd/T44-x", { "x.md": "x\n" }, { labels: ["hold"] });
  k.pr(45, "fleetd/T45-y", { "y.md": "y\n" }, { labels: ["hold"] });
  k.approve(44);
  await k.enqueue(44);
  await k.enqueue(45);
  await passes(k, 3);
  k.commitMain({ "one.md": "1\n" });
  await passes(k, 5);
  expect(pushes(k)).toEqual(["update #45"]);
  expect(k.gh.pulls.get(44)!.approved).toBe(true);
});

// The rules as read from GitHub's answers.

test("rulesFromAnswers: an approval from a ruleset or from classic protection, stale approvals, and the first allowed merge method", () => {
  const pullRule = (parameters: Record<string, unknown>) => [{ type: "pull_request", parameters }];
  const none = { approval: false, dismissStale: false, method: "squash" as const };
  expect(rulesFromAnswers([], null, { allow_squash_merge: true, allow_rebase_merge: true, allow_merge_commit: true })).toEqual(none);
  // A pull_request rule that asks for no approval (fleetd's own shape) requires none.
  expect(rulesFromAnswers(pullRule({ required_approving_review_count: 0 }), null, {})).toEqual(none);
  expect(rulesFromAnswers(pullRule({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true }), null, {})).toEqual({ approval: true, dismissStale: true, method: "squash" });
  expect(rulesFromAnswers(pullRule({ required_approving_review_count: 0, require_code_owner_review: true }), null, {}).approval).toBe(true);
  expect(rulesFromAnswers(pullRule({ required_approving_review_count: 2, require_last_push_approval: true }), null, {}).dismissStale).toBe(true);
  expect(rulesFromAnswers([], { requiresApprovingReviews: true, dismissesStaleReviews: true }, {})).toMatchObject({ approval: true, dismissStale: true });
  expect(rulesFromAnswers([], { requiresApprovingReviews: false }, {}).approval).toBe(false);
  expect(rulesFromAnswers([], null, { allow_squash_merge: false, allow_rebase_merge: true, allow_merge_commit: true }).method).toBe("rebase");
  expect(rulesFromAnswers([], null, { allow_squash_merge: false, allow_rebase_merge: false, allow_merge_commit: true }).method).toBe("merge");
  expect(rulesFromAnswers(pullRule({ allowed_merge_methods: ["merge", "rebase"] }), null, { allow_squash_merge: true, allow_rebase_merge: true, allow_merge_commit: true }).method).toBe("rebase");
  // Nothing allowed that it can read: the squash it always made, and GitHub's refusal says the rest.
  expect(rulesFromAnswers(pullRule({ allowed_merge_methods: ["squash"] }), null, { allow_squash_merge: false, allow_rebase_merge: true }).method).toBe("squash");
});

test("statusRuns: a head's commit statuses stand in as check runs, the fast set's where there is one, never the train's own", () => {
  const statuses = [
    { context: "ci/circleci: build", state: "success", target_url: "https://circleci.example.invalid/1" },
    { context: "buildkite/app", state: "pending" },
    { context: "vercel", state: "failure" },
    { context: "fleetd/train", state: "success" },
  ];
  const every = statusRuns(statuses, new Fast([], { fastChecks: [], afterMerge: [] }));
  expect(every.map((r) => [r.name, r.status, r.conclusion])).toEqual([
    ["ci/circleci: build", "completed", "success"],
    ["buildkite/app", "in_progress", null],
    ["vercel", "completed", "failure"],
  ]);
  expect(every[0]!.html_url).toBe("https://circleci.example.invalid/1");
  expect(statusRuns(statuses, new Fast(["buildkite/app"], { fastChecks: [], afterMerge: [] })).map((r) => r.name)).toEqual(["buildkite/app"]);
});

test("oneLine: a ruleset's refusal, a heading and a line per rule, reads as one line", () => {
  expect(oneLine("Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access.\n\n")).toBe(
    "Repository rule violations found: At least 1 approving review is required by reviewers with write access.",
  );
  expect(oneLine("Base branch was modified. Review and try the merge again.")).toBe("Base branch was modified. Review and try the merge again.");
});

test("ruleRefusal: GitHub's words for a rule no retry satisfies, and not for one a retry or an approval does", () => {
  expect(ruleRefusal("Repository rule violations found\n\nCommits must have verified signatures.")).toBe(true);
  expect(ruleRefusal("Changes must be made through the merge queue")).toBe(true);
  expect(ruleRefusal("Repository rule violations found\n\nA conversation must be resolved before this pull request can be merged.\n\n")).toBe(true);
  expect(ruleRefusal("At least 1 approving review is required by reviewers with write access.")).toBe(false);
  expect(ruleRefusal('Required status check "ci" is expected.')).toBe(false);
  expect(ruleRefusal("Base branch was modified. Review and try the merge again.")).toBe(false);
  expect(ruleRefusal("Squash merges are not allowed on this repository.")).toBe(false);
});
