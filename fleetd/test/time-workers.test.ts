// The Time reads run on the hub's read workers (src/hub/time/reads.ts): a fleet breakdown over weeks of spans took
// seconds, and on the main connection every other call to the hub waited behind it.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { categoryCode, categoryOf, kindCode } from "../src/hub/time/kinds.ts";
import { answer, type TimeJob } from "../src/hub/time/reads.ts";
import type { SpanKind } from "../src/shared/contracts.ts";
import { caller, testHub } from "./hub-helpers.ts";

const SPANS = 60_000;
const HOUR = 3_600_000;

/** `SPANS` spans over the last two days: model output, labelled bash commands, and CI checks of twenty orders. */
function seed(t: ReturnType<typeof testHub>) {
  const c = t.hub.db.conn;
  const now = t.clock.ms;
  c.transaction(() => {
    const label = c.query("INSERT INTO time_labels (id, hash, family, text) VALUES (?1, ?2, ?3, ?4)");
    for (let i = 1; i <= 40; i++) label.run(i, new Uint8Array([i]), `cargo test`, `cargo test -p crate${i}`);
    const order = c.query("INSERT INTO time_orders (workstream_id, machine_id, project_id, start_ms, end_ms) VALUES (?1, 'lab-a', 'p1', ?2, NULL)");
    for (let w = 1; w <= 20; w++) order.run(`W${w}`, now - 48 * HOUR);
    const span = c.query(
      `INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, excl_ms, machine_id, project_id, workstream_id, thread_id,
         lane, label_id, exit_code, status, extra, role)
       VALUES ('n:lab-a', ?1, ?2, ?3, ?4, ?5, ?6, 'lab-a', 'p1', ?7, ?8, ?9, ?10, ?11, 0, ?12, 'implementer')`,
    );
    for (let i = 0; i < SPANS; i++) {
      const kind: SpanKind = i % 10 === 0 ? "ci.check" : i % 2 === 0 ? "tool.bash" : "model.output";
      const start = now - 47 * HOUR + Math.floor((i * 46 * HOUR) / SPANS);
      const thread = `t${i % 50}`;
      const w = `W${(i % 20) + 1}`;
      span.run(
        `${thread}/s${i}`,
        kindCode(kind),
        categoryCode(categoryOf(kind)),
        start,
        start + 20_000,
        kind === "ci.check" ? 0 : 20_000,
        w,
        thread,
        `thread:lab-a/${thread}`,
        kind === "tool.bash" ? (i % 40) + 1 : null,
        kind === "tool.bash" ? i % 7 : null,
        kind === "ci.check" ? JSON.stringify({ check: `check-${(i / 10) % 5}` }) : null,
      );
    }
  })();
}

test("time reads answer on a read worker while the event loop keeps ticking, as a read on the main connection does", async () => {
  const t = testHub();
  try {
    seed(t);
    const tools = new Registry();
    registerAll(tools);
    const admin = caller("admin");
    const since = new Date(t.clock.ms - 48 * HOUR).toISOString();
    const compare = { since: new Date(t.clock.ms - 96 * HOUR).toISOString(), until: since };
    const jobs: TimeJob[] = [
      { tool: "time_breakdown", input: { scope: { kind: "fleet" }, since, compare }, caller: admin, now: t.clock.ms },
      { tool: "time_insights", input: { scope: { kind: "project", projectRef: { machineId: "lab-a", projectId: "p1" } }, since }, caller: admin, now: t.clock.ms },
      { tool: "time_spans", input: { scope: { kind: "machine", machineId: "lab-a" }, since, limit: 50, kinds: ["ci.check"] }, caller: admin, now: t.clock.ms },
    ];
    for (const job of jobs) {
      const inline = answer(t.hub.db.conn, job);
      // A read on the event loop lets no timer fire until it is done; one on a worker leaves the loop free.
      let ticks = 0;
      const tick = setInterval(() => (ticks += 1), 1);
      const out = await tools.call(t.hub, admin, job.tool, job.input);
      clearInterval(tick);
      if ("error" in out) throw new Error(`${job.tool}: ${JSON.stringify(out.error)}`);
      expect(out.output).toEqual(inline as never);
      expect(ticks).toBeGreaterThan(2);
    }
    // The breakdown found the seeded CI checks on its orders and the commands' totals.
    const b = answer(t.hub.db.conn, jobs[0]!) as { ciChecks: { name: string; n: number }[]; topCommands: unknown[] };
    expect(b.ciChecks.map((c) => c.name).sort()).toEqual(["check-0", "check-1", "check-2", "check-3", "check-4"]);
    expect(b.topCommands.length).toBeGreaterThan(0);
    // A refusal on the worker comes back as the tool's own error.
    const bad = await tools.call(t.hub, admin, "time_breakdown", { scope: { kind: "fleet" }, since, until: since });
    expect("error" in bad && bad.error.kind === "tool" ? [bad.error.error.code, bad.error.error.message] : bad).toEqual(["invalid", "until must be after since"]);
    const narrow = caller("read");
    narrow.grants = [{ role: "read", machines: ["lab-b"] }];
    const forbidden = await tools.call(t.hub, narrow, "time_breakdown", { scope: { kind: "fleet" }, since });
    expect("error" in forbidden && forbidden.error.kind === "tool" ? forbidden.error.error.code : forbidden).toBe("forbidden");
  } finally {
    t.done();
  }
});
