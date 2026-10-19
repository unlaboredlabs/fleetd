// Screenshot and bench data for the time inspector, shaped as the hub's time_* tools return it. One finished order,
// W8 in storefront, is laid down span by span so its lanes tile and its critical path adds up to its wall time; a
// week of the fleet is made of orders like it. The roll-ups here stand in for the hub's so the numbers on screen
// agree with the bars; they are fixture data, not the hub's rules. Ported from the GPUI app's time/fixture.rs.
// Value imports carry ".ts": `pnpm fixtures` runs this file under plain Node (fixtures/time/index.ts).
import { NO_NAMES, KIND_WORD, SHOWN, categoryKinds, fmtDur, type Names } from "./format.ts";
import {
  KIND_CATEGORY,
  type AgentRole,
  type CategoryTotal,
  type CommandStat,
  type CriticalPath,
  type Gap,
  type InsightRule,
  type Insight,
  type InsightNumber,
  type Span,
  type SpanExtra,
  type SpanKind,
  type TailItem,
  type TimeBreakdownInput,
  type TimeBreakdownOutput,
  type TimeInsightsInput,
  type TimeSpansInput,
} from "./types.ts";

export const FIXTURE_ORDER = "W8";
export const FIXTURE_NOW = Date.parse("2026-10-18T10:30:00.000Z");
const MIN = 60_000;
const PAGES = ["about", "pricing", "contact"] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Draft = Mutable<Span> & { extra?: SpanExtra };

/** mulberry32: small, seeded, the same sequence on every machine. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Lane {
  lane: string;
  machine?: string;
  project: string;
  order: string;
  task?: string;
  thread?: string;
  role?: AgentRole;
}

class Gen {
  out: Draft[] = [];
  id: number;
  next: () => number;
  readonly dense: number;
  /** The full-suite command, long in the long-text fixture. */
  readonly suite: string;
  constructor(seed: number, dense: number, suite = "npm test") {
    this.id = seed * 100_000;
    this.next = rng(seed);
    this.dense = dense;
    this.suite = suite;
  }
  r(lo: number, hi: number) {
    return lo + Math.floor(this.next() * Math.max(1, hi - lo));
  }
  chance(p: number) {
    return this.next() < p;
  }
  span(l: Lane, kind: SpanKind, a: number, b: number, edit?: (s: Draft) => void): Draft {
    this.id += 1;
    const s: Draft = {
      id: this.id,
      kind,
      cat: KIND_CATEGORY[kind],
      lane: l.lane,
      startMs: a,
      endMs: b,
      exclMs: b - a,
      projectId: l.project,
      workstreamId: l.order,
      status: "ok",
    };
    if (l.machine !== undefined) s.machineId = l.machine;
    if (l.task !== undefined) s.taskId = l.task;
    if (l.thread !== undefined) s.threadId = l.thread;
    edit?.(s);
    this.out.push(s);
    return s;
  }
  leaf(l: Lane, kind: SpanKind, a: number, b: number, leaves: Draft[], edit?: (s: Draft) => void) {
    if (b > a) leaves.push(this.span(l, kind, a, b, edit));
  }

  /** An agent at work: startup, then messages and tool calls, every gap a `claude.other` filler, so the lane tiles. */
  work(l: Lane, from: number, to: number, suiteEvery: number, page: string): Draft[] {
    const leaves: Draft[] = [];
    const k = this.dense;
    const startup = this.r(6_000, 9_500);
    this.leaf(l, "run.startup", from, Math.min(from + startup, to), leaves);
    let c = from + startup;
    let i = 0;
    while (c < to) {
      const ft = Math.floor(this.r(1_500, 6_000) / k);
      const th = this.chance(0.6) ? Math.floor(this.r(2_000, 15_000) / k) : 0;
      const out = Math.floor(this.r(2_500, 20_000) / k);
      const end = Math.min(c + ft + th + out, to);
      const tokens = this.r(80, 1_400);
      const msg = this.span(l, "model.message", c, end, (s) => {
        delete s.exclMs;
        s.extra = { outputTokens: tokens, thinkingTokens: Math.floor(th / 40), stopReason: "tool_use" };
      });
      msg.itemId = `msg_${msg.id}`;
      let p = c;
      for (const [kind, d] of [["model.first_token", ft], ["model.thinking", th], ["model.output", out]] as const) {
        const q = Math.min(p + d, end);
        this.leaf(l, kind, p, q, leaves, (s) => (s.parent = msg.id));
        p = q;
      }
      c = end;
      if (c >= to) break;
      const gap = Math.floor(this.r(80, 400) / k);
      this.leaf(l, "claude.other", c, Math.min(c + gap, to), leaves);
      c += gap;
      if (c >= to) break;
      c = this.tool(l, c, to, i, suiteEvery, page, leaves);
      if (c < to) {
        const g2 = Math.floor(this.r(60, 300) / k);
        this.leaf(l, "claude.other", c, Math.min(c + g2, to), leaves);
        c += g2;
      }
      i += 1;
    }
    return leaves;
  }

  tool(l: Lane, c: number, to: number, i: number, suiteEvery: number, page: string, leaves: Draft[]): number {
    const k = this.dense;
    const roll = this.r(0, 100);
    const file = `src/pages/${page}.tsx`;
    let pick: [SpanKind, string, string, number, number, number];
    if (i % suiteEvery === suiteEvery - 1) pick = ["tool.bash", this.suite, "npm test", this.r(118_000, 142_000), 0.35, this.r(20_000, 60_000)];
    else if (roll < 30) pick = ["tool.read", file, "Read", this.r(150, 1_200), 0, this.r(800, 9_000)];
    else if (roll < 40) pick = ["tool.read", `Grep: ${page[0]?.toUpperCase() ?? ""}${page.slice(1)}Section`, "Grep", this.r(200, 900), 0, this.r(200, 3_000)];
    else if (roll < 62) pick = ["tool.edit", file, "Edit", this.r(200, 1_500), 0, 0];
    else if (roll < 74) pick = ["tool.bash", `npm test -- src/pages/${page}`, "npm test", this.r(6_000, 14_000), 0.2, this.r(1_000, 6_000)];
    else if (roll < 80) pick = ["git", "git status --short", "git status", this.r(200, 500), 0, this.r(40, 400)];
    else if (roll < 85) pick = ["tool.mcp", "mcp__fleetd__task_report", "mcp__fleetd__task_report", this.r(300, 900), 0, 120];
    else if (roll < 89) pick = ["tool.bash", "npm run build", "npm run", this.r(70_000, 95_000), 0.05, this.r(4_000, 12_000)];
    else if (roll < 94) pick = ["tools.parallel", "", "", 0, 0, 0];
    else pick = ["tool.bash", "npx tsc --noEmit", "npx tsc", this.r(9_000, 16_000), 0.1, this.r(100, 3_000)];
    const [kind, label, family, raw, fail, bytes] = pick;
    if (kind === "tools.parallel") {
      const durs = [this.r(200, 900), this.r(300, 1_400), this.r(250, 1_100)].map((d) => Math.floor(d / k));
      const end = Math.min(c + Math.max(...durs), to);
      const group = this.span(l, "tools.parallel", c, end);
      leaves.push(group);
      durs.forEach((d, n) => {
        const start = c + n * 4;
        const call = this.span(l, "tool.read", start, Math.min(start + d, end), (s) => {
          delete s.exclMs;
          s.parent = group.id;
          s.label = `src/pages/${PAGES[(n + i) % 3] ?? "about"}.tsx`;
          s.family = "Read";
        });
        call.itemId = `toolu_${call.id}`;
      });
      return end;
    }
    const ms = Math.max(Math.floor(raw / k), 50);
    const end = Math.min(c + ms, to);
    const failed = fail > 0 && this.chance(fail);
    const bash = kind === "tool.bash" || kind === "git";
    const claude = this.chance(0.3) ? ms - Math.min(this.r(0, 40), ms) : undefined;
    const s = this.span(l, kind, c, end, (s) => {
      s.label = label;
      s.family = family;
      if (bash) s.exitCode = failed ? 1 : 0;
      if (bytes > 0) s.outBytes = bytes;
      if (failed) s.status = "failed";
      if (claude !== undefined) s.extra = { claudeMs: claude };
    });
    s.itemId = `toolu_${s.id}`;
    leaves.push(s);
    return end;
  }
}

