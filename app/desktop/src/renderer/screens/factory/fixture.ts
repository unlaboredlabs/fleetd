// metrics_get answers for the fixtures (fixtures/factory) and the tests: thirty days of a fleet's landed changes on
// every route, the person's minutes by source, a repo checked out on two machines, and the states the screen draws
// (no merges, a repo whose reads fail, a repo on a plain git host). Seeded, so every build gives the same answer.
import type {
  HumanSource,
  MetricsDay,
  MetricsGetOutput,
  MetricsMerge,
  MetricsRepoRow,
  ProjectRef,
  RepoCoverage,
  RouteCounts,
  SkipCount,
  SourceMs,
  SparkPoint,
} from "../../../shared/contracts";
import { ROUTE_FIELD, ROUTES, type Route } from "./model.ts";

export interface FixtureProject {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface MetricsFixtureOptions {
  /** The fixture's clock, ISO. */
  readonly now: string;
  readonly projects: readonly FixtureProject[];
  /** Days in the range, ending today (UTC, as QA runs). */
  readonly days?: number;
  /** One project's answer: its repo only, no repo table. */
  readonly project?: ProjectRef;
  /** No merges in the range, though the repos were read. */
  readonly none?: boolean;
  /** The second repo's reads fail; the third is on a plain git host fleetd reads no reviews from. */
  readonly stale?: boolean;
  /** Long PR titles and repo names. */
  readonly long?: boolean;
  /** Add the previous period's days. */
  readonly compare?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A small LCG: the same numbers every build. */
const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
};

const TITLES = [
  "Totals use integer minor units",
  "Receipt dates use Intl",
  "Search index warms on deploy",
  "Checkout keeps the cart across sign-in",
  "Nightly export resumes after a crash",
  "Retry webhooks with backoff",
  "Quick start opens a project's chat",
  "Drop the legacy coupon table",
  "Price badges read the locale",
  "Orders page loads in one query",
  "Fix the flaky inventory sync test",
  "Bump the image CDN timeout",
];

const LONG_TITLE =
  "Move invoice and receipt date formatting onto Intl.DateTimeFormat everywhere, keep the old helper as a thin wrapper for the mobile client until it ships, and add tests for every locale we sell in";

const slug = (title: string, long: boolean): string => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "repo";
  return long ? base.slice(0, 80).replace(/-$/u, "") : base.slice(0, 24).replace(/-$/u, "");
};

const iso = (ms: number): string => new Date(ms).toISOString();
const ymd = (ms: number): string => iso(ms).slice(0, 10);

interface Repo {
  readonly repo: string;
  readonly projects: ProjectRef[];
  readonly host: "github" | "git";
  /** Merges a day, on average, before the routes split them. */
  readonly rate: number;
}

const reposOf = (o: MetricsFixtureOptions): Repo[] => {
  const ref = (p: FixtureProject): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });
  const out: Repo[] = [];
  o.projects.slice(0, 4).forEach((p, i) => {
    const host = o.stale === true && i === 2 ? "git" : "github";
    const repo = host === "git" ? `git.example.dev/srv/${slug(p.title, o.long === true)}` : `github.com/acme/${slug(p.title, o.long === true)}`;
    out.push({ repo, projects: [ref(p)], host, rate: [3.2, 1.6, 0.9, 0.5][i] ?? 0.5 });
  });
  // The first repo is also checked out on a second machine: the same merges show under both.
  const first = out[0];
  const twin = o.projects[4];
  if (first !== undefined && twin !== undefined && !first.projects.some((r) => r.projectId === twin.projectId)) first.projects.push(ref(twin));
  return o.project === undefined ? out : out.filter((r) => r.projects.some((p) => p.machineId === o.project?.machineId && p.projectId === o.project.projectId));
};

/** How often each route lands, of a repo's merges: most through the train, some by hand, a few outside. */
const ROUTE_ODDS: readonly (readonly [Route, number])[] = [
  ["train", 0.62],
  ["fleetd_by_hand", 0.16],
  ["outside", 0.15],
  ["direct", 0.07],
];

const pick = (r: number): Route => {
  let acc = 0;
  for (const [route, p] of ROUTE_ODDS) {
    acc += p;
    if (r < acc) return route;
  }
  return "direct";
};

const median = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const p90 = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
};
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Period {
  readonly days: MetricsDay[];
  readonly merges: MetricsMerge[];
  readonly humanMs: number;
}

