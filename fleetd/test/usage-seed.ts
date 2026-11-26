// A workspace with a year of history, for the Usage page's tests and screenshots: people (one removed), bots, and
// every day their orders, agents, messages to leads, approvals, merges and agent time, written straight into the
// tables that keep them, as the hub would have. Deterministic for a seed. `bun test/usage-seed.ts <home>` seeds a
// throwaway workspace's database at <home>/hub.sqlite.
import type { Database } from "bun:sqlite";
import { HubDb } from "../src/hub/store/db.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

export const MACHINE = "devbox";

export type SeedPerson = { id: string; name: string; role: "owner" | "admin" | "member"; joinedDaysAgo: number; removedDaysAgo?: number; perDay: number; bots: string[] };

export const PEOPLE: SeedPerson[] = [
  { id: "p_maya", name: "Maya Chen", role: "owner", joinedDaysAgo: 380, perDay: 3.2, bots: ["storefront", "payments", "data-pipeline"] },
  { id: "p_tom", name: "Tom Okafor", role: "admin", joinedDaysAgo: 360, perDay: 2.4, bots: ["payments", "storefront"] },
  { id: "p_priya", name: "Priya Raman", role: "member", joinedDaysAgo: 300, perDay: 2.8, bots: ["mobile-app", "storefront"] },
  { id: "p_lukas", name: "Lukas Weber", role: "member", joinedDaysAgo: 120, perDay: 1.6, bots: ["data-pipeline", "docs-site"] },
  { id: "p_sofia", name: "Sofia Alvarez", role: "member", joinedDaysAgo: 40, perDay: 1.1, bots: ["mobile-app"] },
  { id: "p_dan", name: "Dan Brooks", role: "member", joinedDaysAgo: 340, removedDaysAgo: 20, perDay: 1.3, bots: ["docs-site", "payments"] },
];

export const BOTS = ["storefront", "payments", "mobile-app", "data-pipeline", "docs-site"];
const botId = (b: string) => `prj-${b}`;

/** A small, seeded random source (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

export type Seeded = { orders: number; tasks: number; messages: number; requests: number; merges: number };

/**
 * Seeds `c` with `days` of history up to `now`, each person's orders `scale` times as many; `queued`: agents waiting
 * for a slot now, `waiting`: whether today's approvals may still wait for an answer.
 */
