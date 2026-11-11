// People's reviews on GitHub (reviews/people.ts) and the agent's review posted on the PR (reviews/post.ts), over the
// train kit with GitHub's GraphQL answers built by hand in the shape GitHub gives them: a person's "Request changes"
// and unresolved threads reach the writer as blocking findings and hold the merge until GitHub says they are
// answered; bots, plain comments and fleetd's own posts are no findings; a failed read holds nothing.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { GhOut } from "../src/hub/train/gh.ts";
import { holdWhy, openFindings, PEOPLE_HOLD, REVIEW_MARK } from "../src/hub/reviews/people.ts";
import { reviewComment } from "../src/hub/reviews/post.ts";
import { openBlocking } from "../src/hub/reviews/read.ts";
import { withReviews } from "../src/hub/reviews/service.ts";
import { Kit, REPO } from "./train_kit.ts";

setDefaultTimeout(30_000);

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});

const person = (login: string) => ({ login, __typename: "User" });
const bot = (login: string) => ({ login, __typename: "Bot" });
const ok = (body: unknown): GhOut => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });

type Review = { databaseId: number; state: string; body: string; url: string; authorAssociation: string; author: unknown };
type Comment = { databaseId: number; body: string; url: string; authorAssociation: string; author: unknown };
type Thread = { isResolved: boolean; isOutdated: boolean; path: string; line: number | null; originalLine: number; comments: { nodes: Comment[] } };
type PullNode = { author?: { login: string }; reviews: { nodes: Review[] }; reviewThreads: { nodes: Thread[] } };

const review = (id: number, login: string, state: string, body = "", author: unknown = person(login), authorAssociation = "MEMBER"): Review => ({
  databaseId: id,
  state,
  body,
  url: `https://github.com/${REPO}/pull/7#pullrequestreview-${id}`,
  authorAssociation,
  author,
});
const thread = (
  id: number,
  login: string,
  path: string,
  line: number | null,
  body: string,
  extra: Partial<Thread> = {},
  author: unknown = person(login),
  authorAssociation = "MEMBER",
): Thread => ({
  isResolved: false,
  isOutdated: false,
  path,
  line,
  originalLine: line ?? 3,
  comments: { nodes: [{ databaseId: id, body, url: `https://github.com/${REPO}/pull/7#discussion_r${id}`, authorAssociation, author }] },
  ...extra,
});

/** The kit, its gate, and GitHub's people as the test sets them: each PR's reviews and threads, and the comments posted. */
function lab() {
  const k = new Kit();
  kits.push(k);
  const reviews = withReviews(k.train, k.host);
  const people = new Map<number, PullNode>();
  const posted: { method: string; path: string; body: string }[] = [];
  let peopleReads = 0;
  let failReads = false;
  const answer = k.gh.answer.bind(k.gh);
  k.gh.answer = (args: string[]) => {
    const query = args.find((a) => a.startsWith("query="));
    if (args.includes("graphql") && query?.includes("reviewThreads")) {
      peopleReads++;
      if (failReads) return ok({ errors: [{ message: "API rate limit exceeded for installation" }] });
      const repository: Record<string, PullNode | null> = {};
      for (const m of query.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) repository[`p${m[1]}`] = people.get(Number(m[2])) ?? null;
      return ok({ data: { repository } });
    }
    const method = args[args.indexOf("-X") + 1] ?? "GET";
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const body = args.find((a) => a.startsWith("body="))?.slice(5) ?? "";
    if (/^repos\/[^/]+\/[^/]+\/issues\/(\d+\/comments|comments\/\d+)$/.test(path) && method !== "GET") {
      posted.push({ method, path, body });
      return ok({ id: 9001 });
    }
    return answer(args);
  };
  const verdict = async (taskId: string, sha: string, blocking: number, summary = "a.md:1 fine") => {
    k.db.conn
      .query("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, NULL, ?, ?, 0, ?)")
      .run(taskId, sha, blocking, JSON.stringify({ taskId, prHeadSha: sha, blocking, nonBlocking: 1, summary }));
    await reviews.handle({ seq: 0, eventType: "review.verdict", data: { taskId, prHeadSha: sha, blocking, nonBlocking: 1 } });
  };
  /** A minute on, as the poll loop would: the repo is read again and acted on. */
  const poll = async () => {
    k.clock.ms += 61_000;
    await reviews.peoplePass();
  };
  return {
    k,
    reviews,
    people,
    posted,
    verdict,
    poll,
    reads: () => peopleReads,
    failing: (v: boolean) => {
      failReads = v;
    },
  };
}