interface OrderSpec {
  id: string;
  title: string;
  project: string;
  machine: string;
  start: number;
  change: string;
  pr: number;
  seed: number;
  suiteEvery: number;
  tasks: number;
  slow: number;
}

const week = (): OrderSpec[] => {
  const o = (id: string, title: string, project: string, machine: string, start: string, change: string, pr: number, seed: number, suiteEvery: number, tasks: number): OrderSpec => ({
    id,
    title,
    project,
    machine,
    start: Date.parse(start),
    change,
    pr,
    seed,
    suiteEvery,
    tasks,
    slow: 1,
  });
  return [
    o("W8", "Add three short pages", "storefront", "devbox", "2026-10-18T08:10:00.000Z", "X7", 205, 11, 12, 20),
    o("W3", "Login flow cleanup", "web-app", "buildbox", "2026-10-12T14:00:00.000Z", "X2", 188, 12, 10, 60),
    o("W5", "Retry bounced digests", "mailer", "devbox", "2026-10-13T09:30:00.000Z", "X4", 194, 13, 14, 70),
    o("W6", "Faster product search", "storefront", "devbox", "2026-10-14T11:00:00.000Z", "X5", 199, 14, 11, 80),
    o("W7", "Rate limit per key", "api-proxy", "buildbox", "2026-10-16T16:20:00.000Z", "X6", 201, 15, 13, 90),
    o("W2", "Session expiry banner", "web-app", "devbox", "2026-10-17T10:05:00.000Z", "X1", 183, 16, 12, 100),
  ];
};

/** The week before, for compare: the same orders, with the full suite run more often. */
const before = (s: OrderSpec): OrderSpec => ({ ...s, start: s.start - 7 * 86_400_000, seed: s.seed + 50, suiteEvery: Math.max(5, Math.floor(s.suiteEvery / 2)), slow: 1.3 });

interface Built {
  spans: Draft[];
  path: CriticalPath;
  wall: [number, number];
  roles: Map<string, { role: AgentRole; task?: string; title: string }>;
  spec: OrderSpec;
}

/**
 * One order end to end: the lead freezes the brief, three writers (two wait for a slot), one asks you, a reviewer,
 * the PR through review, the train line, a rebase and CI with three checks, then merge. 1h42m of wall.
 */
/** Stress shapes: more agents in the order, and a long full-suite command. */
interface Shape {
  readonly agents?: number;
  readonly long?: boolean;
}

const LONG_SUITE =
  "cd /home/dev/worktrees/acme-storefront-add-three-short-pages && NODE_OPTIONS=--max-old-space-size=8192 npm test -- --runInBand --coverage --reporters=default --reporters=jest-junit --testPathIgnorePatterns=e2e --silent=false";

const isSuite = (s: Span) => s.kind === "tool.bash" && (s.label === "npm test" || s.label === LONG_SUITE);