export function seed(c: Database, now: number, opts: { days?: number; seed?: number; scale?: number; queued?: number; waiting?: number } = {}): Seeded {
  const rnd = random(opts.seed ?? 7);
  const days = opts.days ?? 365;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: Seeded = { orders: 0, tasks: 0, messages: 0, requests: 0, merges: 0 };
  for (const p of PEOPLE) {
    c.query("INSERT INTO people (person_id, name, role, created_ms, removed_ms) VALUES (?1, ?2, ?3, ?4, ?5)").run(
      p.id,
      p.name,
      p.role,
      now - p.joinedDaysAgo * DAY,
      p.removedDaysAgo === undefined ? null : now - p.removedDaysAgo * DAY,
    );
  }
  for (const b of BOTS) {
    const data = { machineId: MACHINE, projectId: botId(b), title: b, workspaceRoot: `/home/dev/src/${b}`, threads: [], lastActivityAt: iso(now) };
    c.query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?1, ?2, ?3, ?4, ?5)").run(MACHINE, botId(b), b, iso(now), JSON.stringify(data));
  }
  const seq = new Map<string, number>();
  let wn = 0;
  let tn = 0;
  let rn = 0;
  let pr = 1000;
  const rollup = c.query(
    `INSERT INTO time_rollups (day, scope, scope_id, cat, kind, ms, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
     ON CONFLICT(day, scope, scope_id, cat, kind) DO UPDATE SET ms = ms + excluded.ms, n = n + 1`,
  );
  const working = (at: number, project: string, order: string | null, ms: number) => {
    const day = Math.floor(at / DAY);
    // Thinking, tools and starting up, as a run splits them; and a wait that the page doesn't count.
    const parts: [number, number, number][] = [
      [0, 4, Math.round(ms * 0.45)],
      [1, 10, Math.round(ms * 0.4)],
      [2, 22, Math.round(ms * 0.15)],
      [2, 25, Math.round(ms * 0.3)],
    ];
    for (const [cat, kind, v] of parts) {
      rollup.run(day, "fleet", "", cat, kind, v);
      rollup.run(day, "project", `${MACHINE}/${project}`, cat, kind, v);
      if (order !== null) rollup.run(day, "order", order, cat, kind, v);
    }
  };
  const message = (project: string, at: number, person: SeedPerson | undefined, author: "human" | "lead", text: string) => {
    const s = (seq.get(project) ?? 0) + 1;
    seq.set(project, s);
    const data = {
      messageId: `m-${project}-${s}`,
      projectRef: { machineId: MACHINE, projectId: project },
      seq: s,
      author,
      text,
      createdAt: iso(at),
      state: "final",
      ...(person === undefined ? {} : { person: { personId: person.id, name: person.name } }),
    };
    c.query("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES (?1, ?2, ?3, ?4, ?5)").run(MACHINE, project, s, at, JSON.stringify(data));
    if (author === "human") out.messages++;
  };
  const today = Math.floor(now / DAY) * DAY;
  const orderOf = (at: number, bot: string, person: SeedPerson | undefined, by: string, title: string, last: boolean) => {
    const project = botId(bot);
    wn++;
    const id = `W${wn}`;
    const stopped = rnd() < 0.03;
    const openNow = last && at > now - 6 * HOUR;
    const state = openNow ? "open" : stopped ? "stopped" : "done";
    const data = {
      workstreamId: id,
      projectRef: { machineId: MACHINE, projectId: project },
      title,
      state,
      createdAt: iso(at),
      updatedAt: iso(Math.min(now, at + 5 * HOUR)),
      source: { at: iso(at), by, channel: by.startsWith("automation") ? "automation" : "lead", text: title },
      ...(person === undefined ? {} : { startedBy: { personId: person.id, name: person.name } }),
    };
    c.query("INSERT INTO workstreams (n, machine_id, project_id, state, data, requested_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(wn, MACHINE, project, state, JSON.stringify(data), at);
    out.orders++;
    // The person's messages about it, and the lead's replies.
    if (person !== undefined) {
      const n = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const t = at + k * 25 * MIN;
        message(project, t, person, "human", "…");
        message(project, t + 2 * MIN, undefined, "lead", "…");
      }
    }
    const writers = 1 + Math.floor(rnd() * 2.4);
    let mergedAt = at;
    for (let k = 0; k < writers; k++) {
      const kinds: ("write" | "review" | "read")[] = rnd() < 0.15 ? ["read", "write", "review"] : ["write", "review"];
      for (const kind of kinds) {
        tn++;
        const start = at + (k * 40 + (kind === "review" ? 70 : kind === "read" ? 0 : 10)) * MIN;
        const work = (kind === "write" ? 25 + rnd() * 70 : kind === "review" ? 6 + rnd() * 12 : 8 + rnd() * 15) * MIN;
        const live = openNow && kind === "write" && start <= now;
        const failed = !live && rnd() < 0.02;
        const tstate = live ? "running" : failed ? "failed" : "done";
        const end = start + work * 1.6;
        const task = {
          taskId: `T${tn}`,
          workstreamId: id,
          projectRef: { machineId: MACHINE, projectId: project },
          kind,
          title: `${title} (${kind})`,
          prompt: "…",
          state: tstate,
          attempt: 1,
          createdAt: iso(start),
          startedAt: iso(start),
          ...(live ? {} : { endedAt: iso(end) }),
        };
        c.query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(
          tn,
          MACHINE,
          project,
          id,
          tstate,
          live ? null : iso(end),
          JSON.stringify(task),
        );
        out.tasks++;
        if (start <= now) working(Math.min(start, now), project, id, live ? Math.min(work, now - start) : work);
        mergedAt = Math.max(mergedAt, end);
      }
      // Most writers' PRs merge through the train; a few by hand from fleetd.
      if (state === "done" && rnd() < 0.86) {
        const ask = mergedAt + rnd() * rnd() * 10 * HOUR;
        if (ask < now) {
          pr++;
          c.query(
            `INSERT INTO metric_merges (repo, unit_key, machine_id, project_id, pr_number, merged_ms, route, workstream_id, task_id, requested_ms, src)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'train')`,
          ).run(`github.com/acme/${bot}`, `pr:${pr}`, MACHINE, project, pr, Math.round(ask), rnd() < 0.9 ? "train" : "fleetd_by_hand", id, `T${tn}`, at);
          out.merges++;
        }
      }
    }
    // Approvals and secret requests, answered by the person who started it or an admin; now and then a lead's prompt the
    // workspace closed as its run ended, which no person answered.
    if (rnd() < 0.18) {
      rn++;
      const open = openNow && (opts.waiting ?? 0) > 0 && rn % 2 === 0;
      const by = person ?? pick(PEOPLE.filter((p) => p.role !== "member"));
      const answeredAt = at + (10 + rnd() * 50) * MIN;
      const kind = rnd() < 0.8 ? "approval" : "secret";
      const closed = kind === "approval" && rnd() < 0.12;
      const answer = closed ? { answeredBy: "hub" } : { answeredBy: "human:laptop", answeredByPerson: { personId: by.id, name: by.name } };
      const data = {
        requestId: `Q${rn}`,
        projectRef: { machineId: MACHINE, projectId: project },
        workstreamId: id,
        kind,
        text: "…",
        state: open ? "open" : kind === "secret" ? "stored" : rnd() < 0.9 ? "ran" : "denied",
        createdAt: iso(at),
        ...(open || answeredAt > now ? {} : { answeredAt: iso(answeredAt), ...answer }),
      };
      if (!open && answeredAt > now) data.state = "open";
      c.query("INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(rn, `${MACHINE}/${project}`, kind, data.state, at, JSON.stringify(data));
      out.requests++;
    }
  };
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = today - d * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // A team that grew: busier through the year, with a slower stretch in late December.
    const growth = 0.55 + 0.45 * ((days - d) / days);
    for (const p of PEOPLE) {
      if (d > p.joinedDaysAgo) continue;
      if (p.removedDaysAgo !== undefined && d < p.removedDaysAgo) continue;
      const rate = p.perDay * (opts.scale ?? 1) * growth * (weekend ? 0.15 : 1);
      const n = Math.floor(rate) + (rnd() < rate % 1 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const at = dayStart + (8 + rnd() * 10) * HOUR;
        if (at > now) continue;
        orderOf(at, pick(p.bots), p, `lead:${MACHINE}/x`, "Order", d === 0 && k === n - 1);
      }
    }
    // A nightly automation, and now and then a fix the train asked for.
    const nightly = dayStart + 2 * HOUR;
    if (nightly <= now) orderOf(nightly, "storefront", undefined, "automation:au_deps", "Dependency bumps", false);
    if (rnd() < 0.12 && dayStart + 14 * HOUR <= now) orderOf(dayStart + 14 * HOUR, pick(BOTS), undefined, "hub:train", "Fix main", false);
  }
  // A lead's own working time, on its bot and not on any order.
  for (let d = days - 1; d >= 0; d--) for (const b of BOTS) working(today - d * DAY + 12 * HOUR, botId(b), null, (4 + rnd() * 20) * MIN);
  // What waits for a slot now.
  for (let q = 0; q < (opts.queued ?? 0); q++) {
    tn++;
    const task = { taskId: `T${tn}`, workstreamId: `W${wn}`, projectRef: { machineId: MACHINE, projectId: botId("storefront") }, kind: "write", title: "Queued", prompt: "…", state: "queued", attempt: 1, createdAt: iso(now - MIN) };
    c.query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?1, ?2, ?3, ?4, 'queued', ?5)").run(tn, MACHINE, botId("storefront"), `W${wn}`, JSON.stringify(task));
    out.tasks++;
  }
  return out;
}

if (import.meta.main) {
  const home = process.argv[2];
  if (home === undefined) throw new Error("usage: bun test/usage-seed.ts <workspace home>");
  const db = HubDb.open(home);
  const got = db.transaction((c) => seed(c, Date.now(), { queued: 2, waiting: 1 }));
  console.log(JSON.stringify(got));
  db.close();
}
