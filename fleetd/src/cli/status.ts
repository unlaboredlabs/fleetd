// `fleetd status`: the same rows as the app's Status screen, read from the hub
// (status_get). With `--watch` it reads them again after each event that can change one (events_wait).
import { readFileSync } from "node:fs";
import { ArgError, parse } from "./args.ts";
import { eprintln, ioMessage, resolveHome, sleep, writeErr } from "./common.ts";
import { McpClient, McpError } from "./mcp_client.ts";
import { connectAs } from "./setup/doctor.ts";
import { isFailure } from "./setup/steps.ts";
import { hubZone, parseRfc3339, zoned } from "./steer.ts";
import { local, resolveProject, roundHalfAway } from "./time.ts";
import { STATUS_USAGE } from "./usages.ts";
import * as versions from "./versions.ts";
export { STATUS_USAGE };

const WAIT_SEC = 50;
const BACKOFF = [1, 2, 5, 10, 30];
const CHANGES_A_ROW = [
  "machine.online", "machine.offline", "machine.degraded", "machine.guard", "project.added", "project.removed",
  "chat.message", "chat.waiting", "lead.started", "workstream.created", "workstream.running", "workstream.state",
  "workstream.done", "task.queued", "task.started", "task.completed", "task.failed", "task.cancelled",
  "thread.waiting", "thread.usage_limited", "thread.started", "thread.completed", "thread.failed",
  "thread.interrupted", "request.opened", "request.updated", "review.verdict", "change.queued", "change.ready",
  "change.needs_rebase", "change.ci_failed", "change.refused", "change.state", "pr.merged", "pr.merged_outside",
  "usage.breaker", "usage.resumed", "ci.main", "source.stale", "source.fresh",
];

export type StatusArgs = { hub?: [string, string]; home?: string; target: string; watch: boolean; json: boolean };

/** `--hub` and `--key-file`, both or neither. */
export function hubFlags(v: { str(n: string): string | undefined }): [string, string] | undefined {
  const hub = v.str("hub") || undefined;
  const key = v.str("key-file") || undefined;
  if (hub !== undefined && key !== undefined) return [hub, key];
  if (hub !== undefined) throw new ArgError("--hub needs --key-file");
  if (key !== undefined) throw new ArgError("--key-file needs --hub");
  return undefined;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  const v = parse(argv, { options: { hub: "str", "key-file": "str", watch: "bool", json: "bool" }, positionals: true });
  if (v instanceof ArgError) throw v;
  if (v.positionals.length > 1) throw new ArgError(`give one project, got '${v.positionals.join(" ")}'`);
  const hub = hubFlags(v);
  return {
    ...(hub ? { hub } : {}),
    target: v.positionals[0] ?? "",
    watch: v.flag("watch"),
    json: v.flag("json"),
  };
}

// ---- printing the rows ----

