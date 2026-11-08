// The metrics tests' fleet (crates/fleetd/src/hub/metrics/tests.rs helpers): a fresh hub under $TMPDIR at NOW, the
// orders, Changes and events a week on acme/web makes, and metrics_get through the registry.
import { afterEach } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import { step } from "../src/hub/metrics/project.ts";
import * as store from "../src/hub/metrics/store.ts";
import { events } from "../src/hub/store/events.ts";
import type { HubEventType, MetricsGetOutput } from "../src/shared/contracts.ts";
import { testHub } from "./hub-helpers.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MIN = 60_000;
export const NOW = "2026-10-25T12:00:00.000Z";
export const REPO = "github.com/acme/web";
export const ms = (t: string) => Date.parse(t);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

export function hub() {
  const t = testHub(ms(NOW));
  cleanup = t.done;
  return t;
}
export type H = ReturnType<typeof hub>["hub"];

export const caller = (grants: Caller["grants"]): Caller => ({
  keyId: "k1",
  name: "desk",
  prefix: "fld_abcdef",
  createdAt: NOW,
  grants,
  kind: "human",
});
export const admin = () => caller([{ role: "admin", machines: "*" }]);

export const sql = (h: H, statement: string, ...args: (string | number)[]) => h.db.conn.query(statement).run(...args);

/** W1 the person submitted in the app; W2 the lead opened from the chat. */
export function orders(h: H) {
  for (const [n, channel, at] of [
    [1, "app", "2026-10-20T08:00:00.000Z"],
    [2, "lead", "2026-10-21T09:00:00.000Z"],
  ] as const) {
    const w = {
      workstreamId: `W${n}`,
      projectRef: { machineId: "devbox", projectId: "web" },
      title: "Checkout",
      source: { text: "Checkout", channel, by: "human", at },
      state: "open",
      createdAt: at,
      updatedAt: at,
    };
    sql(h, "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, 'devbox', 'web', 'open', ?2)", n, JSON.stringify(w));
  }
}

export function change(h: H, n: number, pr: number, w: string, task: string | undefined, state: string, created: string) {
  const c: Record<string, unknown> = {
    changeId: `X${n}`,
    projectRef: { machineId: "devbox", projectId: "web" },
    repo: "acme/web",
    prNumber: pr,
    prUrl: `https://github.com/acme/web/pull/${pr}`,
    branch: `fleetd/T${n}-x`,
    workstreamId: w,
    headSha: "b".repeat(40),
    state,
    reviews: [],
    createdAt: created,
    updatedAt: created,
  };
  if (task) c.taskId = task;
  sql(
    h,
    `INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
     VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'web', ?1, ?4)`,
    n,
    pr,
    state,
    JSON.stringify(c),
  );
}

export function event(h: H, at: string, type: string, data: unknown) {
  events(h).append({ at, type: type as HubEventType, machineId: "devbox", projectId: "web", summary: type, data });
}

/** Projects every page from `cursor`, as the projector's loop does; the cursor it ends on. */
export function projectFrom(h: H, cursor: number): number {
  for (;;) {
    const [next, more] = step(h.db, events(h), cursor);
    cursor = next;
    if (!more) return cursor;
  }
}

export const rows = (h: H) => store.merges(h.db.conn, 0, Number.MAX_SAFE_INTEGER);

export async function get(h: H, who: Caller, input: unknown): Promise<MetricsGetOutput> {
  const r = new Registry();
  registerAll(r);
  const out = await r.call(h, who, "metrics_get", input);
  if ("output" in out) return out.output as MetricsGetOutput;
  throw out.error.kind === "tool" ? out.error.error : new Error(JSON.stringify(out.error));
}

/** A week on acme/web: the train's change, two fleetd PRs merged by hand, one from outside, and a bot's PR. */
export function aWeek(h: H) {
  orders(h);
  sql(h, "INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/web', 'devbox', 'web', 0)");
  sql(h, "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (3, 'devbox', 'web', 'W2', 'done', '{}')");
  change(h, 1, 7, "W1", "T1", "merged", "2026-10-20T09:00:00.000Z");
  change(h, 2, 8, "W2", undefined, "abandoned", "2026-10-21T10:00:00.000Z");
  const moved = (at: string, from: string, to: string) =>
    event(h, at, "change.state", { changeId: "X1", workstreamId: "W1", repo: "acme/web", prNumber: 7, from, to });
  event(h, "2026-10-20T08:00:00.000Z", "workstream.created", { workstreamId: "W1" });
  moved("2026-10-20T09:30:00.000Z", "queued", "reviewing");
  moved("2026-10-20T10:00:00.000Z", "reviewing", "ready");
  // A bounce back to ready later keeps the first pass.
  moved("2026-10-20T10:30:00.000Z", "ready", "rebasing");
  moved("2026-10-20T11:00:00.000Z", "rebasing", "ready");
  event(h, "2026-10-20T12:00:00.000Z", "pr.merged", {
    changeId: "X1",
    workstreamId: "W1",
    repo: "acme/web",
    prNumber: 7,
    taskId: "T1",
    mergedSha: "A".repeat(40),
    batchPr: 12,
  });
  // Reported an hour after it merged: the git host's time counts.
  event(h, "2026-10-21T15:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 8, changeId: "X2", mergedAt: "2026-10-21T14:00:00.000Z" });
  event(h, "2026-10-22T11:00:00.000Z", "pr.merged_outside", {
    repo: "acme/web",
    prNumber: 9,
    prCreatedAt: "2026-10-22T10:00:00.000Z",
    authorKind: "human",
    mergedByKind: "human",
  });
  event(h, "2026-10-23T10:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 10, head: "fleetd/T3-fix-totals" });
  event(h, "2026-10-23T12:00:00.000Z", "pr.merged_outside", { repo: "acme/web", prNumber: 11, head: "dependabot/npm/left-pad", authorKind: "bot" });
}

export function storeRow(h: H, unit: string, route: string, mergedMs: number, w?: string) {
  h.db.transaction((c) =>
    store.upsertMerge(c, {
      repo: REPO,
      unitKey: unit,
      machineId: "devbox",
      projectId: "web",
      mergedMs,
      route,
      ...(w ? { workstreamId: w } : {}),
      src: "event",
    }),
  );
}

