// Board scenes as the hub would send them: the snapshot, the orders_board answer, order details and live frames, with
// every time relative to `now`. The screenshot suite and the fixture files are built from these; nothing here is
// real data (acme/storefront on devbox and buildbox).
import type {
  ProjectRef,
  AgentLane,
  AgentRole,
  LaneStatus,
  LiveFrame,
  LiveLane,
  MachineLive,
  OrderCard,
  OrdersBoardOutput,
  PrRef,
  SlotState,
  Spark,
  TrainLive,
} from "../../src/renderer/screens/board/contracts";

export interface Scene {
  readonly name: string;
  readonly note: string;
  readonly snapshot: {
    readonly cursor: number;
    readonly machines: readonly { machineId: string; name: string; status: string }[];
    readonly projects: readonly { machineId: string; projectId: string; title: string }[];
  };
  readonly board: OrdersBoardOutput;
  /** order_get's finished lanes per order: a board card leaves them out. */
  readonly done: Readonly<Record<string, readonly AgentLane[]>>;
  readonly live: readonly LiveFrame[];
}

const iso = (ms: number) => new Date(ms).toISOString();

const MACHINES = [
  { machineId: "devbox", name: "devbox", status: "online" },
  { machineId: "buildbox", name: "buildbox", status: "offline" },
];

const PROJECTS = [
  { machineId: "devbox", projectId: "storefront", title: "acme/storefront" },
  { machineId: "devbox", projectId: "checkout", title: "acme/checkout" },
  { machineId: "devbox", projectId: "docs", title: "acme/docs" },
  { machineId: "buildbox", projectId: "infra", title: "acme/infra" },
];

const machinesLive = (now: number, running: number): MachineLive[] => [
  {
    machineId: "devbox",
    name: "devbox",
    status: "online",
    running,
    asOf: iso(now),
    load: {
      cpus: 32,
      load1: 3.2,
      memUsedPct: 41,
      limits: [
        { limitType: "five_hour", utilization: 0.58, status: "allowed" },
        { limitType: "seven_day", utilization: 0.41, status: "allowed" },
      ],
    },
  },
  { machineId: "buildbox", name: "buildbox", status: "offline", running: 0, asOf: iso(now - 12 * 60_000) },
];

const SLOTS: SlotState = { cap: 40, used: 8, queued: 1, reservedBand: 4, perProject: [] };

/** A spark that rises and falls like real work: bursts of tool calls between quiet model turns. */
const spark = (seed: number, now: number, lived: number): Spark => ({
  endAt: iso(now - (now % 2000)),
  samples: Array.from({ length: Math.min(30, lived) }, (_, i) => Math.round(Math.abs(Math.sin(seed * 7 + i * 0.9)) * 70 * ((i + seed) % 3 === 0 ? 0.2 : 1))),
});

interface LaneSpec {
  readonly id: string;
  readonly role: AgentRole;
  readonly title: string;
  readonly status: LaneStatus;
  /** Seconds before now. */
  readonly started: number;
  readonly ended?: number;
  readonly pr?: PrRef;
  readonly activity?: NonNullable<LiveLane["activity"]>["activity"];
  /** Seconds the current step has run. */
  readonly step?: number;
  readonly tokens?: number;
  readonly reason?: string;
}

/** The project the stage's order belongs to; the fixture build points it at a project the snapshot has. */
let PROJECT: ProjectRef = { machineId: "devbox", projectId: "storefront" };
export const pointAt = (p: ProjectRef): void => {
  PROJECT = p;
};

const make = (now: number, l: LaneSpec, i: number): { lane: AgentLane; live?: LiveLane } => {
  const lane: AgentLane = {
    laneId: l.id,
    role: l.role,
    taskId: l.id,
    threadRef: { machineId: "devbox", threadId: `s-${l.id}` },
    title: l.title,
    model: "claude-haiku-5-5",
    status: l.status,
    ...(l.reason ? { statusReason: l.reason } : {}),
    startedAt: iso(now - l.started * 1000),
    ...(l.ended !== undefined ? { endedAt: iso(now - l.ended * 1000) } : {}),
    ...(l.pr ? { pr: l.pr } : {}),
  };
  if (l.status === "done" || l.status === "queued") return { lane };
  const live: LiveLane = {
    laneId: l.id,
    status: l.status,
    ...(l.activity ? { activity: { activity: l.activity, since: iso(now - (l.step ?? 3) * 1000) } } : {}),
    tokens: { input: Math.round((l.tokens ?? 4000) * 0.8), output: Math.round((l.tokens ?? 4000) * 0.2), cacheRead: 0, live: true },
    spark: spark(i + 1, now, Math.ceil(l.started / 2)),
  };
  return { lane: { ...lane, live }, live };
};

const pr = (n: number, state: PrRef["state"], taskId: string, done = 0): PrRef => ({
  changeId: `X${n}`,
  repo: "acme/storefront",
  number: n,
  url: `https://github.com/acme/storefront/pull/${n}`,
  state,
  reviewsDone: done,
  reviewsNeeded: 3,
  taskId,
});

