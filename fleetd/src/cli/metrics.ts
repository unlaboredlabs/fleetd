// `fleetd metrics`: the factory's numbers (metrics_get), by calendar day in this
// machine's zone. It only lays out what the hub computed; `--json` prints it as the hub sent it.
import { ArgError, parse } from "./args.ts";
import { eprintln, println, writeErr } from "./common.ts";
import { jsonText } from "./json.ts";
import { padEnd, padStart } from "./project.ts";
import { hubZone, zoned } from "./steer.ts";
import { hubFlags } from "./status.ts";
import { dur, Exit, Hub, isoZ, local, oneLine, resolveProject, roundHalfAway, table, zonedToUtc } from "./time.ts";
import { METRICS_USAGE } from "./usages.ts";
export { METRICS_USAGE };

const LISTED = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type MetricsArgs = { hub?: [string, string]; home?: string; project: string; days: number; since: string; json: boolean };

/** The midnight that starts the last `days` calendar days in `zone`, today included. */
export function sinceOf(days: number, now: number, zone: string): string {
  const z = zoned(now, zone);
  const first = new Date(Date.UTC(Number(z.year), MONTHS.indexOf(z.month), Number(z.day)) - (days - 1) * 86_400_000);
  return isoZ(zonedToUtc(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), 0, 0, zone));
}

export function parseMetricsArgs(argv: string[], now: number, zone: string): MetricsArgs {
  const v = parse(argv, {
    options: { hub: "str", "key-file": "str", project: "str", days: "str", json: "bool" },
    positionals: false,
  });
  if (v instanceof ArgError) throw v;
  const hub = hubFlags(v);
  let days = 30;
  const given = v.str("days");
  if (given !== undefined) {
    days = /^\+?[0-9]+$/.test(given) ? Number(given) : NaN;
    if (!(days >= 1 && days <= 400)) throw new ArgError(`--days must be 1 to 400, got '${given}'`);
  }
  return { ...(hub ? { hub } : {}), project: v.str("project") ?? "", days, since: sinceOf(days, now, zone), json: v.flag("json") };
}

const ROUTE: Record<string, string> = {
  train: "through fleetd",
  fleetd_by_hand: "made by fleetd, merged by you",
  outside: "merged outside fleetd",
  direct: "pushed straight",
};
const routeWord = (r: string) => ROUTE[r] ?? "other";
const SKIP_ORDER = ["bot", "other_base", "merge_back", "unknown"];
const SKIP: Record<string, [string, string]> = {
  bot: ["bot PR", "bot PRs"],
  other_base: ["PR into another branch", "PRs into other branches"],
  merge_back: ["merge-back", "merge-backs"],
  unknown: ["other merge", "other merges"],
};
const HOST: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  bitbucket: "Bitbucket",
  azure_devops: "Azure DevOps",
  git: "git log",
};
const pct = (v: number) => `${roundHalfAway(v)}%`;
const prs = (n: number) => (n === 1 ? "1 PR" : `${n} PRs`);
const has = (v: unknown) => v !== undefined && v !== null;

function humanCells(h: any): [string, string] {
  const total = h.totalMs;
  if (has(h.perPrMs)) {
    return [`≈ ${dur(h.perPrMs)}`, `≈ ${dur(total)} in all (at least ${dur(h.lowMs)}) over ${prs(h.prs)} · from what fleetd sees`];
  }
  if (total > 0) return ["—", `no PRs made by fleetd · ≈ ${dur(total)} in all`];
  return ["—", "not counted yet"];
}

function mergeName(m: any): string {
  if (has(m.prNumber)) return `${m.repo}#${m.prNumber}`;
  if (has(m.sha)) return `${m.repo}@${String(m.sha).slice(0, 8)}`;
  return m.repo;
}

