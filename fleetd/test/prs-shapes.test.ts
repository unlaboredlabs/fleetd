import { expect, test } from "bun:test";
import { readDetail, readPage } from "../src/hub/prs/shapes.ts";
import { errorText, parsePrUrl } from "../src/hub/train/states.ts";

test("a page of GitHub's PR list is read with its checks and cursor; a shape fleetd doesn't read is refused", () => {
  const node = {
    number: 7,
    title: "Fix it",
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat" },
    headRefName: "b",
    headRefOid: "abc",
    createdAt: "c",
    updatedAt: "u",
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "fleetd" }] } } } }] },
  };
  const page = readPage({ data: { repository: { pullRequests: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: "X" } } } } });
  expect(page.next).toBe("X");
  expect(page.pulls[0]).toMatchObject({ number: 7, author: { login: "octocat" }, mergedAt: null, reviewDecision: null });
  expect(page.pulls[0]!.statusCheckRollup).toEqual([{ __typename: "CheckRun", name: "fleetd" }] as never);
  const last = readPage({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  expect(last).toEqual({ pulls: [] });
  expect(() => readPage({ data: { repository: null } })).toThrow("doesn't know this repository");
  expect(() => readPage({})).toThrow("shape fleetd doesn't read");
});

test("a PR's detail fills its defaults, and one without a number isn't one", () => {
  const d = readDetail({ number: 3, additions: 2, reviews: [{ state: "APPROVED", author: { login: "r" } }], mergeCommit: { oid: "m" } });
  expect(d).toMatchObject({ body: "", additions: 2, deletions: 0, mergeCommit: { oid: "m" } });
  expect(d?.reviews).toEqual([{ author: { login: "r" }, state: "APPROVED", body: "", submittedAt: null, commit: null }]);
  expect(readDetail({ title: "no number" })).toBeUndefined();
});

test("a Change's PR URL and its last error are kept as records keep them", () => {
  expect(parsePrUrl("https://github.com/unlaboredlabs/fleetd/pull/12")).toEqual({ repo: "unlaboredlabs/fleetd", number: 12 });
  expect(parsePrUrl("https://github.com/unlaboredlabs/fleetd/pull/0")).toBeUndefined();
  expect(errorText("x".repeat(2001))).toBe(`${"x".repeat(1999)}…`);
  expect(errorText("short")).toBe("short");
});