/** One period of days and merges, from `startMs` (UTC midnight) for `count` days, cut at `endMs`. */
const periodOf = (o: MetricsFixtureOptions, repos: readonly Repo[], startMs: number, count: number, endMs: number, seed: number, pace = 1): Period => {
  const rand = rng(seed);
  const days: MetricsDay[] = [];
  const merges: MetricsMerge[] = [];
  let pr = 180 + Math.floor(seed % 50);
  let order = 30 + (seed % 7);
  let task = 400 + (seed % 90);
  let change = 200 + (seed % 60);
  let humanMs = 0;
  for (let i = 0; i < count; i++) {
    const day0 = startMs + i * DAY;
    const merged: RouteCounts = { train: 0, fleetdByHand: 0, outside: 0, direct: 0 };
    const weekend = [0, 6].includes(new Date(day0).getUTCDay());
    let bots = 0;
    for (const repo of repos) {
      const n = o.none === true ? 0 : Math.max(0, Math.round(pace * (weekend ? 0.3 : 1) * repo.rate * (0.4 + rand() * 1.2)));
      for (let k = 0; k < n; k++) {
        const at = day0 + (8 + rand() * 10) * HOUR;
        if (at > endMs) continue;
        // A plain git host: direct pushes and outside merges can't be told apart, and both read as outside.
        let route = pick(rand());
        if (repo.host === "git" && route === "direct") route = "outside";
        merged[ROUTE_FIELD[route]] += 1;
        const fleetd = route === "train" || route === "fleetd_by_hand";
        const toMerged = Math.round((fleetd ? 25 * MIN + rand() ** 2 * 30 * HOUR : 0) / MIN) * MIN;
        const prOpen = Math.round((10 * MIN + rand() ** 2 * 8 * HOUR) / MIN) * MIN;
        const hasPr = route !== "direct" && repo.host !== "git";
        const number = hasPr ? ++pr : undefined;
        const title = o.long === true && k === 0 ? LONG_TITLE : (TITLES[Math.floor(rand() * TITLES.length)] ?? "A change");
        const requested = at - toMerged;
        const opened = at - prOpen;
        const m: MetricsMerge = {
          repo: repo.repo,
          route,
          mergedAt: iso(at),
          title,
          touches: route === "train" ? Math.floor(rand() * 2) : route === "fleetd_by_hand" ? 1 + Math.floor(rand() * 2) : 0,
          projectRef: repo.projects[0] ?? { machineId: "devbox", projectId: "p1" },
          sha: Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join(""),
          ...(number === undefined ? {} : { prNumber: number, url: `https://${repo.repo}/pull/${number}`, prCreatedAt: iso(opened), prOpenToMergedMs: prOpen }),
          ...(route === "direct" ? {} : { additions: Math.floor(4 + rand() ** 2 * 600), deletions: Math.floor(rand() ** 2 * 200) }),
          author: repo.host === "git" ? "unknown" : "human",
          mergedBy: route === "train" ? "train" : repo.host === "git" ? "unknown" : "human",
        };
        if (fleetd) {
          if (rand() < 0.6) order += 1;
          Object.assign(m, {
            workstreamId: `W${order}`,
            taskId: `T${++task}`,
            requestedAt: iso(requested),
            requestedBasis: rand() < 0.3 ? "opened" : "chat",
            orderToMergedMs: toMerged,
            firstPrAt: iso(Math.max(requested + 5 * MIN, opened)),
            ...(route === "train" ? { changeId: `X${++change}`, reviewPassedAt: iso(at - Math.min(prOpen, 20 * MIN)), ...(rand() < 0.3 ? { batchPr: pr + 1 } : {}) } : {}),
          } satisfies Partial<MetricsMerge>);
        }
        merges.push(m);
      }
      if (o.none !== true && repo.host === "github" && rand() < 0.18) bots += 1;
    }
    const human: SourceMs[] = [];
    if (o.none !== true && day0 <= endMs) {
      const add = (source: HumanSource, ms: number, touches: number) => {
        if (ms <= 0 || touches <= 0) return;
        human.push({ source, ms, touches });
        humanMs += ms;
      };
      const busy = weekend ? 0.25 : 1;
      add("chat", Math.round((busy * (6 + rand() * 30)) | 0) * MIN, Math.round(busy * (3 + rand() * 14)));
      add("reviews", Math.round(busy * rand() * 14) * MIN, Math.round(busy * rand() * 3));
      add("app", Math.round(busy * (4 + rand() * 40)) * MIN, Math.round(busy * (1 + rand() * 6)));
      if (rand() < 0.3) add("sessions", Math.round(1 + rand() * 6) * MIN, 1 + Math.floor(rand() * 5));
      add("other", Math.round(busy * rand() * 6) * MIN, Math.round(busy * rand() * 4));
    }
    const notCounted: SkipCount[] = bots > 0 ? [{ why: "bot", n: bots }] : [];
    if (o.none !== true && i % 11 === 4) notCounted.push({ why: "other_base", n: 1 });
    days.push({ day: ymd(day0), merged, notCounted, human });
  }
  return { days, merges: merges.toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt)), humanMs };
};

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Twelve slices of the range, each with `value` over its merges (undefined where nothing measures). */
const sparkOf = (startMs: number, endMs: number, merges: readonly MetricsMerge[], value: (slice: readonly MetricsMerge[], ms: number) => number | undefined): SparkPoint[] => {
  const step = (endMs - startMs) / 12;
  return Array.from({ length: 12 }, (_, i) => {
    const from = startMs + i * step;
    const slice = merges.filter((m) => {
      const t = Date.parse(m.mergedAt);
      return t >= from && t < from + step;
    });
    const v = value(slice, step);
    return { since: iso(Math.round(from)), ...(v === undefined ? {} : { value: Math.round(v * 10) / 10 }) };
  });
};

