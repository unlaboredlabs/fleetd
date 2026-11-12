// The hub's rules fleetd cloud had written again, as the package exports them: each module pure, and the rules split
// out of the hub's files for it (the rest is covered where the hub uses them).
import { expect, test } from "bun:test";
import { FILL_WINDOW_MINUTES } from "../src/hub/approvals/outcome.ts";
import { claimRefusal, expiredWhy, filledEvidence, PURCHASE_CLAIM, purchaseText, SECURE_INPUT_CLAIM } from "../src/hub/approvals/purchase_rules.ts";
import { keyRefusal, shownPrefix } from "../src/hub/auth/key_rules.ts";
import { activity } from "../src/hub/executor/activity.ts";
import { ActivityTracker, liveParts } from "../src/hub/executor/activity_tracker.ts";
import { codeRefusal, NAMELESS, suffixed } from "../src/hub/auth/node_rules.ts";
import { ftsQuery, searchWords, overturnLine, overturnedNext } from "../src/hub/ledger/rules.ts";
import { backSummary, downSummary } from "../src/hub/outage/rules.ts";
import { givenUpLine, mergeLine, ownPr, targetFor, waitingMerge, waitLabel } from "../src/hub/tasks/ci_rules.ts";
import { leadTrainLines } from "../src/hub/train/digest_lines.ts";
import { asksGitHub, upstreamOf } from "../src/hub/train/next_rules.ts";
import { cardShown, vaultCardId } from "../src/hub/vault/card_rules.ts";
import { stallWhy } from "../src/hub/watchdog/rules.ts";
import type { Change, Decision, HumanRequest, Task, TrainState } from "../src/shared/contracts.ts";
import type { ThreadEvent } from "../src/shared/sessions.ts";
import { exported, findings, line, readRepo } from "./pkg/purity.ts";

const MODULES = [
  "agents/paging",
  "agents/sort",
  "approvals/purchase_rules",
  "auth/key_rules",
  "auth/node_rules",
  "executor/activity_tracker",
  "executor/rules",
  "ledger/rules",
  "link/duration",
  "mcp/rpc",
  "outage/rules",
  "project_lead/purchase_rules",
  "prompts/disallowed",
  "tasks/ci_rules",
  "train/digest_lines",
  "vault/card_rules",
  "watchdog/rules",
];

test("each module the cloud copied from is the package's, with no hub behind it", () => {
  for (const m of MODULES) {
    const path = `fleetd/src/hub/${m}.ts`;
    expect(exported()).toContainEqual({ name: `./hub/${m}`, path });
    expect(findings(path, readRepo).map(line)).toEqual([]);
  }
});

test("an outage's and a stall's lines", () => {
  expect(downSummary("devbox", 646_000)).toBe("devbox has been offline for 10m46s");
  expect(backSummary("devbox", 7_500_000)).toBe("devbox is back online after 2h05m");
  expect(stallWhy(600_000, false)).toBe("no progress for 10 min outside a tool, so fleetd interrupted it");
  expect(stallWhy(90_500, true)).toBe("no progress for 91 s inside a tool, so fleetd interrupted it");
});

test("a CI wait's target, its refusals and its lines", () => {
  const pr = targetFor(" https://github.com/acme/web/pull/7/files", true);
  expect(pr).toEqual({ kind: "pr", repo: "acme/web", number: 7 });
  expect(() => targetFor("https://example.com/x", false)).toThrow("is not a GitHub Actions run or pull request URL");
  expect(() => targetFor("https://github.com/acme/web/actions/runs/9", true)).toThrow("is not a pull request: only a PR merges.");
  expect(ownPr({ pr: "https://github.com/ACME/web/pull/3" } as Pick<Task, "pr" | "result">, pr)).toBe(true);
  expect(ownPr({} as Pick<Task, "pr" | "result">, pr)).toBe(false);
  expect(waitLabel("u", true)).toBe("u (until it merges)");
  expect(waitingMerge(undefined)).toEqual({ kind: "merged" });
  expect(waitingMerge({ note: "held: waiting on acme/web#7: its CI failed", failed: true })).toEqual({ kind: "failed", why: "its CI failed" });
  expect(waitingMerge({ note: "held: waiting on acme/web#7: it was closed without merging", failed: true })).toEqual({
    kind: "over",
    why: "it was closed without merging",
  });
  expect(waitingMerge({ note: "held: waiting on acme/web#7: it hasn't merged yet", failed: false })).toEqual({ kind: "pending" });
  expect(mergeLine("u", { kind: "pending" })).toBeUndefined();
  expect(mergeLine("u", { kind: "merged" })).toBe("A PR you waited on to merge (wait_ci merged) has merged: u.");
  expect(givenUpLine("u", false)).toBe("CI you waited on (wait_ci) has not finished after 6 h: u. Look at it with `gh`, or call wait_ci again.");
  expect(givenUpLine("u", true)).toStartWith("A PR you waited on to merge (wait_ci merged) has not merged after 24 h: u.");
});

