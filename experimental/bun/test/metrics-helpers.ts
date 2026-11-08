// The metrics tests' shared hub and fixtures (crates/fleetd/src/hub/metrics/tests.rs): a fresh hub at NOW, orders W1
// and W2 on devbox/web, Changes on acme/web, the event log, the projector run by hand and metrics_get as a caller.
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
/** Closes the hub the test made: each file's `afterEach`. */
export function done() {
  cleanup?.();
  cleanup = undefined;
}

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

export const sql = (h: H, statement: string, ...args: (string | number | null)[]) => h.db.conn.query(statement).run(...args);

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