const order = (now: number, w: string, title: string, lanes: AgentLane[], extra: Partial<OrderCard> = {}): OrderCard => ({
  workstreamId: w,
  projectRef: PROJECT,
  title,
  state: "running",
  phase: "reviewing",
  needsYou: 0,
  settled: lanes.filter((l) => l.status === "done").length,
  total: lanes.length,
  lanes,
  prs: [],
  createdAt: iso(now - 53_000),
  updatedAt: iso(now - 2_000),
  ...extra,
});

const train = (chips: TrainLive["chips"], mergedToday: number): TrainLive[] => [{ repo: "acme/storefront", frozen: false, chips, mergedToday }];

/** One order on the stage: three PRs, each with its checkers; one writer still writing; checks landing. */
export const stage = (now: number): Scene => {
  const p221 = pr(221, "ready", "T1", 2);
  const p222 = pr(222, "reviewing", "T2");
  const p223 = pr(223, "reviewing", "T3");
  const specs: LaneSpec[] = [
    { id: "T1", role: "implementer", title: "round in cart/total.ts", status: "done", started: 50, ended: 35, pr: p221 },
    { id: "T2", role: "implementer", title: "use it in discounts", status: "done", started: 50, ended: 35, pr: p222 },
    { id: "T3", role: "implementer", title: "receipts show the rounded total", status: "done", started: 50, ended: 34, pr: p223 },
    { id: "T4", role: "implementer", title: "a test for half-cent totals", status: "working", started: 20, activity: { kind: "command", text: "npm test -- cart --reporter=dot --run src/cart/total.test.ts src/cart/discounts.test.ts" }, step: 6, tokens: 2400 },
    { id: "T5", role: "reviewer", title: "review #221", status: "done", started: 20, ended: 4, pr: p221 },
    { id: "T6", role: "reviewer", title: "review #221", status: "done", started: 20, ended: 3, pr: p221 },
    { id: "T7", role: "verifier", title: "verify #221", status: "working", started: 20, pr: p221, activity: { kind: "edit", path: "src/cart/total.ts" }, tokens: 6500 },
    { id: "T8", role: "reviewer", title: "review #222", status: "working", started: 18, pr: p222, activity: { kind: "read", path: "src/cart/discounts.ts" }, tokens: 5900 },
    { id: "T9", role: "reviewer", title: "review #222", status: "working", started: 18, pr: p222, activity: { kind: "thinking" }, step: 12, tokens: 4800 },
    { id: "T10", role: "verifier", title: "verify #222", status: "working", started: 18, pr: p222, activity: { kind: "command", text: "npm run lint" }, tokens: 3600 },
    { id: "T11", role: "reviewer", title: "review #223", status: "working", started: 16, pr: p223, activity: { kind: "read", path: "src/cart/discounts.ts" }, tokens: 5500 },
    { id: "T12", role: "reviewer", title: "review #223", status: "working", started: 16, pr: p223, activity: { kind: "writing" }, tokens: 3500 },
    { id: "T13", role: "verifier", title: "verify #223", status: "working", started: 16, pr: p223, activity: { kind: "read", pattern: "fn roundTotal" }, tokens: 3600 },
  ];
  const made = specs.map((l, i) => make(now, l, i));
  // A card lists the agents at work; the finished ones come from the order's detail.
  const active = made.map((m) => m.lane).filter((l) => l.status !== "done");
  const card = order(now, "W14", "Round cart totals once, in one place", active, {
    prs: [p221, p222, p223],
    phaseDetail: "#221 ready",
    settled: made.length - active.length,
    total: made.length,
  });
  const lead: LiveLane = { laneId: `lead:${PROJECT.machineId}/${PROJECT.projectId}`.slice(0, 80), status: "working", activity: { activity: { kind: "thinking" }, since: iso(now - 4000) } };
  return {
    name: "board-stage",
    note: "One order on the stage: three PRs with their checkers, one writer still writing, two checks just landed.",
    snapshot: { cursor: 120, machines: MACHINES, projects: PROJECTS.slice(0, 1) },
    board: {
      orders: [card],
      trains: train(
        [
          { changeId: "X221", number: 221, url: p221.url, workstreamId: "W14", state: "ready" },
          { changeId: "X222", number: 222, url: p222.url, workstreamId: "W14", state: "reviewing", position: 0 },
          { changeId: "X223", number: 223, url: p223.url, workstreamId: "W14", state: "reviewing", position: 1 },
        ],
        4,
      ),
      at: iso(now),
    },
    done: { W14: made.map((m) => m.lane).filter((l) => l.status === "done") },
      live: [
      {
        at: iso(now),
        full: true,
        lanes: [...made.flatMap((m) => (m.live ? [m.live] : [])), lead],
        machines: machinesLive(now, 0),
        slots: SLOTS,
      },
    ],
  };
};