test("where an upstream PR stands, from its newest Change and GitHub's read", () => {
  const change = (state: string, lastError?: string) => ({ state, ...(lastError ? { lastError } : {}) }) as Change;
  expect(upstreamOf("acme/web", 7, change("merged"), undefined)).toBeUndefined();
  expect(upstreamOf("acme/web", 7, change("ci_failed"), undefined)).toEqual({ note: "held: waiting on acme/web#7: its CI failed", failed: true });
  expect(upstreamOf("acme/web", 7, change("ready"), undefined)).toEqual({ note: "held: waiting on acme/web#7: it hasn't merged yet", failed: false });
  expect([asksGitHub(undefined), asksGitHub(change("refused")), asksGitHub(change("ci"))]).toEqual([true, true, false]);
  expect(upstreamOf("acme/web", 7, undefined, { kind: "open" })?.note).toBe("held: waiting on acme/web#7: it is not on the train yet");
  expect(upstreamOf("acme/web", 7, change("refused"), { kind: "closed" })).toEqual({ note: "held: waiting on acme/web#7: it was closed without merging", failed: true });
  expect(upstreamOf("acme/web", 7, change("abandoned"), { kind: "merged" })).toBeUndefined();
});

test("the lead digest's train lines from plain data", () => {
  const trains = [{ repo: "acme/web", head: "C2", queue: ["C3"] }] as unknown as TrainState[];
  const changes = [
    { changeId: "C2", repo: "acme/web", prNumber: 2, state: "ci", updatedAt: "2031-01-02T10:00:00Z" },
    { changeId: "C3", repo: "acme/web", prNumber: 3, state: "ready", updatedAt: "2031-01-02T10:00:00Z" },
    { changeId: "C1", repo: "acme/web", prNumber: 1, state: "merged", mergedSha: "abcdef0123456789", taskId: "T1", updatedAt: "2031-01-02T10:00:00Z" },
  ] as unknown as Change[];
  expect(leadTrainLines({ trains, changes }, "2031-01-02T09:00:00Z")).toEqual([
    "- acme/web: now C2 (ci); queue C3 ready",
    "- C1 merged since your last wake: acme/web#1 as abcdef012345 (by T1)",
  ]);
});

test("a decision's search words and a person's overturn", () => {
  expect(searchWords("What should the API use for auth, auth?")).toEqual(["api", "auth"]);
  expect(ftsQuery("the and")).toBeUndefined();
  const old = { decisionId: "D3", key: "db.engine", value: "sqlite" } as Decision;
  const next = { decisionId: "D4", key: "db.engine", value: "postgres" } as Decision;
  expect(overturnLine("D3", old, "scale", next)).toBe(
    '- the human replaced D3 db.engine "sqlite" with D4 "postgres": "scale"; follow D4 from now on',
  );
  expect(overturnedNext(old, undefined)).toBe("db.engine is unanswered again; the lead asks before deciding it.");
});

