// The Factory screen's answers (metrics_get) for the shared fixtures: thirty days of the fleet's merges on every
// route and the person's minutes, each project's own answer, the last 90 days (weekly columns) and the period before
// for compare. Plus the Factory's own states: a repo whose reads fail beside one on a plain git host, and a range
// with no merges at all. Built by src/renderer/screens/factory/fixture.ts, seeded, so every build is the same.
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { isObject, type JsonValue } from "../kit/json.ts";
import { metricsAnswer, type FixtureProject, type MetricsFixtureOptions } from "../../src/renderer/screens/factory/fixture.ts";

const DAY = 86_400_000;

/** The hub's projects as its snapshot lists them. */
const projectsOf = (f: Fixture): FixtureProject[] => {
  const list = f.snapshot?.["projects"];
  return (Array.isArray(list) ? list : []).flatMap((p) =>
    isObject(p) && typeof p["machineId"] === "string" && typeof p["projectId"] === "string" && typeof p["title"] === "string"
      ? [{ machineId: p["machineId"], projectId: p["projectId"], title: p["title"] }]
      : [],
  );
};

/** The screen's `since` for the last `days` days: UTC midnight `days - 1` days back (QA runs in UTC). */
const sinceOf = (now: string, days: number): string => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (days - 1) * DAY).toISOString();
};

const json = (v: unknown): JsonValue => v as JsonValue;

const add = (opts: Omit<MetricsFixtureOptions, "now" | "projects"> = {}) => (f: Fixture) => {
  f.drop("metrics_get");
  const base = { ...opts, now: f.now, projects: projectsOf(f) };
  // Any range: the 30 days the screen opens on; compare adds the period before.
  f.answer("metrics_get", undefined, json(metricsAnswer(base)));
  f.answer("metrics_get", { compare: true }, json(metricsAnswer({ ...base, compare: true })));
  // The last 90 days, as weekly columns.
  f.answer("metrics_get", { since: sinceOf(f.now, 90) }, json(metricsAnswer({ ...base, days: 90 })));
  // Each project's own: its repo only, no repo table.
  for (const p of base.projects) {
    const projectRef = { machineId: p.machineId, projectId: p.projectId };
    f.answer("metrics_get", { projectRef }, json(metricsAnswer({ ...base, project: projectRef })));
  }
};

const own = (what: string, note: string, from: Fixture, opts: Omit<MetricsFixtureOptions, "now" | "projects">): Fixture => {
  const f = Fixture.from(from, `factory-${what}`, note);
  add(opts)(f);
  return f;
};

export default defineGroup({
  extend: {
    // No projects: nothing to read, and the screen says how merges get here.
    empty: add(),
    typical: add(),
    "long-text": add({ long: true }),
    "many-agents": add(),
    "status-rows": add(),
  },
  fixtures: (base) => [
    own("stale", "Factory: billing's reads fail since 05:35 and checkout is on a plain git host with no reviews.", base("typical"), { stale: true }),
    own("none", "Factory: the repos were read, and nothing merged in the range.", base("typical"), { none: true }),
  ],
});