test("a person's say, as GitHub counts it: bots, plain comments, answered reviews and fleetd's own posts are no findings", () => {
  const pull: PullNode = {
    reviews: {
      nodes: [
        review(1, "ana", "CHANGES_REQUESTED", "Please don't log the token."),
        review(2, "ben", "CHANGES_REQUESTED", "Rename it."),
        review(3, "ben", "APPROVED"),
        // Dismissed: GitHub changes the review's own state.
        review(4, "cy", "DISMISSED", "Wrong file."),
        review(5, "dee", "COMMENTED", "nice"),
        review(6, "dependabot[bot]", "CHANGES_REQUESTED", "bump", bot("dependabot[bot]")),
        review(7, "devon", "COMMENTED", `**fleetd's agent review** of abc: 2 blocking\n\n${REVIEW_MARK}`),
        // A later review that only comments doesn't take a request for changes back.
        review(8, "ana", "COMMENTED", "see the thread"),
        // Anyone on a public repo may review it: only the repo's owner, members and collaborators count.
        review(9, "passerby", "CHANGES_REQUESTED", "Rewrite it in Go.", person("passerby"), "NONE"),
        review(10, "drive-by", "CHANGES_REQUESTED", "Nope.", person("drive-by"), "CONTRIBUTOR"),
      ],
    },
    reviewThreads: {
      nodes: [
        thread(11, "ana", "src/a.ts", 12, "This leaks the key."),
        thread(12, "ben", "src/b.ts", 4, "typo", { isResolved: true }),
        thread(13, "copilot", "src/c.ts", 9, "Consider…", {}, bot("copilot-pull-request-reviewer[bot]")),
        thread(14, "ben", "src/d.ts", null, "This moved?", { isOutdated: true }),
        thread(15, "passerby", "src/e.ts", 2, "Delete this file.", {}, person("passerby"), "FIRST_TIME_CONTRIBUTOR"),
      ],
    },
  };
  const found = openFindings(pull as Parameters<typeof openFindings>[0]);
  expect(found.map((f) => [f.kind, f.by, f.path, f.line, f.outdated, f.keys])).toEqual([
    ["changes", "ana", undefined, undefined, undefined, ["review:1"]],
    ["thread", "ana", "src/a.ts", 12, undefined, ["comment:11"]],
    ["thread", "ben", "src/d.ts", 3, true, ["comment:14"]],
  ]);
  expect(holdWhy(found)).toBe("@ana requested changes; 2 unresolved review threads (@ana, @ben)");
  expect(openFindings(null)).toEqual([]);
});

test("a person's request for changes goes to the writer as blocking findings and holds the merge until they dismiss it", async () => {
  const { k, people, verdict, poll } = lab();
  k.pr(7, "fleetd/T7-a", { "a.md": "a\n" });
  people.set(7, { reviews: { nodes: [review(1, "ana", "CHANGES_REQUESTED", "Please split this.")] }, reviewThreads: { nodes: [thread(11, "ana", "a.md", 1, "Not this line.")] } });
  const change = await k.enqueue(7);
  await verdict("T50", change.headSha, 0);
  // The agent found nothing, but a person did: it waits in review, and the writer has their findings.
  expect(k.change(7).state).toBe("reviewing");
  expect(k.change(7).lastError).toBe(`${PEOPLE_HOLD}@ana requested changes; 1 unresolved review thread (@ana); sent to T7`);
  const toWriter = k.host.sends.filter(([to]) => to === "T7");
  expect(toWriter.length).toBe(1);
  const text = toWriter[0]![1];
  expect(text).toContain("people reviewed it on GitHub: @ana requested changes; 1 unresolved review thread (@ana)");
  expect(text).toContain("- the whole PR, @ana requested changes (blocking)");
  expect(text).toContain("@ana: Please split this.");
  expect(text).toContain("- a.md:1, thread by @ana (blocking)");
  expect(text).toContain(`gh api repos/${REPO}/pulls/7/comments/11/replies`);
  expect(text).toContain("Never resolve a person's thread or dismiss their review");
  expect(openBlocking(k.train.records.db, change.prUrl)).toContain("@ana requested changes on GitHub (blocking)");
  // Each pass reads it again, but sends nothing twice; the train keeps it out of the line.
  await poll();
  await k.settle();
  expect(k.host.sends.filter(([to]) => to === "T7").length).toBe(1);
  expect(k.change(7).state).toBe("reviewing");
  // The writer replied; ana dismisses her review and resolves the thread: it is ready, and merges.
  people.set(7, { reviews: { nodes: [review(1, "ana", "DISMISSED", "Please split this.")] }, reviewThreads: { nodes: [thread(11, "ana", "a.md", 1, "Not this line.", { isResolved: true })] } });
  await poll();
  expect(k.change(7).state).toBe("ready");
  await k.settle();
  expect(k.change(7).state).toBe("merged");
});