test("a key's refusals, and an enroll code's", () => {
  expect(shownPrefix("fld_abcdefghij")).toBe("fld_abcdef");
  expect(keyRefusal(undefined)?.message).toBe("unknown agent key");
  expect(keyRefusal({ prefix: "fld_abc", revoked_ms: 5, person_removed: 0 })?.message).toBe("agent key fld_abc was revoked");
  expect(keyRefusal({ prefix: "fld_abc", revoked_ms: null, person_removed: 1 })?.message).toBe("the person key fld_abc belongs to was removed from the hub");
  expect(keyRefusal({ prefix: "fld_abc", revoked_ms: null, person_removed: 0 })).toBeUndefined();
  expect(codeRefusal(undefined, "devbox", 10).reason()).toBe("unknown, replaced or revoked enrollment token. Fix: on the hub, run fleetd pair --worker devbox for a new code");
  expect(codeRefusal({ machine_id: NAMELESS, expires_ms: 5, used_ms: null }, "devbox", 10).reason()).toBe("enrollment token expired. Fix: ask the hub for a new join line");
  expect(codeRefusal({ machine_id: "box", expires_ms: 50, used_ms: null }, "devbox", 10).message).toBe("enrollment token is for machine box, not devbox");
  expect([suffixed("devbox", 2), suffixed("a".repeat(31) + "-", 3)]).toEqual(["devbox-2", `${"a".repeat(30)}-3`]);
});

test("a purchase's line, a claim's refusals and a fill's evidence; a vault card as shown", () => {
  expect(purchaseText({ shop: { name: "Shop", domain: "shop.example" }, total: { amount: "9.50", currency: "EUR" } } as never, { ref: "op://Team/Visa" } as never)).toBe(
    "Pay 9.50 EUR at Shop (shop.example) with Visa (Team)",
  );
  const r = (state: string) => ({ requestId: "R1", state }) as HumanRequest;
  expect(claimRefusal(r("ran"), "s1", "s1", PURCHASE_CLAIM)?.message).toBe("R1's card was filled already: a purchase fills once.");
  expect(claimRefusal(r("approved"), "s2", "s1", SECURE_INPUT_CLAIM)?.message).toBe("R1 was asked for in another browser session.");
  expect(claimRefusal(r("approved"), "s1", "s1", PURCHASE_CLAIM)).toBeUndefined();
  expect(expiredWhy("not filled")).toBe(`expired: not filled within ${FILL_WINDOW_MINUTES} minutes of the approval`);
  expect(filledEvidence({ ok: false, typed: false, message: "no field" }, "filled", "partly filled, then")).toEqual({
    evidence: "not filled: no field; it may be filled again within its window",
    again: true,
  });
  expect(filledEvidence({ ok: true, typed: true, message: "done" }, "filled", "partly filled, then")).toEqual({ evidence: "filled: done", again: false });
  expect(vaultCardId(`vault:V${"a".repeat(32)}`)).toBe(`V${"a".repeat(32)}`);
  expect(cardShown("Visa (Personal)", { brand: "visa", last4: "4242" })).toEqual({ label: "Visa (Personal) ••4242", brand: "visa", last4: "4242" });
});

test("a tracker's live parts are what the hub's live lane gives for the same events", () => {
  const T0 = 1_760_000_000_000;
  let now = T0;
  let area: unknown;
  const hub = { clock: { now: () => now }, area: (_: string, make: (h: unknown) => unknown) => (area ??= make(hub)) } as never;
  const t = new ActivityTracker();
  const events = [
    { type: "snapshot", summary: { sessionId: "t1", projectId: "p1", worktreePath: "/w" }, messages: [], items: [], runs: [{ id: "r1", status: "running", ordinal: 1 }], truncated: false },
    { type: "item", id: "i1", runId: "r1", status: "running", title: "", startedAt: "2025-10-09T08:53:20.000Z", updatedAt: "2025-10-09T08:53:20.000Z", kind: { type: "file_change", path: "/w/src/a.ts" } },
    { type: "delta", messageId: "m1", runId: "r1", append: "Reading" },
    { type: "usage", runId: "r1", usage: { inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  ] as ThreadEvent[];
  for (const event of events) {
    now += 500;
    activity(hub).onThreadEvent("devbox", { sessionId: "t1", at: "", event });
    if (event.type === "snapshot") t.setRoot("/w");
    t.apply(event, now);
  }
  now += 1000;
  const parts = liveParts(t, now);
  expect(activity(hub).live({ machineId: "devbox", threadId: "t1" })).toEqual(parts);
  expect(parts).toMatchObject({ activity: { activity: { kind: "edit", path: "src/a.ts" } }, tokens: { input: 40, output: 9, live: true }, runActive: true });
  expect(parts.text?.tail).toBe("Reading");
});