const DAY = (ms: number, zone: string) => {
  const z = zoned(ms, zone);
  return Date.UTC(Number(z.year), MONTHS.indexOf(z.month), Number(z.day)) / 86_400_000;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `14:02:07` on the day of `now`, `Thu 14:02` within a week, else the date, in the hub machine's zone. */
export function at(t: string, now: string, zone: string): string {
  const ms = parseRfc3339(t);
  if (ms === undefined) return t;
  const z = zoned(ms, zone);
  const n = parseRfc3339(now);
  const days = n === undefined ? undefined : DAY(ms, zone) - DAY(n, zone);
  if (days === 0) return `${z.hour}:${z.minute}:${z.second}`;
  if (days !== undefined && days >= -6 && days <= 6) return `${z.weekday} ${z.hour}:${z.minute}`;
  return local(t, zone);
}

const GROUP: Record<string, string> = {
  waiting_on_you: "waiting on you",
  in_review: "in review",
  working: "working",
  landing: "landing",
  idle: "idle",
  unknown: "idle",
  done: "done",
};

function countsLine(row: any): string {
  const c = row.counts ?? {};
  return (
    [
      [c.waitingOnYou, "waiting_on_you"],
      [c.inReview, "in_review"],
      [c.working, "working"],
      [c.landing, "landing"],
      [c.idle, "idle"],
      [c.done, "done"],
    ] as [number, string][]
  )
    .filter(([n]) => n > 0)
    .map(([n, g]) => `${n} ${GROUP[g]}`)
    .join(" · ");
}

function itemLine(i: any): string {
  const refs: string[] = [];
  if (i.taskId !== undefined) refs.push(String(i.taskId));
  if (i.pr !== undefined) refs.push(`#${i.pr.number}`);
  if (i.why !== undefined) refs.push(String(i.why));
  return `  ${GROUP[i.group] ?? i.group}: ${i.title}${refs.length === 0 ? "" : ` (${refs.join(", ")})`}`;
}

function word(row: any): string {
  switch (row.state) {
    case "working":
      return "working";
    case "waiting_on_you":
      return "waiting on you";
    case "blocked":
      return row.blockedReason !== undefined ? `blocked: ${row.blockedReason}` : "blocked";
    default:
      return "idle";
  }
}

function renderRow(row: any, zone: string): string[] {
  const now = row.asOf;
  const out = [`${row.title}: ${word(row)}`];
  const counts = countsLine(row);
  const agents = row.agentsRunning === 1 ? "1 agent" : `${row.agentsRunning} agents`;
  const m = row.lastMerged;
  const merged =
    m === undefined || m === null
      ? "nothing merged yet"
      : `merged ${m.title}${m.prNumber !== undefined && m.prNumber !== null ? ` #${m.prNumber}` : ""} ${at(m.at, now, zone)}`;
  out.push(`  ${[counts, agents, merged].filter((p) => p !== "").join(" · ")}`);
  if (row.merged7d !== undefined && row.merged7d !== null) {
    const share =
      row.throughFleetdPct7d !== undefined && row.throughFleetdPct7d !== null
        ? ` · ${roundHalfAway(row.throughFleetdPct7d)}% through fleetd`
        : "";
    out.push(`  ${row.merged7d} merged in 7 days${share}`);
  }
  if (row.warning !== undefined && row.warning !== null) out.push(`  warning: ${row.warning}`);
  out.push(...(row.items ?? []).map(itemLine));
  if (row.stale) out.push(`  STALE since ${at(row.stale.since, now, zone)}: ${row.stale.reason}`);
  return out;
}

export function render(rows: any[], zone: string): string {
  const first = rows[0];
  if (first === undefined) return "no projects yet";
  const out = [`Status at ${at(first.asOf, first.asOf, zone)}`];
  for (const row of rows) out.push("", ...renderRow(row, zone));
  return out.join("\n");
}

function notLiveBanner(last: any[], zone: string, reason: string): string {
  const from = last[0] === undefined ? "" : ` · rows from ${at(last[0].asOf, last[0].asOf, zone)}`;
  return `NOT LIVE: reconnecting to the hub (${reason})${from}`;
}

// ---- talking to the hub ----

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const exitFor = (error: McpError) => (error.unauthorized ? 3 : 4);

type Target = { url: string; key: string } | { home: string };

async function connect(target: Target): Promise<McpClient> {
  if ("url" in target) return McpClient.connect(target.url, target.key, "fleetd-status", 15_000);
  try {
    return await connectAs(target.home, "fleetd-status");
  } catch (f) {
    if (!isFailure(f)) throw f;
    throw new McpError(`${f.message}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>`);
  }
}

/** A tool's answer; a refusal says why and is Exit(3); a transport failure stays an McpError. */
async function call(client: McpClient, tool: string, input: unknown, timeoutMs: number): Promise<any> {
  const result = await client.callTool(tool, input, timeoutMs);
  if (result.isError) {
    const text = (k: string) => (typeof result.body?.[k] === "string" ? (result.body[k] as string) : undefined);
    const fix = text("fix");
    eprintln(`fleetd status: ${text("message") ?? "the hub refused"}${fix === undefined ? "" : `\n  fix: ${fix}`}`);
    throw new Exit(3);
  }
  return result.body;
}

const sameRef = (a: any, b: any) => a?.machineId === b?.machineId && a?.projectId === b?.projectId;

async function read(client: McpClient, only: any): Promise<any[]> {
  const listed = await call(client, "status_get", {}, 30_000);
  const rows: any[] = Array.isArray(listed?.rows) ? listed.rows : [];
  return rows.filter((row) => only === undefined || sameRef(row.projectRef, only));
}

const head = async (client: McpClient) => (await call(client, "events_wait", { timeoutSec: 0 }, 30_000))?.cursor ?? null;

export async function statusCommand(argv: string[]): Promise<number> {
  let args: StatusArgs;
  try {
    args = parseStatusArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${STATUS_USAGE}`);
    return 2;
  }
  let target: Target;
  if (args.hub) {
    try {
      target = { url: args.hub[0], key: readFileSync(args.hub[1], "utf8").trim() };
    } catch (error) {
      eprintln(`fleetd status: cannot read --key-file: ${ioMessage(error)}`);
      return 2;
    }
  } else target = { home: resolveHome(args.home) };
  try {
    return await run(args, target);
  } catch (error) {
    if (error instanceof Exit) return error.code;
    if (error instanceof McpError) {
      eprintln(`fleetd status: ${error.message}`);
      return exitFor(error);
    }
    throw error;
  }
}

async function run(args: StatusArgs, target: Target): Promise<number> {
  let client = await connect(target);
  let only: any;
  if (args.target !== "") {
    const listed = await call(client, "project_get", {}, 30_000);
    try {
      only = resolveProject(args.target, Array.isArray(listed?.projects) ? listed.projects : []);
    } catch (error) {
      eprintln(`fleetd status: ${(error as Error).message}`);
      return 2;
    }
  }
  const zone = hubZone();
  const tty = args.watch && !args.json && process.stdout.isTTY === true;
  const show = (rows: any[]) => {
    if (args.json) process.stdout.write(`${JSON.stringify(rows.map((row) => ({ row })))}\n`);
    else if (tty) process.stdout.write(`\x1b[H\x1b[2J${render(rows, zone)}\n`);
    else process.stdout.write(`${render(rows, zone)}\n\n`);
  };
  const banner = (line: string) => {
    if (args.json) process.stdout.write(`${JSON.stringify({ notLive: line })}\n`);
    else if (tty) process.stdout.write(`\x1b7\x1b[H\x1b[2K${line}\x1b8`);
    else process.stdout.write(`${line}\n\n`);
  };
  let cursor: unknown = null;
  if (args.watch) cursor = await head(client);
  let rows = await read(client, only);
  show(rows);
  if (!args.json) {
    const line = await versions.line(client);
    if (line !== undefined) process.stdout.write(`${line}\n`);
  }
  if (!args.watch) return 0;
  // SIGINT or SIGTERM ends the watch at once, mid-wait too, as the Rust CLI selects its waits against them.
  let stopped = false;
  const STOP = Symbol("stop");
  const stopSignal = new Promise<typeof STOP>((resolve) => {
    const stop = () => {
      stopped = true;
      resolve(STOP);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  const untilStop = <T>(p: Promise<T>) => Promise.race([p, stopSignal]);
  while (!stopped) {
    let reason: string;
    try {
      const got = await untilStop(
        call(client, "events_wait", { cursor, types: CHANGES_A_ROW, timeoutSec: WAIT_SEC }, (WAIT_SEC + 15) * 1000),
      );
      if (got === STOP) break;
      cursor = got?.cursor ?? null;
      if (!Array.isArray(got?.events) || got.events.length === 0) continue;
      const next = await read(client, only);
      if (JSON.stringify(next) !== JSON.stringify(rows)) {
        rows = next;
        show(rows);
      }
      continue;
    } catch (error) {
      if (!(error instanceof McpError) || error.unauthorized) throw error;
      reason = error.message;
    }
    banner(notLiveBanner(rows, zone, reason));
    for (let attempt = 0; !stopped; attempt++) {
      if ((await untilStop(sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]! * 1000))) === STOP) break;
      try {
        const fresh = await connect(target);
        const c = await head(fresh);
        const next = await read(fresh, only);
        [client, cursor, rows] = [fresh, c, next];
        show(rows);
        break;
      } catch (error) {
        if (error instanceof Exit) throw error;
      }
    }
  }
  return 0;
}
