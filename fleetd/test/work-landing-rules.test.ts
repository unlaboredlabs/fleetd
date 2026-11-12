import { expect, test } from "bun:test";
import {
  claimMatch,
  fetchError,
  type Landing,
  lsRemoteSha,
  merged,
  onGithub,
  originOf,
  parseCommit,
  remoteHead,
  rewriteKey,
  wakeLine,
} from "../src/hub/work/landing_rules.ts";
import { exported, findings, line, readRepo } from "./pkg/purity.ts";

const PATH = "fleetd/src/hub/work/landing_rules.ts";

test("the landing scanner's rules are the package's fleetd/hub/work/landing_rules, with no hub behind them", () => {
  expect(exported()).toContainEqual({ name: "./hub/work/landing_rules", path: PATH });
  expect(findings(PATH, readRepo).map(line)).toEqual([]);
});

const SHA = "a".repeat(40);

test("a base's head, a commit as git prints it, and where its message says it came from", () => {
  expect(lsRemoteSha(`${SHA.toUpperCase()}\trefs/heads/main\n`, "refs/heads/main")).toBe(SHA);
  expect(remoteHead("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n")).toBe("trunk");
  const commit = parseCommit(`closes #4\n\u001e${SHA}\u001f1700000000\u001fAda@example.com\u001fb c\u001f1600000000\u001ffeat: x\n`);
  expect(commit).toMatchObject({ sha: SHA, atSecs: 1700000000, parents: ["b", "c"], subject: "feat: x", body: "closes #4\n" });
  expect(rewriteKey(commit!)).toBe("ada@example.com\u001f1600000000\u001ffeat: x");
  expect(originOf("Merge pull request #12 from acme/dark-mode", "")).toEqual({ host: "github", pr: 12, head: "dark-mode" });
  expect(onGithub({ repoKey: "github.com/acme/shop", base: "main" })).toBe(true);
  expect(fetchError("git fetch failed: ssh: Could not resolve hostname github.com").kind).toBe("offline");
});

test("a landing ends the claim on its branch, and the lead reads it in a line", () => {
  const landing: Landing = {
    repoKey: "github.com/acme/shop",
    base: "main",
    sha: SHA,
    at: "2026-01-01T00:00:00.000Z",
    seenAt: "2026-01-01T00:00:00.000Z",
    route: "pr_outside",
    prNumber: 12,
    headBranch: "dark-mode",
    subject: "feat: dark mode",
    paths: [],
    claimIds: ["C7"],
  };
  const claim = { claimId: "C7", title: "dark mode", branch: "dark-mode", keys: [], paths: [] } as never;
  expect(claimMatch(claim, landing, "")).toEqual({ ends: "branch dark-mode" });
  expect(wakeLine(landing)).toBe('aaaaaaa "feat: dark mode" was merged into main from PR #12 without the merge train; it ended claim C7.');
});

test("a closed PR as GitHub answers it is merged only with a merge time", () => {
  const pull = { number: 3, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: SHA, base: { ref: "main" }, head: { ref: "x" }, user: { type: "Bot" } };
  expect(merged(pull)).toEqual({ number: 3, mergedAt: "2026-01-01T00:00:00Z", mergeSha: SHA, base: "main", head: "x", authorBot: true });
  expect(merged({ ...pull, merged_at: null })).toBeUndefined();
});

test("an empty issue key closes nothing, and its claim is matched at once", () => {
  // `indexOf("", n)` past the end answers the text's length, never -1: the loop over a key's places never ended. Run
  // in a process of its own, so a loop that doesn't end fails the test instead of hanging the run.
  expect("fixes".indexOf("", 9)).toBe(5);
  const script = `
    import { claimMatch, closes } from ${JSON.stringify(`${import.meta.dir}/../src/hub/work/landing_rules.ts`)};
    const landing = { repoKey: "github.com/acme/shop", base: "main", sha: "a", at: "", seenAt: "", route: "direct_push", subject: "feat: x", paths: [], claimIds: [] };
    const claim = { claimId: "C1", title: "y", keys: [{ issue: "" }], paths: [] };
    console.log(JSON.stringify([closes("fixes #12", ""), closes("", ""), claimMatch(claim, landing, "body") ?? null]));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { timeout: 4_000, stdout: "pipe", stderr: "pipe" });
  expect([run.exitCode, run.stdout.toString().trim(), run.stderr.toString()]).toEqual([0, "[false,false,null]", ""]);
});