test("a person's new thread on a ready PR sends it back to review; a new comment on it reaches the writer; resolved, it merges", async () => {
  const { k, people, verdict, poll } = lab();
  k.pr(8, "fleetd/T8-a", { "a.md": "a\n" });
  const change = await k.enqueue(8);
  await verdict("T50", change.headSha, 0);
  expect(k.change(8).state).toBe("ready");
  people.set(8, { reviews: { nodes: [review(2, "ben", "COMMENTED", "")] }, reviewThreads: { nodes: [thread(21, "ben", "a.md", 1, "Why a?")] } });
  await poll();
  expect(k.change(8)).toMatchObject({ state: "reviewing", lastError: `${PEOPLE_HOLD}1 unresolved review thread (@ben); sent to T8` });
  await k.settle();
  expect(k.change(8).state).toBe("reviewing");
  // The writer replies on the thread, as the PR's author: its own reply never comes back to it.
  const t = thread(21, "ben", "a.md", 1, "Why a?");
  t.comments.nodes.push({ databaseId: 22, body: "a is the cache key.", url: "u", authorAssociation: "COLLABORATOR", author: person("devon") });
  people.set(8, { author: person("devon"), reviews: { nodes: [] }, reviewThreads: { nodes: [t] } });
  await poll();
  expect(k.host.sends.filter(([to]) => to === "T8").length).toBe(1);
  // Ben answers it on the same thread: that comment goes to the writer, with the thread so far.
  t.comments.nodes.push({ databaseId: 23, body: "Still not convinced.", url: "u", authorAssociation: "MEMBER", author: person("ben") });
  await poll();
  const toWriter = k.host.sends.filter(([to]) => to === "T8");
  expect(toWriter.length).toBe(2);
  expect(toWriter[1]![1]).toContain("@devon: a is the cache key.");
  expect(toWriter[1]![1]).toContain("@ben: Still not convinced.");
  t.isResolved = true;
  await k.settle();
  expect(k.change(8).state).toBe("merged");
});

test("a read GitHub refuses holds nothing, and backs off, doubling", async () => {
  const { k, reviews, verdict, reads, failing } = lab();
  failing(true);
  k.pr(9, "fleetd/T9-a", { "a.md": "a\n" });
  const change = await k.enqueue(9);
  await verdict("T50", change.headSha, 0);
  expect(k.change(9).state).toBe("ready");
  expect(reads()).toBe(1);
  // Within its backoff no read is tried; after it, one is, and the next wait is twice as long.
  await reviews.peoplePass();
  expect(reads()).toBe(1);
  k.clock.ms += 61_000;
  await reviews.peoplePass();
  expect(reads()).toBe(2);
  k.clock.ms += 61_000;
  await reviews.peoplePass();
  expect(reads()).toBe(2);
  await k.settle();
  expect(k.change(9).state).toBe("merged");
});