/** Every PR merged; the lead still has to close the order. */
export const finish = (now: number): Scene => {
  const base = stage(now);
  const first = base.board.orders[0];
  if (!first) throw new Error("the stage scene has no order");
  const merged = first.prs.map((p) => ({ ...p, state: "merged" as const, reviewsDone: 3 }));
  const all = [...first.lanes, ...(base.done["W14"] ?? [])];
  const lanes: AgentLane[] = all.map(({ live: _live, ...l }, i) => ({
    ...l,
    status: "done",
    endedAt: l.endedAt ?? iso(now - 20_000 + i * 100),
    ...(l.pr ? { pr: { ...l.pr, state: "merged" as const } } : {}),
  }));
  const card: OrderCard = { ...first, prs: merged, lanes: [], phase: "merging", settled: lanes.length, total: lanes.length };
  const lead: LiveLane = { laneId: `lead:${PROJECT.machineId}/${PROJECT.projectId}`.slice(0, 80), status: "working", activity: { activity: { kind: "command", text: "fleetd train status" }, since: iso(now - 3000) } };
  return {
    ...base,
    name: "board-finish",
    note: "Every PR merged and nobody at work: the finish, while the lead closes the order.",
    board: {
      ...base.board,
      orders: [card],
      trains: train(merged.map((p) => ({ changeId: p.changeId, number: p.number, url: p.url, workstreamId: "W14", state: "merged" })), 7),
    },
    done: { W14: lanes },
    live: [{ at: iso(now), full: true, lanes: [lead], machines: machinesLive(now, 0), slots: SLOTS }],
  };
};

const LONG = "Make every price on the storefront, the cart, the checkout summary and the emailed receipt come from one rounding function so a half cent never shows up differently in two places";

/** Several orders across projects: one needs you, long titles and commands, more than twenty agents. */
export const many = (now: number): Scene => {
  const orders: OrderCard[] = [];
  const frames: LiveLane[] = [];
  const projects = PROJECTS.slice(0, 3);
  let n = 0;
  projects.forEach((p, pi) => {
    for (let o = 0; o < 2; o++) {
      const w = `W${100 + pi * 2 + o}`;
      const specs: LaneSpec[] = Array.from({ length: 4 }, (_, i) => {
        const role: AgentRole = i < 2 ? "implementer" : i === 2 ? "reviewer" : "verifier";
        const activity =
          i === 0
            ? { kind: "command" as const, text: "npm test -- --runInBand --reporter verbose src/checkout/summary/rounding/half-cent-edge-cases.test.ts" }
            : i === 1
              ? { kind: "edit" as const, path: "src/checkout/summary/rounding/a-very-long-directory-name/totals-and-discounts.ts" }
              : i === 2
                ? { kind: "thinking" as const }
                : { kind: "tool" as const, name: "WebFetch", detail: "developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat" };
        return { id: `T${++n}`, role, title: `task ${n} of ${w}`, status: "working", started: 30 + i * 37, activity, step: i === 2 ? 14 : 3 };
      });
      const made = specs.map((l, i) => make(now, l, i + n));
      frames.push(...made.flatMap((m) => (m.live ? [m.live] : [])));
      orders.push({
        ...order(now, w, o === 0 && pi === 0 ? LONG : ["Cart totals round once", "Discount codes stack", "Login flow cleanup", "Docs for the payment API", "Retry flaky checkout test"][(pi * 2 + o) % 5] ?? "Order", made.map((m) => m.lane), {
          projectRef: { machineId: p.machineId, projectId: p.projectId },
          phase: "working",
          prs: o === 1 ? [pr(211 + pi, "merged", "T1"), pr(212 + pi, "reviewing", "T2", 1)] : [],
          createdAt: iso(now - (6 + pi) * 60_000),
        }),
      });
    }
  });
  return {
    name: "board-many",
    note: "Six orders over three projects, long titles and commands, 24 agents.",
    snapshot: { cursor: 300, machines: MACHINES, projects: PROJECTS },
    board: { orders, trains: train([{ changeId: "X208", number: 208, url: "https://github.com/acme/storefront/pull/208", workstreamId: "W100", state: "ci" }, { changeId: "X212", number: 212, url: "https://github.com/acme/storefront/pull/212", workstreamId: "W101", state: "reviewing", position: 1 }], 4), at: iso(now) },
    done: {},
    live: [{ at: iso(now), full: true, lanes: frames, machines: machinesLive(now, 0), slots: SLOTS }],
  };
};

export const empty = (now: number): Scene => ({
  name: "board-empty",
  note: "A new hub: no projects yet.",
  snapshot: { cursor: 1, machines: MACHINES.slice(0, 1), projects: [] },
  board: { orders: [], trains: [], at: iso(now) },
  done: {},
  live: [{ at: iso(now), full: true, lanes: [], machines: machinesLive(now, 0).slice(0, 1), slots: { ...SLOTS, used: 0, queued: 0 } }],
});

export const idle = (now: number): Scene => ({
  ...empty(now),
  name: "board-idle",
  note: "Projects, nothing running.",
  snapshot: { cursor: 2, machines: MACHINES, projects: PROJECTS },
});

export const SCENES = { stage, finish, many, empty, idle } as const;