const buildOrder = (spec: OrderSpec, dense: number, shape: Shape = {}): Built => {
  const g = new Gen(spec.seed, dense, shape.long === true ? LONG_SUITE : "npm test");
  const t0 = spec.start;
  const m = (x: number) => t0 + Math.floor(x * spec.slow * MIN);
  const thread = (task: string | undefined, id: string, role: AgentRole): Lane => ({
    lane: `thread:${spec.machine}/${id}`,
    machine: spec.machine,
    project: spec.project,
    order: spec.id,
    ...(task === undefined ? {} : { task }),
    thread: id,
    role,
  });
  const task = (k: number) => `T${spec.tasks + k}`;
  const lead = thread(undefined, `lead-${spec.project}`, "lead");
  const w = [1, 2, 3].map((k) => thread(task(k), `s-${spec.tasks + k}`, "implementer"));
  const [w0, w1, w2] = w as [Lane, Lane, Lane];
  const rev = thread(task(5), `s-${spec.tasks + 5}`, "reviewer");
  const other = (lane: string, machine?: string): Lane => ({ lane, project: spec.project, order: spec.id, ...(machine === undefined ? {} : { machine }) });
  const asks = other(`asks:${spec.id}`);
  const change = other(`change:${spec.change}`);
  const train = other(`train:acme/${spec.project}`, spec.machine);
  const path: [Draft, number, number][] = [];
  const onPath = (leaves: Draft[]) => leaves.forEach((s) => path.push([s, s.startMs, s.endMs ?? s.startMs]));

  onPath(g.work(lead, m(0), m(3), 99, "about"));
  g.work(lead, m(20), m(21), 99, "about");
  g.work(lead, m(52), m(54), 99, "about");
  g.work(lead, m(71), m(72.5), 99, "about");

  const reason = (s: Draft) => (s.extra = { reason: "slots: 40/40 in use" });
  g.work(w0, m(3), m(52), spec.suiteEvery, PAGES[0]);
  g.span(w1, "queue.slot", m(3), m(9), reason);
  g.work(w1, m(9), m(48), spec.suiteEvery + 2, PAGES[1]);
  const q = g.span(w2, "queue.slot", m(3), m(7), reason);
  path.push([q, m(3), m(7)]);
  onPath(g.work(w2, m(7), m(20), spec.suiteEvery, PAGES[2]));
  g.span(w2, "idle", m(20), m(54));
  onPath(g.work(w2, m(54), m(71), spec.suiteEvery, PAGES[2]));
  g.span(w1, "wait.retry.api", m(48), m(48.75), (s) => (s.extra = { httpStatus: 529, statedDelayMs: 30_000, attempt: 1 }));

  const b = g.span(asks, "ask.batching", m(20), m(26), (s) => (s.extra = { key: "deploy.region" }));
  path.push([b, m(20), m(26)]);
  const wa = g.span(asks, "wait.ask", m(26), m(54), (s) => (s.extra = { key: "deploy.region", decidedBy: "human", answeredBy: "you" }));
  path.push([wa, m(26), m(54)]);
  g.span(asks, "ask.info", m(31), m(32), (s) => (s.extra = { key: "copy.tone" }));

  g.work(rev, m(71), m(80), 99, PAGES[0]);
  // More writers, off the critical path, for the many-agents fixture.
  const extra = Array.from({ length: Math.max(0, (shape.agents ?? 4) - 4) }, (_, n) => thread(task(10 + n), `s-${spec.tasks + 10 + n}`, n % 4 === 3 ? "verifier" : "implementer"));
  extra.forEach((l, n) => g.work(l, m(3 + (n % 7)), m(30 + ((n * 7) % 40)), spec.suiteEvery, PAGES[n % 3] ?? "about"));
  const label = (s: Draft) => (s.label = `#${spec.pr}`);
  for (const [kind, a, z] of [["change.review", 71, 80], ["change.queue", 80, 80.4], ["change.rebase", 80.4, 81]] as const) {
    path.push([g.span(change, kind, m(a), m(z), label), m(a), m(z)]);
  }
  for (const [cmd, a, z] of [["git fetch origin", 80.4, 80.5], ["git rebase origin/main", 80.5, 80.8], ["git push --force-with-lease", 80.8, 81]] as const) {
    g.span(train, "git", m(a), m(z), (s) => {
      s.label = cmd;
      s.family = cmd.split(" ").slice(0, 2).join(" ");
      s.exitCode = 0;
    });
  }
  const ci = g.span(change, "change.ci", m(81), m(101.7), label);
  // GitHub's stamps are whole seconds.
  const sec = (x: number) => Math.floor(m(x) / 1000) * 1000;
  const e2eEnd = 101.4 - (spec.seed % 3) * 1.5;
  for (const [name, a, z] of [["lint", 81.3, 83.1], ["build", 81.4, 88.9], ["e2e (webkit)", 81.5, e2eEnd]] as const) {
    const check = g.span(change, "ci.check", sec(a), sec(z), (s) => {
      delete s.exclMs;
      s.parent = ci.id;
      s.extra = { check: name, url: `https://github.com/acme/${spec.project}/actions/runs/${9_100_000 + spec.seed * 10}` };
    });
    if (name === "e2e (webkit)") {
      path.push([ci, m(81), sec(a)], [check, sec(a), sec(z)], [ci, sec(z), m(101.7)]);
    }
  }
  const mg = g.span(change, "change.merge", m(101.7), m(102), label);
  path.push([mg, m(101.7), m(102)]);

  const totals = new Map<string, number>();
  const segments = path.map(([s, a, z]) => {
    totals.set(s.cat, (totals.get(s.cat) ?? 0) + (z - a));
    return { spanId: s.id, lane: s.lane, kind: s.kind, cat: s.cat, startMs: a, endMs: z, ...(s.label === undefined ? {} : { label: s.label }) };
  });
  const pathTotal = path.reduce((n, [, a, z]) => n + (z - a), 0);
  const agent = g.out.filter((s) => s.kind !== "idle").reduce((n, s) => n + (s.exclMs ?? 0), 0);
  const roles = new Map<string, { role: AgentRole; task?: string; title: string }>();
  roles.set(lead.thread ?? "", { role: "lead", title: "lead" });
  w.forEach((l, n) => roles.set(l.thread ?? "", { role: "implementer", task: l.task ?? "", title: `${PAGES[n] ?? "about"} page` }));
  roles.set(rev.thread ?? "", { role: "reviewer", task: rev.task ?? "", title: `review #${spec.pr}` });
  extra.forEach((l, n) => roles.set(l.thread ?? "", { role: l.role ?? "implementer", task: l.task ?? "", title: `${PAGES[n % 3] ?? "about"} page, part ${n + 2}` }));
  return {
    spans: g.out,
    path: {
      startMs: m(0),
      endMs: m(102),
      segments: segments.slice(0, 400),
      segmentsTruncated: segments.length > 400,
      totals: [...totals.entries()].map(([cat, ms]) => ({ cat: cat as Span["cat"], ms })),
      nothingRunningMs: 0,
      offPathMs: agent - pathTotal,
    },
    wall: [m(0), m(102)],
    roles,
    spec,
  };
};

