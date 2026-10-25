// The Activity tab's answers (events_list) for the first project, storefront: three days of what happened, newest
// first, in two pages as the hub pages them. Agents started, finished and failed, a PR reviewed three times and then
// merged, a change the train sent back and one it refused, a secret and an approval asked and answered, an order
// opened, a decision, and a device paired (one of the hub's own events). Added to typical, and to long-text with
// long titles and reasons; the group's own cover nothing happened yet, the read on its way, a read that fails, and
// a hub from before events_list.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject } from "../kit/chat.ts";
import type { JsonObject } from "../kit/json.ts";
import { LONG_PARAGRAPH, LONG_TITLES, ofLength } from "../kit/text.ts";

const REPO = "acme/storefront";
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** The newest event's seq: the feed's seqs count down from it. */
export const ACTIVITY_TOP = 4_180;
/** The seq the screenshots mark as last seen, so "Since you last looked" sits under the morning's first events. */
export const ACTIVITY_SEEN = ACTIVITY_TOP - 10;

interface Spec {
  readonly minutesAgo: number;
  readonly type: string;
  readonly summary: string;
  readonly data?: JsonObject;
  /** One of the hub's own events: no machine, no project. */
  readonly hub?: true;
}

const titles = (long: boolean) => ({
  receipts: long ? LONG_TITLES[0] : "Receipt dates use the shop's own time zone",
  cart: long ? LONG_TITLES[3] : "Cart page keeps items across devices",
  cartApi: "Cart API merges guest and account carts",
  exportJob: long ? LONG_TITLES[4] : "Nightly export resumes after a crash",
  order: long ? LONG_TITLES[1] : "Carts that follow you between devices",
});

/** Newest first. */
const specs = (long: boolean): Spec[] => {
  const t = titles(long);
  const task = (id: string, w: string, extra: JsonObject = {}): JsonObject => ({ taskId: id, workstreamId: w, ...extra });
  const review = (id: string, blocking: number) => ({ taskId: id, workstreamId: "W4", prHeadSha: "4be1c0de9a7f", blocking, nonBlocking: 1, pr: url(212) });
  return [
    { minutesAgo: 8, type: "pr.merged", summary: `C9 merged: ${REPO}#212 as 9c2e4a1`, data: { changeId: "C9", workstreamId: "W4", repo: REPO, prNumber: 212, base: "main", mergedSha: "9c2e4a1" } },
    { minutesAgo: 25, type: "review.verdict", summary: "T44 review verdict: 0 blocking, 1 non-blocking", data: review("T44", 0) },
    { minutesAgo: 32, type: "review.verdict", summary: "T43 review verdict: 1 blocking, 1 non-blocking", data: review("T43", 1) },
    { minutesAgo: 49, type: "review.verdict", summary: "T42 review verdict: 2 blocking, 1 non-blocking", data: review("T42", 2) },
    { minutesAgo: 60, type: "change.queued", summary: `C9 queued: ${REPO}#212`, data: { changeId: "C9", workstreamId: "W4", repo: REPO, prNumber: 212 } },
    { minutesAgo: 78, type: "task.completed", summary: `T14 completed: ${t.receipts}`, data: task("T14", "W4") },
    { minutesAgo: 100, type: "request.updated", summary: "R7 stored: secret STRIPE_TEST_KEY", data: { requestId: "R7", kind: "secret", state: "stored", workstreamId: "W5", by: "human:desk" } },
    { minutesAgo: 104, type: "request.opened", summary: "R7 open: secret STRIPE_TEST_KEY", data: { requestId: "R7", kind: "secret", state: "open", workstreamId: "W5" } },
    { minutesAgo: 120, type: "task.started", summary: `T16 started (high): ${t.cartApi}`, data: task("T16", "W5") },
    { minutesAgo: 121, type: "task.started", summary: `T15 started (high): ${t.cart}`, data: task("T15", "W5") },
    {
      minutesAgo: 140,
      type: "change.ci_failed",
      summary: long ? `C8 ${ofLength(LONG_PARAGRAPH, 180)}` : "C8 CI failed: test (node 24)",
      data: { changeId: "C8", workstreamId: "W3", checks: long ? ["test (node 24, ubuntu-latest, shard 3 of 4)", "e2e (checkout, webkit)"] : ["test (node 24)"] },
    },
    // Yesterday.
    { minutesAgo: 16 * 60 - 10, type: "request.updated", summary: "R6 ran: pnpm db:migrate", data: { requestId: "R6", kind: "approval", state: "ran", by: "human:desk" } },
    { minutesAgo: 16 * 60 - 1, type: "request.opened", summary: "R6 open: pnpm db:migrate", data: { requestId: "R6", kind: "approval", state: "open" } },
    { minutesAgo: 17 * 60 + 28, type: "task.failed", summary: `T13 failed: ${t.exportJob}`, data: task("T13", "W3") },
    {
      minutesAgo: 18 * 60 + 10,
      type: "change.refused",
      summary: `Refused ${url(208)}: its branch isn't one fleetd wrote`,
      data: { prUrl: url(208), fix: long ? ofLength(LONG_PARAGRAPH, 160) : "Open it from a fleetd/ branch, or merge it yourself." },
    },
    { minutesAgo: 19 * 60 + 30, type: "workstream.created", summary: `W5 created: ${t.order}`, data: { workstreamId: "W5" } },
    { minutesAgo: 20 * 60 + 20, type: "key.paired", summary: "Pixel phone paired with the hub", data: { keyId: "k-7f3a", deviceName: "Pixel phone" }, hub: true },
    { minutesAgo: 23 * 60 + 30, type: "decision.recorded", summary: "D4 merge.style = squash", data: { decisionId: "D4", key: "merge.style", scope: "project" } },
    // Saturday: the second page.
    { minutesAgo: 2 * 24 * 60 + 60, type: "workstream.done", summary: "W2 done: the receipts redesign shipped", data: { workstreamId: "W2", reason: "The receipts redesign shipped", by: "lead" } },
    { minutesAgo: 2 * 24 * 60 + 95, type: "pr.merged_outside", summary: `${REPO}#205 merged outside the train`, data: { repo: REPO, prNumber: 205, base: "main" } },
    { minutesAgo: 2 * 24 * 60 + 130, type: "task.cancelled", summary: "T11 cancelled: Try a second receipt layout", data: task("T11", "W2") },
  ];
};

