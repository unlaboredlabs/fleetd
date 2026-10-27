// The Status view's answers (F6): status_get, one row per project the fixture's hub has, in every state the
// view draws, each with its work in groups. Added to the shared fixtures, plus the states only Status has: rows whose
// source went quiet, and the skeleton before the first answer.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

/** The transport's longest delay: a status_get list still unanswered when the screenshot is taken (the skeleton). */
const HOLD_MS = 600_000;
const MIN = 60_000;
/** A stamp this long before the fixture's clock: the app reads ages and day words against it. */
const ago = (f: Fixture, ms: number): string => at(f.now, -ms);

interface Project {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

/** The fixture hub's projects: its snapshot's (what the app's sidebar shows), else its project_get list answers. */
const projectsOf = (f: Fixture): Project[] => {
  const snapshot = f.snapshot?.["projects"];
  const lists: JsonValue[] = Array.isArray(snapshot)
    ? [snapshot]
    : f.answers("project_get").map((a) => (isObject(a.output) ? (a.output["projects"] ?? []) : []));
  const seen = new Map<string, Project>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!isObject(p) || typeof p["machineId"] !== "string" || typeof p["projectId"] !== "string" || typeof p["title"] !== "string") continue;
      seen.set(`${p["machineId"]}/${p["projectId"]}`, { machineId: p["machineId"], projectId: p["projectId"], title: p["title"] });
    }
  }
  return [...seen.values()];
};

const pr = (n: number): JsonObject => ({ repo: "acme/storefront", number: n, url: `https://github.com/acme/storefront/pull/${String(n)}` });
const item = (f: Fixture, group: string, title: string, minutesAgo: number, extra: JsonObject = {}): JsonObject => ({ group, title, at: ago(f, minutesAgo * MIN), ...extra });

/** One row per project, cycling through the states the view draws, so every fixture shows them all. */
const ROWS: readonly ((f: Fixture) => JsonObject)[] = [
  (f) => ({
    state: "working",
    counts: { waitingOnYou: 0, inReview: 1, working: 3, landing: 1, idle: 0, done: 11 },
    items: [
      item(f, "in_review", "Cart page keeps its scroll position", 6, { taskId: "T44", pr: pr(216) }),
      item(f, "working", "Currency export for invoices", 3, { taskId: "T47" }),
      item(f, "working", "Receipts list pages by cursor", 8, { taskId: "T46" }),
      item(f, "working", "Checkout totals round half-even", 12, { taskId: "T45", pr: pr(212) }),
      item(f, "landing", "Search index warms on deploy", 18, { taskId: "T41", pr: pr(210) }),
      item(f, "done", "Totals use integer minor units", 21, { taskId: "T39", pr: pr(208) }),
      item(f, "done", "fleetd/lead-docs", 140, { pr: pr(207) }),
    ],
    agentsRunning: 3, lastMerged: { title: "Totals use integer minor units", prNumber: 208, at: ago(f, 21 * MIN) }, merged7d: 12, throughFleetdPct7d: 66.7 }),
  (f) => ({
    state: "waiting_on_you",
    counts: { waitingOnYou: 2, inReview: 0, working: 0, landing: 0, idle: 1, done: 2 },
    items: [
      item(f, "waiting_on_you", "Deploy the export job to production", 4, { why: "approval" }),
      item(f, "waiting_on_you", "Allow writing to ~/.config/billing", 7, { taskId: "T22", why: "tool prompt" }),
      item(f, "idle", "fleetd/T19-retry", 90, { pr: pr(204), why: "CI failed" }),
      item(f, "done", "Search index warms on deploy", 3 * 1440, { taskId: "T18", pr: pr(205) }),
    ],
    agentsRunning: 0, lastMerged: { title: "Search index warms on deploy", prNumber: 205, at: ago(f, 3 * 1440 * MIN) }, merged7d: 3, throughFleetdPct7d: 33.3 }),
  // Nothing merged this week on a repo the metrics read: a real zero, with no share. The idle row's repos aren't read.
  (f) => ({
    state: "working",
    warning: "`rust (macos)` is red on main, no fix under way",
    counts: { waitingOnYou: 0, inReview: 0, working: 0, landing: 1, idle: 0, done: 0 },
    items: [item(f, "landing", "Lockfile bump for the CI image", 30, { taskId: "T9", pr: pr(88) })],
    agentsRunning: 0,
    merged7d: 0,
  }),
  () => ({ state: "idle", counts: { waitingOnYou: 0, inReview: 0, working: 0, landing: 0, idle: 0, done: 0 }, items: [], agentsRunning: 0 }),
];

type Variant = "typical" | "stale";

const rowsFor = (f: Fixture, variant: Variant): JsonObject[] =>
  projectsOf(f).map((p, i) => {
    const base = (ROWS[i % ROWS.length] ?? ROWS[0])?.(f) ?? {};
    // The hub cuts a row's title at 120 characters, as it does any title in a list.
    const title = p.title.length > 120 ? `${p.title.slice(0, 119)}…` : p.title;
    const row: JsonObject = { projectRef: { machineId: p.machineId, projectId: p.projectId }, title, asOf: f.now, ...base };
    if (variant === "stale" && i % 2 === 0) {
      const since = ago(f, 11 * MIN);
      row["stale"] = { since, reason: `no heartbeat from ${p.machineId} since ${since.slice(11, 16)}` };
    }
    return row;
  });

const answer = (f: Fixture, variant: Variant, delayMs?: number): void => {
  f.answer("status_get", {}, { rows: rowsFor(f, variant) }, delayMs);
};

const own = (what: string, note: string, base: Fixture, variant: Variant, delayMs?: number): Fixture => {
  const f = Fixture.from(base, `status-${what}`, note);
  answer(f, variant, delayMs);
  // The held answer is the state being shot, not a frame still to come: nothing to wait for before the shot.
  if (delayMs !== undefined) f.settleAt(0);
  return f;
};

export default defineGroup({
  extend: {
    typical: (f) => answer(f, "typical"),
    empty: (f) => answer(f, "typical"),
    "long-text": (f) => answer(f, "typical"),
    "many-agents": (f) => answer(f, "typical"),
  },
  fixtures: (base) => [
    own("stale", "Status: half the projects' machines went quiet.", base("typical"), "stale"),
    own("skeleton", "Status: the hub is live but hasn't answered yet: row outlines, no words or numbers.", base("typical"), "typical", HOLD_MS),
  ],
});