test("the agent's verdict is posted on the PR as one comment, edited on each re-review; never an approval", async () => {
  const { k, verdict, posted, reviews } = lab();
  k.pr(10, "fleetd/T10-a", { "a.md": "a\n" });
  const change = await k.enqueue(10);
  await verdict("T50", change.headSha, 2, "a.md:1 blocking: leaks the key");
  await reviews.posted();
  expect(posted.map((p) => [p.method, p.path])).toEqual([["POST", `repos/${REPO}/issues/10/comments`]]);
  const first = posted[0]!.body;
  expect(first).toContain(`**fleetd's agent review** of [\`${change.headSha.slice(0, 12)}\`](https://github.com/${REPO}/commit/${change.headSha}): 2 blocking, 1 non-blocking.`);
  expect(first).toContain("a.md:1 blocking: leaks the key");
  expect(first).toContain(REVIEW_MARK);
  // The writer pushes a fix; its clean re-review edits the same comment.
  k.pr(10, "fleetd/T10-a", { "b.md": "b\n" });
  await k.train.step(REPO);
  const moved = k.change(10);
  expect(moved.headSha).not.toBe(change.headSha);
  await verdict("T51", moved.headSha, 0, "clean");
  await reviews.posted();
  expect(posted.map((p) => [p.method, p.path])).toEqual([
    ["POST", `repos/${REPO}/issues/10/comments`],
    ["PATCH", `repos/${REPO}/issues/comments/9001`],
  ]);
  expect(posted[1]!.body).toContain(`of [\`${moved.headSha.slice(0, 12)}\`]`);
  expect(posted[1]!.body).toContain("no blocking findings (1 non-blocking)");
  expect(posted[1]!.body).toContain(`Earlier rounds: \`${change.headSha.slice(0, 12)}\` 2 blocking, 1 non-blocking.`);
  // Nothing fleetd sent GitHub is a review that approves or requests changes.
  expect(k.gh.calls.some((c) => c.some((a) => /event=(APPROVE|REQUEST_CHANGES)/.test(a)))).toBe(false);
  expect(k.gh.calls.some((c) => c.some((a) => /\/reviews$/.test(a)))).toBe(false);
});

test("the comment reads plainly", () => {
  const body = reviewComment("acme/storefront", { sha: "a".repeat(40), blocking: 0, nonBlocking: 0, summary: "All good. ghp_abcdefghijklmnopqrstuvwxyz0123" }, []);
  expect(body).toContain("no blocking findings.");
  expect(body).toContain("[secret]");
  expect(body).not.toContain("ghp_");
  expect(body).not.toContain("Earlier rounds");
});

test("a person's finding on a Change back with its writer keeps the train's own note on it", async () => {
  const { k, people, poll } = lab();
  k.pr(11, "fleetd/T11-a", { "a.md": "a\n" });
  await k.enqueue(11);
  const failed = { ...k.change(11), state: "ci_failed" as const, lastError: "CI failed on abc: ci (failure)" };
  k.train.records.put(failed);
  people.set(11, { reviews: { nodes: [] }, reviewThreads: { nodes: [thread(31, "ben", "a.md", 1, "Why a?")] } });
  await poll();
  // The writer hears, and the train still reads why it failed.
  expect(k.host.sends.filter(([to]) => to === "T11").length).toBe(1);
  expect(k.change(11)).toMatchObject({ state: "ci_failed", lastError: "CI failed on abc: ci (failure)" });
});

test("a person's review during a re-review in CI leaves the train's wait to the gate, which sends it back at once", async () => {
  const { k, reviews, people, verdict, poll } = lab();
  k.pr(12, "fleetd/T12-a", { "a.md": "a\n" });
  const change = await k.enqueue(12);
  await verdict("T50", change.headSha, 0);
  const approved = k.change(12);
  // The train rebased it onto a moved base: a new patch, in CI with its re-review at work.
  k.train.records.put({ ...approved, state: "ci", patchId: "f".repeat(40) });
  people.set(12, { reviews: { nodes: [review(41, "ana", "CHANGES_REQUESTED", "No.")] }, reviewThreads: { nodes: [] } });
  await poll();
  expect(k.change(12).state).toBe("ci");
  expect(k.host.sends.filter(([to]) => to === "T12").length).toBe(1);
  // Once its re-review is clean, the gate answers the train's wait at once: blocked, back to review.
  k.train.records.put({ ...approved, state: "ci" });
  expect((await reviews.again(k.change(12))).kind).toBe("blocked");
  // In review, it waits there.
  k.train.records.put({ ...approved, state: "reviewing" });
  expect((await reviews.again(k.change(12))).kind).toBe("pending");
});
