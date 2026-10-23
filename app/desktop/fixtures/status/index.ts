// The Status view's answers (F6): status_get, one row per project the fixture's hub has, in every state the
// view draws. Added to the shared fixtures, plus the states only Status has: rows whose source went quiet, a figure
// that holds on paused work, and the skeleton before the first answer.
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

const estimate = (pct: number, verifiedPct: number, inFlightPct: number): JsonObject => ({ pct, verifiedPct, inFlightPct });

/** One row per project, cycling through the states the view draws, so every fixture shows them all. */
const ROWS: readonly ((f: Fixture) => JsonObject)[] = [
  (f) => ({ state: "working", progress: estimate(78, 58, 20), agentsRunning: 3, lastMerged: { title: "Totals use integer minor units", prNumber: 208, at: ago(f, 21 * MIN) } }),
  (f) => ({ state: "waiting_on_you", progress: estimate(64, 52, 12), agentsRunning: 0, lastMerged: { title: "Search index warms on deploy", prNumber: 205, at: ago(f, 3 * 1440 * MIN) } }),
  () => ({ state: "blocked", blockedReason: "main CI is red: rust (macos)", progress: estimate(31, 31, 0), agentsRunning: 0 }),
  () => ({ state: "idle", agentsRunning: 0 }),
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

/**
 * The first row's project (storefront, working at 78%) with the series behind its bar (status_get): it climbed, fell
 * once when CI failed, and now holds because its agent hit a usage limit. The bar's hover shows the held marker.
 */
const paused = (base: Fixture): Fixture => {
  const f = own("paused", "Status: storefront's figure holds while its agent waits for a usage limit to reset.", base, "typical");
  const first = projectsOf(f)[0];
  if (first === undefined) throw new Error("status-paused: no project");
  const point = (minutesAgo: number, pct: number, verifiedPct: number, extra: JsonObject = {}): JsonObject => ({ at: ago(f, minutesAgo * MIN), pct, verifiedPct, ...extra });
  const series = [
    point(90, 40, 30),
    point(70, 61, 44),
    point(55, 55, 44, { drop: { reason: "ci_failed", fromPct: 61, text: "CI failed on #212" } }),
    point(30, 78, 58),
    point(12, 78, 58, { paused: "paused: an agent hit a usage limit" }),
  ];
  const row = rowsFor(f, "typical")[0];
  if (row === undefined) throw new Error("status-paused: no row");
  f.answer("status_get", { projectRef: { machineId: first.machineId, projectId: first.projectId } }, { row, series });
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
    paused(base("typical")),
    own("skeleton", "Status: the hub is live but hasn't answered yet: row outlines, no words or numbers.", base("typical"), "typical", HOLD_MS),
  ],
});
