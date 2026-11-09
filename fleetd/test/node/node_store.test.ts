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
    // A full outbox stays full: the next span takes the oldest row's place, and the gap counts it.
    store.putSpans([span(16, now)], now, 10);
    const full = store.spansAfter(0, 100).map(([, s]) => s as { kind: string; extra?: { count: number } });
    expect(full.length).toBe(10);
    expect(full.filter((s) => s.kind === "gap").map((s) => s.extra?.count)).toEqual([7]);
  } finally {
    store.close();
    home.done();
  }
});

test("a full span outbox counts a long outage's drops in one gap span, and a sent gap span takes no more", () => {
  const { store, home } = open();
  try {
    const now = Date.now();
    const span = (n: number) => ({ key: `k${n}`, kind: "run", sessionId: "s1", startMs: now, endMs: now, status: "ok" });
    const gaps = () =>
      store
        .spansAfter(0, 100)
        .filter(([, s]) => (s as { kind: string }).kind === "gap")
        .map(([rid, s]) => [rid, (s as { extra: { count: number } }).extra.count]);
    store.putSpans(Array.from({ length: 10 }, (_, n) => span(n)), now, 10);
    // Full to the cap: the first span drops the two oldest, one for itself and one for the gap span; each later one
    // drops one more and raises that gap's count, and the prune ends every time. Past a cap this small the gap span
    // itself reaches the oldest end now and then, and passes its count to the next.
    for (let n = 10; n < 1_010; n++) store.putSpans([span(n)], now, 10);
    expect(store.spansAfter(0, 100).length).toBe(10);
    expect(gaps().map(([, count]) => count)).toEqual([1_001]);
    // Once a gap span is sent, the hub has it: the next drop adds a new one.
    store.spansAcked(store.spansHead());
    store.putSpans(Array.from({ length: 11 }, (_, n) => span(2_000 + n)), now, 10);
    const [[gap]] = gaps() as [[number]];
    store.putSpans([span(3_000)], now, 10, gap);
    expect(store.spansAfter(0, 100).length).toBe(10);
    expect(gaps()).toEqual([[gap, 2], [store.spansHead(), 2]]);
  } finally {
    store.close();
    home.done();
  }
});