export function render(scope: string, days: number, out: any, zone: string): string {
  const t = out.tiles;
  const day = (iso: string) => [...local(iso, zone)].slice(0, 10).join("");
  const lines = [`${scope === "" ? "fleet" : scope}: last ${days} days, ${day(out.since)} to ${day(out.until)} (${zone})`];
  const m = t.merged;
  let mergedNote = `${m.n} in ${days} days`;
  if (has(m.previousPerDay)) mergedNote += ` · was ${m.previousPerDay.toFixed(1)}`;
  const o = t.orderToMerged;
  let order: [string, string];
  if (has(o.medianMs) && has(o.p90Ms)) {
    let note = `median · p90 ${dur(o.p90Ms)} · ${prs(o.n)}`;
    if (o.fromOpened > 0) note += ` (${o.fromOpened} timed from when the lead opened the order)`;
    order = [dur(o.medianMs), note];
  } else order = ["—", "no merged PR belongs to an order"];
  const orderNote = o.noOrder === 0 ? order[1] : `${order[1]} · ${o.noOrder} merged with no order`;
  const [human, humanNote] = humanCells(t.human);
  const f = t.throughFleetd;
  const [share, shareNote] =
    has(f.pct) && has(f.madeByFleetdPct) ? [pct(f.pct), `${pct(f.madeByFleetdPct)} made by fleetd`] : ["—", "nothing merged"];
  const figures: [string, string, string][] = [
    ["merged per day", m.perDay.toFixed(1), mergedNote],
    ["order to merged", order[0], orderNote],
    ["your minutes per PR", human, humanNote],
    ["through fleetd", share, shareNote],
  ];
  const labelW = Math.max(...figures.map((x) => [...x[0]].length));
  const valueW = Math.max(...figures.map((x) => [...x[1]].length));
  lines.push("");
  for (const [label, value, note] of figures) lines.push(`${padEnd(label, labelW)}  ${padStart(value, valueW)}  ${note}`);
  const byRoute: [string, number][] = [
    ["train", m.byRoute.train],
    ["fleetd_by_hand", m.byRoute.fleetdByHand],
    ["outside", m.byRoute.outside],
    ["direct", m.byRoute.direct],
  ];
  const rows = [["by route", "n", "lines"]];
  for (const [route, n] of byRoute) {
    const l = (f.lines ?? []).find((x: any) => x.route === route);
    rows.push([`  ${routeWord(route)}`, String(n), l ? `+${l.additions} −${l.deletions}` : ""]);
  }
  lines.push("", ...table(rows));
  const skipped = new Map<string, number>();
  for (const d of out.days ?? []) {
    for (const s of d.notCounted ?? []) {
      const why = SKIP_ORDER.includes(s.why) ? s.why : "unknown";
      skipped.set(why, (skipped.get(why) ?? 0) + s.n);
    }
  }
  if (skipped.size > 0) {
    const words = SKIP_ORDER.filter((w) => skipped.has(w)).map((w) => {
      const n = skipped.get(w)!;
      return `${n} ${n === 1 ? SKIP[w]![0] : SKIP[w]![1]}`;
    });
    lines.push(`  not counted: ${words.join(", ")}`);
  }
  if (Array.isArray(out.repos) && out.repos.length > 0) {
    const r2 = [["repo", "per day", "n", "order to merged", "through fleetd"]];
    for (const r of out.repos) {
      r2.push([
        `  ${r.repo}`,
        r.mergedPerDay.toFixed(1),
        String(r.n),
        has(r.orderToMergedMedianMs) ? dur(r.orderToMergedMedianMs) : "—",
        has(r.throughFleetdPct) ? pct(r.throughFleetdPct) : "—",
      ]);
    }
    lines.push("", ...table(r2));
  }
  lines.push("");
  const merges: any[] = out.merges ?? [];
  if (merges.length === 0) lines.push("No merges in this range.");
  else {
    lines.push("latest merges");
    const mrows = merges.slice(0, LISTED).map((x) => [
      `  ${local(x.mergedAt, zone)}`,
      mergeName(x),
      routeWord(x.route),
      has(x.orderToMergedMs) ? dur(x.orderToMergedMs) : "",
      has(x.title) ? oneLine(x.title, 50) : "",
    ]);
    const widths = [0, 1, 2, 3, 4].map((c) => Math.max(0, ...mrows.map((r) => [...r[c]!].length)));
    for (const r of mrows) {
      const cell = (c: number) => padEnd(r[c]!, widths[c]!);
      lines.push(`${cell(0)}  ${cell(1)}  ${cell(2)}  ${padStart(r[3]!, widths[3]!)}  ${r[4]}`.replace(/\s+$/, ""));
    }
    if (out.mergesTotal > LISTED) lines.push(`  and ${out.mergesTotal - LISTED} more (--json lists them)`);
  }
  const c = out.coverage ?? {};
  lines.push("");
  if (!Array.isArray(c.repos) || c.repos.length === 0) {
    lines.push("read from: no repos yet (merges are read from the merge train's repos)");
  } else {
    lines.push("read from");
    for (const r of c.repos) {
      let line = `  ${r.repo}: ${HOST[r.host] ?? "its host"}`;
      if (has(r.lastRead)) line += `, read ${local(r.lastRead, zone)}`;
      if (has(r.knownSince)) line += `, merges known since ${day(r.knownSince)}`;
      lines.push(line);
    }
  }
  for (const s of c.stale ?? []) lines.push(`  STALE ${s.repo}: ${s.reason}`);
  return lines.join("\n");
}

export async function metricsCommand(argv: string[]): Promise<number> {
  const zone = hubZone();
  let args: MetricsArgs;
  try {
    args = parseMetricsArgs(argv, Date.now(), zone);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${METRICS_USAGE}`);
    return 2;
  }
  try {
    const hub = await Hub.connect(args.hub, args.home, "metrics");
    const input: Record<string, unknown> = { since: args.since, tz: zone };
    let title = "";
    if (args.project !== "") {
      const listed = await hub.call("project_get", {});
      const projects: any[] = Array.isArray(listed?.projects) ? listed.projects : [];
      let ref;
      try {
        ref = resolveProject(args.project, projects);
      } catch (error) {
        eprintln(`fleetd metrics: ${(error as Error).message}`);
        return 2;
      }
      const p = projects.find((p) => p.machineId === ref.machineId && p.projectId === ref.projectId);
      title = typeof p?.title === "string" ? p.title : args.project;
      input.projectRef = ref;
    }
    const got = await hub.call("metrics_get", input);
    println(args.json ? jsonText(got) : render(title, args.days, got, zone));
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}
