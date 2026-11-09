// sessions.sqlite's growth (node/store.rs): steps older than 30 days pruned in batches, never the chat nor the steps of
// a session at work; the span outbox held to its bounds while the hub is away, with a `gap` span saying what went.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { NodeStore, SPANS_KEPT_MS } from "../../src/node/sessions/store.ts";
import type { ThreadItem } from "../../src/node/sessions/types.ts";
import { tempHome } from "../helpers.ts";

const open = () => {
  const home = tempHome();
  return { store: new NodeStore(join(home.dir, "sessions.sqlite")), home };
};

test("the items prune takes old steps in batches, but no chat nor a working session's", () => {
  const { store, home } = open();
  try {
    const item = (id: string, at: string) =>
      ({ id, runId: "r1", status: "completed", title: "", startedAt: at, completedAt: at, updatedAt: at, kind: { type: "command", command: "npm test", output: "ok", exitCode: 0 } }) as ThreadItem;
    const [old, fresh] = ["2026-09-01T10:00:00.000Z", "2026-10-30T10:00:00.000Z"];
    // More old steps than one batch, then a run that is still at work in s2.
    store.tx(() => {
      for (let n = 0; n < 1_500; n++) store.putItem("s1", item(`i${n}`, old));
    });
    store.putItem("s2", item("i0", old));
    for (let n = 0; n < 3; n++) store.putItem("s1", item(`new${n}`, fresh));
    store.db.query("INSERT INTO sessions (id, project_id, summary, local) VALUES ('s2', 'p1', '{\"activeRunId\":\"r1\"}', '{}')").run();
    store.putMessage("s1", { id: "m1", role: "user", text: "hi", createdAt: old });
    const before = "2026-10-04T10:00:00.000Z";
    let [gone, batches, after]: [number, number, number | undefined] = [0, 0, 0];
    while (after !== undefined) {
      const [n, next] = store.pruneItems(after, before);
      [gone, batches, after] = [gone + n, batches + 1, next];
    }
    expect([gone, batches]).toEqual([1_500, 5]);
    expect(store.newestItems("s1", 10)[0].map((i) => i.id)).toEqual(["new0", "new1", "new2"]);
    expect(store.item("s2", "i0")).toBeDefined();
    expect(store.message("s1", "m1")).toBeDefined();
  } finally {
    store.close();
    home.done();
  }
});

test("the span outbox keeps its newest rows and says with a gap span how many went", () => {
  const { store, home } = open();
  try {
    const now = Date.now();
    const span = (n: number, at: number) => ({ key: `k${n}`, kind: "run", sessionId: "s1", startMs: at, endMs: at, status: "ok" });
    // A week-old one goes by age; past 10 rows the oldest go by count.
    store.putSpans([span(0, now - SPANS_KEPT_MS - 1000)], now, 10);
    expect(store.spansAfter(0, 100).map(([, s]) => (s as { kind: string }).kind)).toEqual(["gap"]);
    store.spansAcked(store.spansHead());
    store.putSpans(Array.from({ length: 15 }, (_, n) => span(n + 1, now - 1000 + n)), now, 10);
    const rows = store.spansAfter(0, 100).map(([, s]) => s as { key: string; kind: string; extra?: { count: number } });
    // Ten rows: the nine newest and the gap.
    expect(rows.length).toBe(10);
    expect(rows.filter((s) => s.kind === "gap").map((s) => s.extra?.count)).toEqual([6]);
    expect(rows.filter((s) => s.kind === "run").map((s) => s.key)).toEqual(Array.from({ length: 9 }, (_, n) => `k${n + 7}`));
    // A full outbox stays full: the next span takes the oldest row's place, with one more gap.
    store.putSpans([span(16, now)], now, 10);
    expect(store.spansAfter(0, 100).length).toBe(10);
  } finally {
    store.close();
    home.done();
  }
});
