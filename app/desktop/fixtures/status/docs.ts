// Status docs as a hub sends them: the fleet, the storefront project and its order W14, with the progress model's
// fields (PR #169). Used by fixtures/status/index.ts (the screenshots) and by the Status view's tests, so both read
// the same answers. Plain data and no imports, so the renderer's tests can load it too.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export const DOC_NOW = "2026-10-19T10:07:12.000Z";
const at = (hm: string): string => `2026-10-19T${hm}.000Z`;
const stale = (since: string, reason: string): Obj => ({ since: at(since), reason });
const BUILDBOX = stale("09:55:45", "no heartbeat from buildbox since 09:55");
const GITHUB = stale("10:01:02", "GitHub not reached since 10:01: gh: connect: network is unreachable");

export type Kind = "fleet" | "project" | "order";
export const SCOPES: Record<Kind, Obj> = {
  fleet: { kind: "fleet" },
  project: { kind: "project", projectRef: { machineId: "devbox", projectId: "storefront" } },
  order: { kind: "order", workstreamId: "W14" },
};

/** The estimate over the morning: a steady climb, with two explained drops. */
const series = (endPct: number, endVerified: number): Json[] => {
  const n = 40;
  const points: Obj[] = [];
  for (let i = 0; i < n; i++) {
    const mins = 7 * 60 + Math.floor((i * 187) / (n - 1));
    const k = i / (n - 1);
    const pct = Math.round(endPct * k ** 0.9);
    const verified = Math.min(Math.round(endVerified * k ** 1.3), pct);
    points.push({ at: at(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`), pct, verifiedPct: verified });
  }
  const drop = (i: number, fromPct: number, reason: string, text: string): void => {
    const p = points[i];
    if (!p) return;
    p["drop"] = { reason, fromPct, text };
    p["pct"] = fromPct - 6;
    p["verifiedPct"] = Math.min(p["verifiedPct"] as number, fromPct - 6);
  };
  drop(22, 61, "ci_failed", "CI failed on #212: rust (macos)");
  drop(33, 80, "scope_change", "+3 items: currency table export added");
  const last = points[n - 1];
  if (last) last["at"] = DOC_NOW;
  return points;
};

const progress = (pct: number, done: number, total: number, est?: readonly [number, number, number], marker?: string, st?: Obj): Obj => ({
  pct,
  done,
  total,
  polishDone: 0,
  polishTotal: 0,
  asOf: at("10:07:10"),
  ...(est ? { estimate: { pct: est[0], verifiedPct: est[1], inFlightPct: est[2], weights: "project" } } : {}),
  ...(marker ? { marker: { at: at("10:00:04"), text: marker, pctBefore: pct + 5, pctAfter: pct, deltaItems: 3 } } : {}),
  ...(st ? { stale: st } : {}),
});

const needsClause = (n: number): string => (n === 0 ? "Nothing needs you." : n === 1 ? "1 decision needs you." : `${n} decisions need you.`);

/** One scope's doc; `quiet`: GitHub stopped answering for acme/storefront on top of the typical picture. `asks`:
 * the open asks the fixture's inbox holds, so Needs you and the inbox agree. */
export const statusDoc = (kind: Kind, quiet = false, asks: readonly string[] = kind === "fleet" ? ["A7", "A2", "A3"] : ["A7"]): Obj => {
  const g = quiet ? GITHUB : undefined;
  const figures: Record<Kind, readonly [number, number, number, number, number, number]> = {
    fleet: [72, 13, 18, 2, 5, 80],
    project: [64, 7, 11, 1, 3, 69],
    order: [62, 3, 5, 0, 1, 71],
  };
  const [pct, done, total, polishDone, polishTotal, was] = figures[kind];
  const estimates: Record<Kind, readonly [number, number, number]> = { fleet: [78, 58, 20], project: [71, 52, 19], order: [68, 40, 28] };
  const est = estimates[kind];
  const marker: Obj =
    kind === "order"
      ? { at: at("09:58:20"), text: "+1 item: rounding for JPY carts added", pctBefore: was, pctAfter: pct, deltaItems: 1 }
      : { at: at("10:00:04"), text: "+3 items: currency table export added", pctBefore: was, pctAfter: pct, deltaItems: 3 };
  const markers: Json[] = kind === "order" ? [marker] : [marker, { at: at("08:41:00"), text: "−1 item: W9 stopped", pctBefore: 70, pctAfter: 71, deltaItems: -1 }];
  // The hub's contract still requires `eta`; the app never shows it (no time estimates in the product), so the
  // fixtures carry the bare minimum and no times.
  const eta: Obj = { samples: { fleet: 18, project: 11, order: 6 }[kind], basis: kind };
  // The critical path and what blocks it (PM's provisional waitingOn / blocking).
  const waitingOn: Json[] =
    kind === "order"
      ? ["review of #212", "CI", "merge", "P14 JPY and KRW carts"]
      : ["P12 full lab run", "review of #212", "CI", "merge"];
  const blocking: Json[] = [
    { label: "main CI is red on acme/storefront", since: at("09:40:00") },
    ...(kind === "order" ? [{ label: "review of #212", since: at("10:03:11"), itemId: "P13", workstreamId: "W14" }] : []),
  ];
  const gates: Json[] =
    kind === "order"
      ? [
          { kind: "live", label: "review of #212", serial: true, since: at("10:03:11"), workstreamId: "W14" },
          ...(asks.length > 0 ? [{ kind: "live", label: "your answer on the health check path", serial: false, since: at("09:41:00"), workstreamId: "W14" }] : []),
        ]
      : [
          { kind: "plan", label: "P12 full lab run", serial: true, itemId: "P12", workstreamId: "W14" },
          { kind: "live", label: "CI on #212 (rust (macos) 8m)", serial: false, workstreamId: "W14" },
        ];
  const lines: Record<Kind, string> = {
    fleet: `Fixing cart rounding and speeding up product search, waiting on the full lab run. ${needsClause(asks.length)}`,
    project: `Rounding fix in review, search speedup merging; the lab run gates the rest. ${needsClause(asks.length)}`,
    order: `T31 is fixing the rounding while #212 is reviewed. ${needsClause(asks.length)}`,
  };
  const text = quiet ? `Not live: GitHub unchecked 6m. ${lines[kind]}` : lines[kind];
  const headline: Obj =
    kind === "project"
      ? { text, source: "template", reason: "facts changed, rewriting", at: at("10:07:05") }
      : { text, source: "generated", promptRef: "status.headline@3f2a9c41d0", at: at("10:06:40") };
  const since: Obj = {
    fleet: { seenAt: at("09:12:30"), merged: 7, verified: 3, started: 2, failed: 1, asked: 1, scopeItems: 3 },
    project: { seenAt: at("09:12:30"), merged: 3, verified: 2, started: 1, failed: 0, asked: 1, scopeItems: 3 },
    order: { merged: 0, verified: 0, started: 0, failed: 0, asked: 0, scopeItems: 0 },
  }[kind];
  const parts: Json[] = {
    fleet: [
      { title: "storefront", scope: SCOPES.project, progress: progress(64, 7, 11, [71, 52, 19], "+3 items", g) },
      { title: "web-app", scope: { kind: "project", projectRef: { machineId: "devbox", projectId: "web-app" } }, progress: progress(86, 6, 7, [90, 86, 4]) },
      { title: "mailer", scope: { kind: "project", projectRef: { machineId: "devbox", projectId: "mailer" } }, progress: progress(0, 0, 1, [9, 0, 9]) },
    ],
    project: [
      { title: "M1 Multi-currency checkout", milestoneId: "M1", progress: progress(58, 4, 7, [66, 48, 18], "+3 items", g) },
      { title: "M2 Search under 200 ms", milestoneId: "M2", progress: progress(75, 3, 4, [80, 70, 10]) },
    ],
    order: [{ title: "M1 Multi-currency checkout", milestoneId: "M1", progress: progress(62, 3, 5, [68, 40, 28], undefined, g) }],
  }[kind];
  const t31: Obj = {
    itemId: "P12",
    workstreamId: "W14",
    title: "Round totals per currency, not per line",
    taskIds: ["T31"],
    changeIds: [],
    stage: "first_push",
    creditPct: 46,
    steers: [{ id: "S12", text: "skip the docs page for now", stage: "acknowledged", at: at("09:50:00"), planChange: "−1 item" }],
  };
  const t33: Obj = {
    itemId: "P13",
    workstreamId: "W14",
    title: "Review #212",
    taskIds: ["T33"],
    changeIds: ["X12"],
    gate: "CI on #212",
    stage: "pr_open",
    creditPct: 61,
    slowerThanUsual: true,
  };
  const w9: Obj = {
    itemId: "P21",
    workstreamId: "W9",
    title: "Login form keeps the email on error",
    taskIds: ["T41"],
    changeIds: [],
    stage: "task_started",
    creditPct: 12,
    ...(g ? { stale: g } : {}),
  };
  const ci: Obj[] = [
    { repo: "acme/storefront", state: "red", sha: "a41c09e", failing: ["rust (macos)"], since: at("09:40:00"), asOf: at(quiet ? "10:01:02" : "10:06:58"), ...(g ? { stale: g } : {}) },
  ];
  if (kind === "fleet") ci.push({ repo: "acme/web-app", state: "green", sha: "9be20f1", failing: [], since: at("08:02:00"), asOf: at("10:06:51") });
  const staleList: Json[] = [
    { source: "machine:buildbox", ...BUILDBOX },
    { source: "usage:buildbox", since: BUILDBOX["since"] ?? null, reason: "buildbox is silent, so its usage reading is from 09:52" },
    ...(g ? [{ source: "github:acme/storefront", ...g }] : []),
  ];
  return {
    scope: SCOPES[kind],
    title: { fleet: "Fleet", project: "storefront", order: "Fix cart total rounding" }[kind],
    version: 12,
    seq: 4810,
    now: DOC_NOW,
    progress: {
      pct,
      polishPct: Math.floor((polishDone * 100) / Math.max(polishTotal, 1)),
      done,
      total,
      polishDone,
      polishTotal,
      asOf: at(quiet ? "10:01:02" : "10:07:10"),
      marker,
      estimate: {
        pct: est[0],
        verifiedPct: est[1],
        inFlightPct: est[2],
        weights: "project",
        planning: { active: false, pct: 100, sharePct: 8, since: at("07:02:00") },
        series: series(est[0], est[1]),
      },
      ...(g ? { stale: g } : {}),
    },
    markers,
    eta,
    gates,
    waitingOn,
    blocking,
    headline,
    since,
    parts,
    done: [
      { itemId: "P9", workstreamId: "W14", title: "Totals use integer minor units", doneAt: at("09:46:12"), evidence: "#208 merged by the train 09:46 · check 2 passed" },
      { itemId: "P8", workstreamId: "W12", title: "Search index warms on deploy", doneAt: at("09:12:40"), evidence: "#205 merged by the train 09:12 · check 1 passed" },
      { workstreamId: "W11", title: "Product page shows stock per size", doneAt: at("08:30:02"), evidence: "W11 verified: 3 of 3 checks passed" },
    ],
    inProgress: kind === "fleet" ? [t31, t33, w9] : [t31, t33],
    next: [
      { itemId: "P14", workstreamId: "W14", title: "JPY and KRW carts round to whole units", after: ["P12"] },
      { itemId: "P15", title: "Currency table export for finance", after: ["P12", "P14"] },
      { itemId: "P16", title: "Docs page: how totals are rounded", after: [] },
    ],
    needsYou: { count: asks.length, askIds: asks.slice(0, 10) },
    risks: [
      { rule: "ci_red_main", level: "danger", message: "main CI red on acme/storefront: rust (macos) since 09:40" },
      { rule: "machine_flaky", level: "warning", message: "buildbox went offline 3× today (last 09:55, still offline)" },
      { rule: "riskiest_item", level: "warning", message: "riskiest: P12 Round totals per currency (L, 2 failed attempts)" },
    ],
    health: {
      ci,
      machines: [
        { machineId: "devbox", status: "online", lastSeenAt: at("10:07:05"), dropsToday: 0 },
        { machineId: "buildbox", status: "offline", lastSeenAt: at("09:55:00"), dropsToday: 3, stale: BUILDBOX },
      ],
      usage: [
        { limitType: "five_hour", machineId: "devbox", utilization: 0.58, status: "allowed", observedAt: at("10:05:20") },
        { limitType: "seven_day", machineId: "buildbox", utilization: 0.41, status: "allowed", observedAt: at("09:52:30"), stale: BUILDBOX },
      ],
      slots: { running: 8, used: 8, cap: 40, queued: 1 },
    },
    stale: staleList,
    more: { done: kind === "fleet" ? 6 : 2, inProgress: 0, next: 1, risks: 0, parts: 0, stale: 0 },
  };
};

/** An order whose lead is still writing the plan: a planning bar, not 0%. */
export const planningDoc = (): Obj => ({
  ...statusDoc("order"),
  title: "Add gift cards at checkout",
  progress: {
    pct: 0,
    done: 0,
    total: 0,
    polishDone: 0,
    polishTotal: 0,
    asOf: at("10:07:10"),
    estimate: { pct: 0, verifiedPct: 0, inFlightPct: 0, weights: "fleet", planning: { active: true, pct: 55, sharePct: 8, since: at("09:59:00") } },
  },
  markers: [],
  parts: [],
  inProgress: [],
  next: [],
  done: [],
  risks: [],
  gates: [],
  waitingOn: ["the lead's plan"],
  blocking: [],
  virtualTier: "M",
  eta: { samples: 2, basis: "none" },
  headline: { text: "The lead is planning the order. Nothing needs you.", source: "template", reason: "facts changed, rewriting", at: at("10:07:05") },
  needsYou: { count: 0, askIds: [] },
  more: { done: 0, inProgress: 0, next: 0, risks: 0, parts: 0, stale: 0 },
});

/** A hub without the progress model: no estimate, stage credit, critical path or blockers (gates stand in). */
export const legacyDoc = (kind: Kind, asks?: readonly string[]): Obj => {
  const d = statusDoc(kind, false, asks);
  const strip = (p: Json | undefined): Json => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return p ?? null;
    const { estimate: _e, ...rest } = p;
    return rest;
  };
  const { waitingOn: _w, blocking: _b, ...rest } = d;
  return {
    ...rest,
    progress: strip(d["progress"]),
    parts: (d["parts"] as Obj[]).map((p) => ({ ...p, progress: strip(p["progress"]) })),
    inProgress: (d["inProgress"] as Obj[]).map(({ stage: _s, creditPct: _p, slowerThanUsual: _u, ...row }) => row),
  };
};

const LONG =
  "Switch the storefront checkout from per-line rounding to per-currency rounding, including the JPY, KRW and CLP zero-decimal currencies, the refund path and the finance export, without changing any stored order totals";

/** Long titles, headline and gates, plus wire values a newer hub might send (they must render a generic fallback). */
export const longTextDoc = (kind: Kind, asks?: readonly string[]): Obj => {
  const d = statusDoc(kind, false, asks);
  const progressDoc = d["progress"] as Obj;
  const estimate = progressDoc["estimate"] as Obj;
  const points = estimate["series"] as Obj[];
  const point = points[30];
  if (point) point["drop"] = { reason: "reason_from_a_newer_hub", fromPct: 70, text: LONG.slice(0, 120) };
  const [first, ...restRows] = d["inProgress"] as Obj[];
  const ci = (d["health"] as Obj)["ci"] as Obj[];
  return {
    ...d,
    headline: {
      ...(d["headline"] as Obj),
      text: "Rewriting the checkout rounding across the storefront, the refund service and the finance export while the full lab run on buildbox and devbox gates the release; waiting on the lab run and two reviews. 3 decisions need you.",
    },
    inProgress: [{ ...first, title: LONG.slice(0, 120), gate: "CI on #212 (rust (macos), rust (linux), lab smoke, docs build) 48m", stage: "stage_from_a_newer_hub" }, ...restRows],
    risks: [
      ...(d["risks"] as Json[]),
      { rule: "slower_than_usual", level: "warning", message: "P13 Review #212 has been in PR open 2× longer than usual" },
      { rule: "rule_from_a_newer_hub", level: "severe", message: `A risk this build doesn't know yet still shows its message: ${LONG.slice(0, 120)}` },
    ],
    health: { ...(d["health"] as Obj), ci: ci.map((c, i) => (i === 0 ? { ...c, state: "cancelled" } : c)) },
    parts: (d["parts"] as Obj[]).map((p, i) => (i === 0 ? { ...p, title: "storefront checkout and refunds, the project with the longest name on this hub so far" } : p)),
  };
};

/** A fleet with nothing on it yet. */
export const emptyDoc = (kind: Kind): Obj => ({
  ...legacyDoc(kind),
  title: { fleet: "Fleet", project: "storefront", order: "Fix cart total rounding" }[kind],
  progress: { pct: 0, done: 0, total: 0, polishDone: 0, polishTotal: 0, asOf: at("10:07:10") },
  markers: [],
  eta: { samples: 0, basis: "none" },
  gates: [],
  waitingOn: [],
  blocking: [],
  headline: { text: "Nothing running. Nothing needs you.", source: "template", reason: "no generated line yet", at: at("10:07:05") },
  since: { merged: 0, verified: 0, started: 0, failed: 0, asked: 0, scopeItems: 0 },
  parts: [],
  done: [],
  inProgress: [],
  next: [],
  needsYou: { count: 0, askIds: [] },
  risks: [],
  health: { ci: [], machines: [{ machineId: "devbox", status: "online", lastSeenAt: at("10:07:05"), dropsToday: 0 }], usage: [], slots: { running: 0, used: 0, cap: 40, queued: 0 } },
  stale: [],
  more: { done: 0, inProgress: 0, next: 0, risks: 0, parts: 0, stale: 0 },
});
