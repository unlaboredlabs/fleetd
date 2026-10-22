// The Status view's answers (F6): status_projects, one row per project the fixture's hub has, in every state the
// view draws. Added to the shared fixtures, plus the states only Status has: rows whose source went quiet, every
// project still planning or with nothing to count, and the skeleton before the first answer.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

/** The transport's longest delay: a status_projects still unanswered when the screenshot is taken (the skeleton). */
const HOLD_MS = 600_000;
const at = (hm: string, day = "2026-10-19"): string => `${day}T${hm}.000Z`;

interface Project {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

/** The fixture hub's projects: its snapshot's (what the app's sidebar shows), else its projects_list answers. */
const projectsOf = (f: Fixture): Project[] => {
  const snapshot = f.snapshot?.["projects"];
  const lists: JsonValue[] = Array.isArray(snapshot)
    ? [snapshot]
    : f.answers("projects_list").map((a) => (isObject(a.output) ? (a.output["projects"] ?? []) : []));
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

const estimate = (pct: number, verifiedPct: number, inFlightPct: number): JsonObject => ({ pct, verifiedPct, inFlightPct, weights: "project" });

/** One row per project, cycling through the states the view draws, so every fixture shows them all. */
const ROWS: readonly ((p: Project) => JsonObject)[] = [
  () => ({ state: "working", progress: estimate(78, 58, 20), agentsRunning: 3, lastMerged: { title: "Totals use integer minor units", prNumber: 208, at: at("09:46:12") } }),
  () => ({ state: "waiting_on_you", progress: estimate(64, 52, 12), agentsRunning: 0, lastMerged: { title: "Search index warms on deploy", prNumber: 205, at: at("15:12:40", "2026-10-16") } }),
  () => ({ state: "blocked", blockedReason: "main CI is red: rust (macos)", progress: estimate(31, 31, 0), agentsRunning: 0 }),
  () => ({ state: "idle", agentsRunning: 0 }),
];

type Variant = "typical" | "stale" | "planning";

const rowsFor = (f: Fixture, variant: Variant): JsonObject[] =>
  projectsOf(f).map((p, i) => {
    const base = (ROWS[i % ROWS.length] ?? ROWS[0])?.(p) ?? {};
    // The hub cuts a row's title at 120 characters, as it does any title in a list.
    const title = p.title.length > 120 ? `${p.title.slice(0, 119)}…` : p.title;
    const row: JsonObject = { projectRef: { machineId: p.machineId, projectId: p.projectId }, title, asOf: at("10:07:10"), ...base };
    if (variant === "planning") {
      row["progress"] = { ...estimate(0, 0, 0), planning: { active: true, pct: 55, sharePct: 8, since: at("09:59:00") } };
      row["state"] = "working";
    }
    if (variant === "stale" && i % 2 === 0) row["stale"] = { since: at("09:55:45"), reason: `no heartbeat from ${p.machineId} since 09:55` };
    return row;
  });

const answer = (f: Fixture, variant: Variant, delayMs?: number): void => {
  f.answer("status_projects", {}, { rows: rowsFor(f, variant) }, delayMs);
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
    own("planning", "Status: every lead is still planning: no numbers, a planning word.", base("typical"), "planning"),
    own("skeleton", "Status: the hub is live but hasn't answered yet: row outlines, no words or numbers.", base("typical"), "typical", HOLD_MS),
  ],
});