const dur = (s: Span) => (s.endMs ?? s.startMs) - s.startMs;
const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const isCmd = (s: Span) => s.kind === "tool.bash" || s.kind === "git" || s.kind === "tool.mcp";

interface Data {
  spans: Span[];
  paths: CriticalPath[];
  wall: number;
  gaps: Gap[];
}

const breakdownOf = (d: Data): TimeBreakdownOutput => {
  const cats = new Map<string, { ms: number; n: number; kinds: Map<SpanKind, { ms: number; n: number }> }>();
  for (const s of d.spans) {
    if (s.exclMs === undefined || s.kind === "idle") continue;
    const c = cats.get(s.cat) ?? { ms: 0, n: 0, kinds: new Map<SpanKind, { ms: number; n: number }>() };
    cats.set(s.cat, c);
    c.ms += s.exclMs;
    c.n += 1;
    const k = c.kinds.get(s.kind) ?? { ms: 0, n: 0 };
    c.kinds.set(s.kind, k);
    k.ms += s.exclMs;
    k.n += 1;
  }
  const byCategory: CategoryTotal[] = [...cats.entries()].map(([cat, c]) => ({
    cat: cat as Span["cat"],
    ms: c.ms,
    n: c.n,
    kinds: [...c.kinds.entries()].map(([kind, k]) => ({ kind, ms: k.ms, n: k.n })),
  }));
  const cmds = new Map<string, { family: string; d: number[]; failed: number }>();
  for (const s of d.spans.filter(isCmd)) {
    const c = cmds.get(s.label ?? "") ?? { family: s.family ?? "", d: [], failed: 0 };
    cmds.set(s.label ?? "", c);
    c.d.push(dur(s));
    if (s.status === "failed") c.failed += 1;
  }
  const topCommands: CommandStat[] = [...cmds.entries()]
    .map(([label, c]) => ({ label, family: c.family, n: c.d.length, totalMs: c.d.reduce((a, b) => a + b, 0), p50Ms: median(c.d), maxMs: Math.max(...c.d), failed: c.failed }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 8);
  // Runs of one command in a session with no edit between them, at least three long.
  const repeated: { label: string; threadId: string; taskId?: string; n: number; totalMs: number }[] = [];
  const byThread = new Map<string, Span[]>();
  for (const s of d.spans) {
    if ((s.kind !== "tool.bash" && s.kind !== "tool.edit") || s.threadId === undefined) continue;
    const l = byThread.get(s.threadId) ?? [];
    byThread.set(s.threadId, l);
    l.push(s);
  }
  for (const [thread, list] of byThread) {
    list.sort((a, b) => a.startMs - b.startMs);
    let runs = new Map<string, Span[]>();
    const flush = () => {
      for (const [label, run] of runs) {
        if (run.length >= 3) repeated.push({ label, threadId: thread, ...(run[0]?.taskId === undefined ? {} : { taskId: run[0].taskId }), n: run.length, totalMs: run.reduce((a, s) => a + dur(s), 0) });
      }
      runs = new Map();
    };
    for (const s of list) {
      if (s.kind === "tool.edit") flush();
      else runs.set(s.label ?? "", [...(runs.get(s.label ?? "") ?? []), s]);
    }
    flush();
  }
  repeated.sort((a, b) => b.totalMs - a.totalMs);
  const checks = new Map<string, { d: number[]; excess: number }>();
  const byOrder = new Map<string, Span[]>();
  for (const s of d.spans.filter((s) => s.kind === "ci.check")) {
    const name = s.extra?.check ?? "";
    const c = checks.get(name) ?? { d: [], excess: 0 };
    checks.set(name, c);
    c.d.push(dur(s));
    const o = byOrder.get(s.workstreamId ?? "") ?? [];
    byOrder.set(s.workstreamId ?? "", o);
    o.push(s);
  }
  for (const list of byOrder.values()) {
    list.sort((a, b) => (a.endMs ?? 0) - (b.endMs ?? 0));
    const last = list.at(-1);
    const second = list.at(-2);
    if (last !== undefined && second !== undefined) {
      const c = checks.get(last.extra?.check ?? "");
      if (c !== undefined) c.excess += (last.endMs ?? 0) - (second.endMs ?? 0);
    }
  }
  const ciChecks = [...checks.entries()]
    .map(([name, c]) => ({ name, n: c.d.length, totalMs: c.d.reduce((a, b) => a + b, 0), p50Ms: median(c.d), maxMs: Math.max(...c.d), criticalExcessMs: c.excess }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const waits = d.spans.filter((s) => s.kind === "wait.ask");
  const longest = waits.reduce<Span | undefined>((best, s) => (best === undefined || dur(s) > dur(best) ? s : best), undefined);
  return {
    wallMs: d.wall,
    agentMs: byCategory.reduce((n, c) => n + c.ms, 0),
    byCategory,
    topCommands,
    repeated: repeated.slice(0, 5),
    ciChecks,
    humanWait: {
      totalMs: waits.reduce((n, s) => n + dur(s), 0),
      n: waits.length,
      ...(longest === undefined ? {} : { longest: { spanId: longest.id, ms: dur(longest), ...(longest.extra?.key === undefined ? {} : { label: longest.extra.key }) } }),
    },
    retentionDays: 30,
    storedBytes: d.spans.length * 170 + 38_000_000,
    coverage: { complete: d.gaps.length === 0, gaps: d.gaps },
  };
};

type Finding = { rule: Insight["rule"]; message: string; numbers: InsightNumber[]; spanIds: number[] };

const findingsOf = (d: Data, fleet: boolean): Finding[] => {
  const out: Finding[] = [];
  const suite = d.spans.filter(isSuite).sort((a, b) => a.startMs - b.startMs);
  const total = suite.reduce((n, s) => n + dur(s), 0);
  if (suite.length >= 5 && total >= 10 * MIN) {
    const last = new Map<string, number>();
    let k = 0;
    for (const s of suite) {
      const t = s.threadId ?? "";
      const prev = last.get(t);
      if (prev !== undefined && !d.spans.some((e) => e.kind === "tool.edit" && e.threadId === t && e.startMs > prev && e.startMs < s.startMs)) k += 1;
      last.set(t, s.startMs);
    }
    out.push({
      rule: "full_suite_repeat",
      message: `agents ran the full test suite \`${suite[0]?.label ?? "npm test"}\` ${suite.length}× (${fmtDur(total)}); ${k} run${k === 1 ? "" : "s"} followed no edit since the previous run`,
      numbers: [{ name: "runs", value: suite.length }, { name: "totalMs", value: total }, { name: "noEdit", value: k }],
      spanIds: suite.map((s) => s.id),
    });
  }
  const e2e = d.spans.filter((s) => s.extra?.check === "e2e (webkit)");
  const orders = new Set(e2e.map((s) => s.workstreamId));
  const excess = breakdownOf(d).ciChecks.find((c) => c.name === "e2e (webkit)")?.criticalExcessMs ?? 0;
  if (fleet && orders.size >= 2 && excess >= 3 * MIN) {
    out.push({
      rule: "ci_check_critical",
      message: `CI check \`e2e (webkit)\` adds ${fmtDur(excess)} on the critical path of ${orders.size} orders (median ${fmtDur(median(e2e.map(dur)))} per run)`,
      numbers: [{ name: "excessMs", value: excess }, { name: "orders", value: orders.size }],
      spanIds: e2e.map((s) => s.id),
    });
  }
  const waits = d.spans.filter((s) => s.kind === "wait.ask");
  const waitTotal = waits.reduce((n, s) => n + dur(s), 0);
  const longest = waits.reduce<Span | undefined>((b, s) => (b === undefined || dur(s) > dur(b) ? s : b), undefined);
  if (waitTotal >= 10 * MIN && longest !== undefined) {
    out.push({
      rule: "human_wait",
      message: `waited ${fmtDur(waitTotal)} on your answers (${waits.length} ask${waits.length === 1 ? "" : "s"}); longest: \`${longest.extra?.key ?? "an ask"}\` ${fmtDur(dur(longest))}`,
      numbers: [{ name: "totalMs", value: waitTotal }, { name: "asks", value: waits.length }],
      spanIds: waits.map((s) => s.id),
    });
  }
  const pathIds = new Set(d.paths.flatMap((p) => p.segments.map((s) => s.spanId)));
  const batching = d.spans.filter((s) => s.kind === "ask.batching" && pathIds.has(s.id));
  const bt = batching.reduce((n, s) => n + dur(s), 0);
  if (bt >= 5 * MIN) {
    out.push({ rule: "batching_delay", message: `asks sat ${fmtDur(bt)} in batches before you saw them`, numbers: [{ name: "totalMs", value: bt }], spanIds: batching.map((s) => s.id) });
  }
  const full = d.spans.filter((s) => s.kind === "slots.full");
  if (full.length > 0) {
    const ft = full.reduce((n, s) => n + dur(s), 0);
    const peak = Math.max(...full.map((s) => s.extra?.peakQueued ?? 0));
    out.push({
      rule: "slots_full",
      message: `slots were full for ${fmtDur(ft)} while ${peak} tasks queued (cap 40)`,
      numbers: [{ name: "totalMs", value: ft }, { name: "peakQueued", value: peak }],
      spanIds: [...full, ...d.spans.filter((s) => s.kind === "queue.slot")].map((s) => s.id).slice(0, 200),
    });
  }
  const top = breakdownOf(d).topCommands[0];
  if (top !== undefined) {
    out.push({
      rule: "slow_commands",
      message: `\`${top.label}\`: ${top.n}×, ${fmtDur(top.totalMs)}, median ${fmtDur(top.p50Ms)}`,
      numbers: [{ name: "runs", value: top.n }, { name: "totalMs", value: top.totalMs }],
      spanIds: d.spans.filter((s) => isCmd(s) && s.label === top.label).map((s) => s.id).slice(0, 200),
    });
  }
  const startups = d.spans.filter((s) => s.kind === "run.startup");
  const p50 = median(startups.map(dur));
  if (p50 >= 5_000) {
    out.push({
      rule: "startup",
      message: `starting claude took ${fmtDur(p50)} per run (${startups.length} runs)`,
      numbers: [{ name: "p50Ms", value: p50 }, { name: "runs", value: startups.length }],
      spanIds: startups.map((s) => s.id).slice(0, 200),
    });
  }
  if (d.gaps.length > 0) {
    out.push({ rule: "coverage", message: "timeline incomplete for 1 session (buildbox runs a fleetd older than the hub)", numbers: [{ name: "sessions", value: 1 }], spanIds: [] });
  }
  return out;
};

const zeroed = (n: readonly InsightNumber[]) => n.map((x) => ({ name: x.name, value: 0 }));

const insightsOf = (now: Data, prev: Data | undefined, fleet: boolean): Insight[] => {
  const cur = findingsOf(now, fleet);
  const old = prev === undefined ? undefined : findingsOf(prev, fleet);
  const list: Insight[] = cur.map((f) => {
    const p = old?.find((o) => o.rule === f.rule);
    const base = { ...f, spanIds: f.spanIds.slice(0, 200) };
    return old === undefined ? base : { ...base, compare: p?.numbers ?? zeroed(f.numbers), firedIn: p === undefined ? "current" : "both" };
  });
  for (const p of old ?? []) {
    if (!cur.some((c) => c.rule === p.rule)) list.push({ rule: p.rule, message: p.message, numbers: zeroed(p.numbers), spanIds: [], compare: p.numbers, firedIn: "compare" });
  }
  return list;
};

export interface FixtureOptions {
  /** Ten times the spans (short messages and calls), for the frame-budget check: about 15k spans for W8. */
  dense?: boolean;
  /** A hub with missing data: a node dropped spans from writer b's run, and the reviewer's machine ran an older fleetd. */
  gaps?: boolean;
  /** Agents in the order (default 4: three writers and a reviewer). */
  agents?: number;
  /** A long full-suite command, for the long-text fixture. */
  long?: boolean;
  /** The order has more spans than the hub reads at once. */
  capped?: boolean;
  /** The hub keeps 30 days and the order began before that. */
  detailSince?: string;
  /**
   * The hub's own projects (a recorded fixture's ids), matched to this fixture's projects by title, so a project
   * filter in the app asks with an id the answers know.
   */
  projects?: readonly { readonly machineId: string; readonly projectId: string; readonly title: string }[];
}

interface Collected extends Data {
  roles: Built["roles"];
  built: Built[];
}

const collect = (specs: OrderSpec[], only: string | undefined, dense: number, shape: Shape = {}): Collected => {
  const d: Collected = { spans: [], paths: [], wall: 0, gaps: [], roles: new Map(), built: [] };
  for (const spec of specs) {
    if (only !== undefined && spec.id !== only) continue;
    const b = buildOrder(spec, dense, shape);
    d.built.push(b);
    d.wall += b.wall[1] - b.wall[0];
    for (const [k, v] of b.roles) d.roles.set(k, v);
    d.spans.push(...b.spans);
    d.paths.push(b.path);
  }
  return d;
};

const fleetLane = (d: Data) => {
  [["2026-10-13T09:40:00.000Z", 18], ["2026-10-16T16:25:00.000Z", 12], ["2026-10-18T08:12:00.000Z", 10]].forEach(([a, mins], n) => {
    const start = Date.parse(String(a));
    d.spans.push({ id: 9_000_000 + n, kind: "slots.full", cat: "queue", lane: "fleet", startMs: start, endMs: start + Number(mins) * MIN, status: "ok", extra: { peakQueued: 3 - Math.min(n, 1), cap: 40 } });
  });
};

/** The names the live store would give W8's lanes, PR and the week's orders. */
export const fixtureNames = (): Names => {
  const specs = week();
  const d = collect(specs, undefined, 1);
  const threads = new Map<string, { role: AgentRole; taskId?: string; title: string }>();
  for (const [id, r] of d.roles) threads.set(id, { role: r.role, title: r.title, ...(r.task === undefined ? {} : { taskId: r.task }) });
  return {
    ...NO_NAMES,
    threads,
    leads: new Set(specs.map((s) => `lead-${s.project}`)),
    changes: new Map(specs.map((s) => [s.change, s.pr])),
    orders: new Map(specs.map((s) => [s.id, { title: s.title, project: s.project }])),
    projects: [...new Set(specs.map((s) => `${s.machine}/${s.project}`))].map((k) => {
      const [machineId = "", projectId = ""] = k.split("/");
      return { machineId, projectId, title: projectId };
    }),
    machines: ["devbox", "buildbox"],
  };
};

const scopeOrder = (input: { scope: TimeBreakdownInput["scope"] }) => (input.scope.kind === "order" ? input.scope.workstreamId : undefined);

/** Answers the time_* tools (and thread_window) from this fixture; undefined for any other tool. */
export const fixtureAnswers = (opts: FixtureOptions = {}): ((tool: string, input: unknown) => unknown) => {
  const dense = opts.dense === true ? 10 : 1;
  const shape: Shape = { ...(opts.agents === undefined ? {} : { agents: opts.agents }), ...(opts.long === true ? { long: true } : {}) };
  const cache = new Map<string, Collected>();
  let week_: Span[] | undefined;
  const data = (order: string | undefined, compare: boolean, scope: TimeBreakdownInput["scope"]): Collected => {
    const key = `${order ?? "*"}:${String(compare)}:${JSON.stringify(scope)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let specs = week();
    if (order !== undefined && !specs.some((s) => s.id === order)) specs = specs.slice(0, 1).map((w8) => ({ ...w8, id: order }));
    if (compare) specs = specs.map(before);
    if (scope.kind === "project") {
      const title = opts.projects?.find((p) => p.projectId === scope.projectRef.projectId)?.title ?? scope.projectRef.projectId;
      specs = specs.filter((s) => s.project === title);
    }
    if (scope.kind === "machine") specs = specs.filter((s) => s.machine === scope.machineId);
    const d = collect(specs, order, dense, shape);
    if (order === undefined && !compare) {
      fleetLane(d);
      if (scope.kind === "fleet") d.gaps.push({ why: "node_older", machineId: "buildbox", fromMs: Date.parse("2026-10-16T16:20:00.000Z"), toMs: Date.parse("2026-10-16T18:02:00.000Z") });
    }
    if (order !== undefined && opts.gaps === true) {
      const t0 = d.built[0]?.wall[0] ?? 0;
      const [a, z] = [t0 + 20 * MIN, t0 + 31 * MIN];
      d.spans.push({ id: 9_100_000, kind: "gap", cat: "idle", lane: "thread:devbox/s-22", startMs: a, endMs: z, threadId: "s-22", machineId: "devbox", workstreamId: order, status: "ok", extra: { count: 412 } });
      d.gaps.push({ why: "node_dropped", lane: "thread:devbox/s-22", machineId: "devbox", fromMs: a, toMs: z, count: 412 });
      d.gaps.push({ why: "no_node_spans", lane: "thread:buildbox/s-24", machineId: "buildbox", fromMs: t0 + 60 * MIN, toMs: t0 + 70 * MIN });
    }
    d.spans.sort((a, b) => a.id - b.id);
    cache.set(key, d);
    return d;
  };
  const coverage = (d: Data) => ({
    complete: d.gaps.length === 0,
    gaps: d.gaps,
    ...(opts.capped === true ? { capped: true } : {}),
    ...(opts.detailSince === undefined ? {} : { detailSince: opts.detailSince }),
  });
  const answer = (tool: string, input: unknown): unknown => {
    switch (tool) {
      case "time_breakdown": {
        const i = input as TimeBreakdownInput;
        const order = scopeOrder(i);
        const d = data(order, false, i.scope);
        const out: Mutable<TimeBreakdownOutput> = { ...breakdownOf(d), coverage: coverage(d) };
        if (i.compare !== undefined && order === undefined) {
          const p = breakdownOf(data(undefined, true, i.scope));
          out.compare = { since: i.compare.since, until: i.compare.until, wallMs: p.wallMs, agentMs: p.agentMs, byCategory: p.byCategory };
        }
        const path = d.paths[0];
        if (order !== undefined && path !== undefined) out.criticalPath = path;
        return out;
      }
      case "time_insights": {
        const i = input as TimeInsightsInput;
        const order = scopeOrder(i);
        const d = data(order, false, i.scope);
        const prev = i.compare !== undefined && order === undefined ? data(undefined, true, i.scope) : undefined;
        return { insights: insightsOf(d, prev, order === undefined) };
      }
      case "time_spans": {
        const i = input as TimeSpansInput;
        const order = scopeOrder(i);
        const d = data(order, false, i.scope);
        const ins = i.rule === undefined ? undefined : insightsOf(d, undefined, order === undefined).find((x) => x.rule === i.rule);
        const keep = (s: Span) =>
          (i.kinds === undefined || i.kinds.includes(s.kind)) && (ins === undefined || ins.spanIds.includes(s.id)) && s.id > (i.afterId ?? -1);
        const limit = i.limit ?? 200;
        const list = d.spans.filter(keep);
        const page = list.slice(0, limit);
        const last = page.at(-1);
        return { spans: page, ...(list.length > limit && last !== undefined ? { nextAfterId: last.id } : {}), coverage: coverage(d) };
      }
      case "thread_window": {
        const i = input as { threadId: string; itemId: string; before?: number; after?: number };
        week_ ??= collect(week(), undefined, dense, shape).spans;
        const lane = week_
          .filter((s) => s.threadId === i.threadId && s.itemId !== undefined && s.kind !== "tools.parallel")
          .sort((a, b) => a.startMs - b.startMs);
        const focus = lane.findIndex((s) => s.itemId === i.itemId);
        if (focus < 0) return { items: [] };
        const from = Math.max(0, focus - (i.before ?? 10));
        const items: TailItem[] = lane.slice(from, focus + (i.after ?? 10) + 1).map((s, n) => {
          const at = new Date(s.startMs).toISOString();
          if (s.kind === "model.message") return { kind: "message", at, role: "assistant", text: SAYS[(s.id + n) % SAYS.length] ?? "" };
          const failed = s.status === "failed";
          const tail = isSuite(s) ? (failed ? TAIL_FAIL : TAIL_PASS) : s.label === "npm run build" ? TAIL_BUILD : undefined;
          return {
            kind: "action",
            at,
            action: {
              at,
              kind: s.kind === "tool.bash" || s.kind === "git" ? "command" : s.kind === "tool.edit" ? "file_change" : "tool_call",
              status: failed ? "failed" : "completed",
              // The hub keeps 200 characters of a summary.
              summary: (s.label ?? KIND_WORD[s.kind]).slice(0, 200),
              failed,
              ...(tail === undefined ? {} : { outputTail: tail }),
              ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
            },
          };
        });
        return { items, focus: focus - from };
      }
      default:
        return undefined;
    }
  };
  return answer;
};

const SAYS = [
  "Reading the page and its test before touching the layout.",
  "The pricing table renders twice in the test; checking the fixture.",
  "Running the tests again to see if that fixed it.",
  "Edited the section heading; the test expects the old copy, updating it.",
  "Build passes. Reporting progress to the lead.",
];
const TAIL_FAIL = "FAIL src/pages/pricing.test.tsx\n  ● PricingTable › renders each plan once\n    Expected 3 rows, received 6\nTests: 1 failed, 141 passed, 142 total\nExit code 1";
const TAIL_PASS = "PASS src/pages/about.test.tsx\nPASS src/pages/pricing.test.tsx\nTests: 142 passed, 142 total\nTime: 128.4 s";
const TAIL_BUILD = "vite v6.2.0 building for production...\n✓ 412 modules transformed.\ndist/index.html 0.61 kB\n✓ built in 81.20s";

/** W8's spans and path directly, for the model's tests and the frame-budget bench. */
export const fixtureOrder = (dense = false, long = false): { spans: Span[]; path: CriticalPath } => {
  const w8 = week()[0];
  if (w8 === undefined) throw new Error("the fixture week has W8");
  const b = buildOrder(w8, dense ? 10 : 1, long ? { long: true } : {});
  return { spans: b.spans.slice().sort((a, z) => a.id - z.id), path: b.path };
};

/** One recorded answer in E0's fixture file format (`calls[]`): the input is matched partially, first match wins. */
export interface FixtureCall {
  readonly tool: string;
  readonly input?: Record<string, unknown>;
  readonly outcome: { readonly ok: true; readonly output: unknown };
}

const RULES: readonly InsightRule[] = ["full_suite_repeat", "ci_check_critical", "human_wait", "batching_delay", "slots_full", "slow_commands", "startup", "coverage"];

/**
 * The time inspector's answers for a hub fixture (E3b's kit puts them in a fixture's `calls`): W8's timeline (paged,
 * about 15k spans when dense), its breakdown and insights, and the fleet's and each project's week, with compare.
 * Inputs leave out the period (it moves with the clock), and the most specific entries come first.
 */
export const timeCalls = (opts: FixtureOptions = {}): FixtureCall[] => {
  const answer = fixtureAnswers(opts);
  const ok = (tool: string, input: Record<string, unknown>, full: Record<string, unknown>): FixtureCall => ({
    tool,
    input,
    outcome: { ok: true, output: answer(tool, { since: "2026-10-11T00:00:00.000Z", filters: {}, ...full }) },
  });
  const order = { kind: "order", workstreamId: FIXTURE_ORDER } as const;
  const names = fixtureNames();
  const projects = opts.projects ?? names.projects;
  const scopes: TimeBreakdownInput["scope"][] = [
    { kind: "fleet" },
    ...projects.map((p) => ({ kind: "project" as const, projectRef: { machineId: p.machineId, projectId: p.projectId } })),
    ...names.machines.map((m) => ({ kind: "machine" as const, machineId: m })),
  ];
  const compare = { since: "2026-10-04T00:00:00.000Z", until: "2026-10-11T00:00:00.000Z" };
  const out: FixtureCall[] = [];
  // Linked spans by rule and by a breakdown row's kinds, before the pages (whose inputs they would also match).
  for (const scope of [order, ...scopes]) {
    for (const rule of RULES) out.push(ok("time_spans", { scope, rule }, { scope, rule, limit: 500 }));
    for (const kinds of [...SHOWN.map(categoryKinds), ["ci.check" as const]]) out.push(ok("time_spans", { scope, kinds }, { scope, kinds, limit: 500 }));
  }
  // W8's pages, newest cursor first; the first page (no cursor) last.
  const pages: FixtureCall[] = [];
  let after: number | undefined;
  for (;;) {
    const input = { scope: order, ...(after === undefined ? {} : { afterId: after }) };
    const call = ok("time_spans", input, { ...input, limit: 500 });
    pages.push(call);
    const next = (call.outcome.output as { nextAfterId?: number }).nextAfterId;
    if (next === undefined) break;
    after = next;
  }
  out.push(...pages.reverse());
  for (const tool of ["time_breakdown", "time_insights"]) {
    out.push(ok(tool, { scope: order }, { scope: order }));
    for (const scope of scopes) out.push(ok(tool, { scope, compare: {} }, { scope, compare }), ok(tool, { scope }, { scope }));
  }
  // The transcript around each item a bar opens; at ten times the density, around each full-suite run only.
  for (const s of fixtureOrder(opts.dense === true, opts.long === true).spans) {
    if (s.threadId === undefined || s.itemId === undefined || s.kind === "tools.parallel") continue;
    if (opts.dense === true && !isSuite(s)) continue;
    const input = { threadId: s.threadId, itemId: s.itemId };
    out.push(ok("thread_window", input, { machineId: "devbox", ...input }));
  }
  return out;
};

/** W8's lanes as the hub's order_get would list them: thread id, role, task and title (lead included). */
export const fixtureOrderLanes = (opts: FixtureOptions = {}): { threadId: string; role: AgentRole; taskId?: string; title: string }[] => {
  const w8 = week()[0];
  if (w8 === undefined) throw new Error("the fixture week has W8");
  const b = buildOrder(w8, 1, { ...(opts.agents === undefined ? {} : { agents: opts.agents }) });
  return [...b.roles.entries()].map(([threadId, r]) => ({ threadId, role: r.role, title: r.title, ...(r.task === undefined ? {} : { taskId: r.task }) }));
};