const routeCount = (merges: readonly MetricsMerge[], ...routes: Route[]) => merges.filter((m) => routes.some((r) => r === m.route)).length;

export const metricsAnswer = (o: MetricsFixtureOptions): MetricsGetOutput => {
  const count = o.days ?? 30;
  const nowMs = Date.parse(o.now);
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const startMs = today - (count - 1) * DAY;
  const repos = reposOf(o);
  const cur = periodOf(o, repos, startMs, count, nowMs, 7);
  // The period before ran a little slower, so the deltas have something to say.
  const prev = periodOf({ ...o, none: false }, repos, startMs - count * DAY, count, startMs, 3, 0.8);
  // Today counts as the hours gone, at least one.
  const spanDays = count - 1 + Math.max(1, (nowMs - today) / HOUR) / 24;

  const tile = (p: Period, days: number) => {
    const n = p.merges.length;
    const fleetd = p.merges.filter((m) => m.orderToMergedMs !== undefined);
    const times = fleetd.map((m) => m.orderToMergedMs ?? 0);
    const made = routeCount(p.merges, "train", "fleetd_by_hand");
    const outside = n - made;
    // Most of the minutes are on fleetd work; outside work shows only its merges and commits.
    const outsideMs = Math.round((p.humanMs * 0.04) / MIN) * MIN;
    return { n, perDay: round1(n / days), times, made, outside, outsideMs, fleetdMs: p.humanMs - outsideMs, train: routeCount(p.merges, "train") };
  };
  const now = tile(cur, spanDays);
  const before = tile(prev, count);
  const by = (m: readonly MetricsMerge[]): RouteCounts => ({
    train: routeCount(m, "train"),
    fleetdByHand: routeCount(m, "fleetd_by_hand"),
    outside: routeCount(m, "outside"),
    direct: routeCount(m, "direct"),
  });
  const pct = (part: number, whole: number) => (whole === 0 ? undefined : round1((part * 100) / whole));
  const perPr = (ms: number, prs: number) => (prs === 0 ? undefined : Math.round(ms / prs));
  const opt = <K extends string, V>(key: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : ({ [key]: v } as Record<K, V>));
  const endMs = nowMs;
  const lines = ROUTES.flatMap((route) => {
    const ms = cur.merges.filter((m) => m.route === route);
    return ms.length === 0 ? [] : [{ route, additions: sum(ms.map((m) => m.additions ?? 0)), deletions: sum(ms.map((m) => m.deletions ?? 0)) }];
  });

  const coverage: RepoCoverage[] = repos.map((r) => ({
    repo: r.repo,
    host: r.host,
    defaultBranch: r.host === "git" ? "trunk" : "main",
    lastRead: iso(nowMs - 2 * MIN),
    knownSince: iso(startMs - 60 * DAY),
  }));
  const staleRepo = o.stale === true ? repos[1] : undefined;
  if (staleRepo !== undefined) {
    const c = coverage.find((x) => x.repo === staleRepo.repo);
    if (c !== undefined) c.lastRead = iso(nowMs - 3 * HOUR - 28 * MIN);
  }

  const repoRows: MetricsRepoRow[] = repos.map((r) => {
    const ms = cur.merges.filter((m) => m.repo === r.repo);
    const times = ms.flatMap((m) => (m.orderToMergedMs === undefined ? [] : [m.orderToMergedMs]));
    const made = routeCount(ms, "train", "fleetd_by_hand");
    return {
      repo: r.repo,
      projects: r.projects,
      mergedPerDay: round1(ms.length / spanDays),
      n: ms.length,
      ...opt("orderToMergedMedianMs", median(times)),
      ...opt("humanPerPrMs", perPr(Math.round((now.fleetdMs * made) / Math.max(1, now.made)), made)),
      ...opt("throughFleetdPct", pct(routeCount(ms, "train"), ms.length)),
      spark: sparkOf(startMs, endMs, ms, (slice, step) => slice.length / (step / DAY)),
    };
  });

  return {
    since: iso(startMs),
    until: iso(today + DAY),
    tiles: {
      merged: {
        perDay: now.perDay,
        n: now.n,
        byRoute: by(cur.merges),
        previousPerDay: before.perDay,
        spark: sparkOf(startMs, endMs, cur.merges, (slice, step) => slice.length / (step / DAY)),
      },
      orderToMerged: {
        ...opt("medianMs", median(now.times)),
        ...opt("p90Ms", p90(now.times)),
        n: now.times.length,
        fromOpened: cur.merges.filter((m) => m.requestedBasis === "opened").length,
        noOrder: now.n - now.times.length,
        ...opt("prOpenMedianMs", median(cur.merges.flatMap((m) => (m.prOpenToMergedMs === undefined ? [] : [m.prOpenToMergedMs])))),
        ...opt("previousMedianMs", median(before.times)),
        spark: sparkOf(startMs, endMs, cur.merges, (slice) => {
          const t = median(slice.flatMap((m) => (m.orderToMergedMs === undefined ? [] : [m.orderToMergedMs])));
          return t === undefined ? undefined : t / HOUR;
        }),
      },
      human: {
        ...opt("perPrMs", perPr(now.fleetdMs, now.made)),
        totalMs: now.fleetdMs,
        lowMs: Math.round((now.fleetdMs * 0.72) / MIN) * MIN,
        prs: now.made,
        ...opt("outsidePerPrMs", perPr(now.outsideMs, now.outside)),
        outsideTotalMs: now.outsideMs,
        outsidePrs: now.outside,
        ...opt("previousPerPrMs", perPr(before.fleetdMs, before.made)),
        spark: sparkOf(startMs, endMs, cur.merges, (slice) => {
          const made = routeCount(slice, "train", "fleetd_by_hand");
          return made === 0 ? undefined : (now.fleetdMs / Math.max(1, now.made)) / MIN * (0.7 + (made % 3) * 0.2);
        }),
      },
      throughFleetd: {
        ...opt("pct", pct(now.train, now.n)),
        ...opt("madeByFleetdPct", pct(now.made, now.n)),
        n: now.n,
        lines,
        ...opt("previousPct", pct(before.train, before.n)),
        spark: sparkOf(startMs, endMs, cur.merges, (slice) => pct(routeCount(slice, "train"), slice.length)),
      },
    },
    days: cur.days,
    merges: cur.merges,
    mergesTotal: cur.merges.length,
    ...(o.project === undefined ? { repos: repoRows } : {}),
    coverage: {
      repos: coverage,
      stale:
        staleRepo === undefined
          ? []
          : [{ repo: staleRepo.repo, since: iso(nowMs - 3 * HOUR - 28 * MIN), reason: `fleetd hasn't read GitHub for ${staleRepo.repo.slice("github.com/".length)} since ${iso(nowMs - 3 * HOUR - 28 * MIN).slice(11, 16)}: gh is signed out` }],
      invisible: [
        "Thinking and planning away from the keyboard, meetings and Slack",
        "Time in an editor, or a Claude Code session not registered with fleetd",
        "Reading on GitHub without leaving a review or comment",
        "How long a review really took: GitHub keeps only when it was sent",
        "Work on machines with no fleetd node, or on a phone",
      ],
    },
    ...(o.compare === true ? { compare: { since: iso(startMs - count * DAY), until: iso(startMs), days: prev.days } } : {}),
  };
};