/** The events, numbered down from ACTIVITY_TOP, at times before the fixture's now. */
const events = (f: Fixture, long: boolean): JsonObject[] => {
  const project = firstProject(f);
  const now = Date.parse(f.now);
  return specs(long).map((s, i) => ({
    seq: ACTIVITY_TOP - i,
    at: new Date(now - s.minutesAgo * 60_000).toISOString(),
    type: s.type,
    summary: s.summary,
    ...(s.hub === true ? {} : { machineId: project.machineId, projectId: project.projectId }),
    ...(s.data === undefined ? {} : { data: s.data }),
  }));
};

/** Today and yesterday on the first page, Saturday on the second, as `before` asks. */
const answer = (f: Fixture, long: boolean, delayMs?: number): Fixture => {
  const all = events(f, long);
  const first = all.slice(0, 18);
  const last = first[first.length - 1];
  const projectRef = firstProject(f);
  // Main answers with the first call that matches: the page that names `before` goes first.
  if (last !== undefined) f.answer("events_list", { projectRef, before: last["seq"] as number }, { events: all.slice(18), more: false }, delayMs);
  return f.answer("events_list", { projectRef }, { events: first, more: true }, delayMs);
};

export default defineGroup({
  extend: {
    typical: (f) => void answer(f, false),
    "long-text": (f) => void answer(f, true),
  },
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("typical"), "activity-none", "Nothing has happened in storefront yet.");
      const { projectId } = firstProject(f);
      // Nor does anything stream in: typical's own events for storefront go too.
      f.events = f.events.filter((e) => e["projectId"] !== projectId);
      f.timeline = f.timeline.filter((t) => t.kind !== "event" || t.payload["projectId"] !== projectId);
      f.drop("events_list");
      return f.answer("events_list", { projectRef: firstProject(f) }, { events: [], more: false });
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "activity-loading", "storefront's activity still on its way from the hub.");
      f.drop("events_list");
      // The answers never come in a shot: shoot without waiting for them.
      return answer(f, false, 600_000).settleAt(0);
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "activity-error", "Reading storefront's activity fails.");
      f.drop("events_list");
      // The read is tried three times before the pane says it failed (src/data/queries.ts): shoot after the last.
      f.fail("events_list", { projectRef: firstProject(f) }, { code: "failed", message: "The hub couldn't read its event log: database is locked" });
      return f.settleAt(5_000);
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "activity-old-hub", "A hub from before events_list: it has no such tool.");
      f.drop("events_list");
      return f.fail("events_list", undefined, { code: "not_found", message: "No tool events_list.", fix: "Use a tool name from the hub's MCP tool list." });
    })(),
  ],
});
