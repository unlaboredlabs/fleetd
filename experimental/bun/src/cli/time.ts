// `fleetd time` (crates/fleetd/src/cli/time.rs): where agents' time went, over the hub's MCP endpoint
// (time_breakdown, time_insights), laid out as plain tables; `--json` prints it as the hub sent it.
import { ArgError, parse } from "./args.ts";
import { eprintln, ioMessage, isMachineId, println, resolveHome } from "./common.ts";
import { jsonText } from "./json.ts";
import { McpClient, McpError } from "./mcp_client.ts";
import { padEnd, padStart } from "./project.ts";
import { connectAs } from "./setup/doctor.ts";
import { isFailure } from "./setup/steps.ts";
import { hubZone, parseRfc3339, zoned } from "./steer.ts";
import { readFileSync } from "node:fs";
import { TIME_USAGE } from "./usages.ts";
export { TIME_USAGE };


export type TimeArgs = { hub?: [string, string]; home?: string; target: string; since: string; json: boolean };

const isOrder = (target: string) => /^W[1-9][0-9]*$/.test(target);

/** ISO with milliseconds and Z, as chrono's `to_rfc3339_opts(Millis, true)`. */
export const isoZ = (ms: number) => new Date(ms).toISOString();

/** The UTC instant of a wall-clock time in `zone`. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const z = zoned(ms, zone);
    const wall = Date.UTC(Number(z.year), MONTHS.indexOf(z.month), Number(z.day), Number(z.hour), Number(z.minute));
    return wall - Math.floor(ms / 60_000) * 60_000;
  };
  // Earliest of the candidates either side of a change.
  const candidates = [guess - offsetAt(guess - 86_400_000), guess - offsetAt(guess + 86_400_000), guess - offsetAt(guess)];
  const exact = candidates.filter((c) => {
    const z = zoned(c, zone);
    return Number(z.day) === d && Number(z.hour) === h && Number(z.minute) === mi;
  });
  return exact.length > 0 ? Math.min(...exact) : guess - offsetAt(guess);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `7d`, `12h`, a date or an ISO time, as the ISO time it means. */
export function parseSince(given: string, now: number, zone: string): string {
  const bad = () => new ArgError(`--since must be 1h to 400d, a date or an ISO time, got '${given}'`);
  const at = parseRfc3339(given);
  if (at !== undefined) return isoZ(at);
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(given);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw bad();
    return isoZ(zonedToUtc(y, m, d, 0, 0, zone));
  }
  const unit = given.at(-1);
  const per = unit === "d" ? 24 : unit === "h" ? 1 : undefined;
  const digits = given.slice(0, -1);
  if (per === undefined || !/^[1-9][0-9]*$/.test(digits)) throw bad();
  const hours = Number(digits) * per;
  if (hours > 400 * 24) throw bad();
  return isoZ(now - hours * 3_600_000);
}

export function parseTimeArgs(argv: string[], now: number, zone: string): TimeArgs {
  const v = parse(argv, {
    options: { hub: "str", "key-file": "str", since: "str", json: "bool" },
    positionals: true,
  });
  if (v instanceof ArgError) throw v;
  const hub = v.str("hub") || undefined;
  const keyFile = v.str("key-file") || undefined;
  if (hub !== undefined && keyFile === undefined) throw new ArgError("--hub needs --key-file");
  if (hub === undefined && keyFile !== undefined) throw new ArgError("--key-file needs --hub");
  if (v.positionals.length > 1) throw new ArgError(`give one order or project, got '${v.positionals.join(" ")}'`);
  return {
    ...(hub !== undefined ? { hub: [hub, keyFile!] as [string, string] } : {}),
    target: v.positionals[0] ?? "",
    since: parseSince(v.str("since") ?? "7d", now, zone),
    json: v.flag("json"),
  };
}

/** The project a name means, from `project_get`: its id, its title or its folder's name, optionally after `<machine>/`. */
export function resolveProject(name: string, projects: any[]): { machineId: string; projectId: string } {
  const slash = name.indexOf("/");
  const [machine, rest] =
    slash >= 0 && isMachineId(name.slice(0, slash)) ? [name.slice(0, slash), name.slice(slash + 1)] : [undefined, name];
  const str = (p: any, k: string) => (typeof p?.[k] === "string" ? (p[k] as string) : "");
  const found = projects
    .filter((p) => machine === undefined || str(p, "machineId") === machine)
    .filter((p) => {
      const folder = str(p, "workspaceRoot").split("/").pop() ?? "";
      return [str(p, "projectId"), str(p, "title"), folder].includes(rest);
    });
  if (found.length === 1) return { machineId: str(found[0], "machineId"), projectId: str(found[0], "projectId") };
  if (found.length === 0) {
    throw new Error(
      `no order or project '${name}'; projects: ${projects.map((p) => `${str(p, "machineId")}/${str(p, "title")}`).join(", ")}`,
    );
  }
  throw new Error(`'${name}' is on several machines; say which: ${found.map((p) => `${str(p, "machineId")}/${rest}`).join(", ")}`);
}

/** A command as one table cell: its first line, cut at `max` characters. */
export function oneLine(text: string, max: number): string {
  const first = (text.split("\n")[0] ?? "").replace(/\s+$/, "");
  const cut = [...first].length > max || text.replace(/\s+$/, "").includes("\n");
  if (!cut) return first;
  return `${[...first].slice(0, max - 1).join("").replace(/\s+$/, "")}…`;
}

/** `1h42m`, `34m`, `2m10s`, `8s`, `250ms`. */
export function dur(raw: number): string {
  const ms = Math.max(0, raw);
  const s = Math.floor(ms / 1000);
  if (s === 0 && ms > 0) return `${ms}ms`;
  if (s < 60) return `${s}s`;
  if (s < 600 && s % 60 !== 0) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${roundHalfAway((part * 100) / whole)}%`;
}

/** Rust's `f64::round`: halves away from zero. */
export const roundHalfAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

const CATEGORY: Record<string, string> = {
  model: "model",
  tools: "tools",
  machine: "machine",
  queue: "queue",
  human: "you",
  pipeline: "pipeline",
  idle: "idle",
};

function pathGroup(kind: string, cat: string): string {
  if (kind === "change_ci" || kind === "ci_check" || kind === "ci_queue") return "ci";
  if (kind === "change_review") return "review";
  if (cat === "pipeline") return "train";
  return CATEGORY[cat] ?? cat;
}

/** Columns padded to their widest cell: the first left-aligned, the numbers right-aligned. */
export function table(rows: string[][]): string[] {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...rows.map((r) => (r[c] === undefined ? 0 : [...r[c]!].length))));
  return rows.map((row) =>
    row
      .map((cell, c) => (c === 0 ? padEnd(cell, widths[c]!) : padStart(cell, widths[c]!)))
      .join("  ")
      .replace(/\s+$/, ""),
  );
}

/** `%Y-%m-%d %H:%M` in `zone`, or the text as given. */
export function local(iso: string, zone: string): string {
  const ms = parseRfc3339(iso);
  if (ms === undefined) return iso;
  const z = zoned(ms, zone);
  const month = String(MONTHS.indexOf(z.month) + 1).padStart(2, "0");
  return `${z.year}-${month}-${z.day.padStart(2, "0")} ${z.hour}:${z.minute}`;
}

/** What `fleetd time` prints. `order` is order_get's `order` card, for an order. */
export function render(order: any, args: TimeArgs, b: any, insights: any, zone: string): string {
  const out: string[] = [];
  const wall: number = b.wallMs;
  const agent: number = b.agentMs;
  const path = b.criticalPath ?? undefined;
  const card = (k: string) => (typeof order?.[k] === "string" ? order[k] : "");
  out.push(
    order !== undefined
      ? `${args.target} ${card("title")}  ${card("state")}`
      : args.target === ""
        ? `fleet since ${local(args.since, zone)}`
        : `${args.target} since ${local(args.since, zone)}`,
  );
  let head = `wall ${dur(wall)}`;
  if (path) head += `  critical path ${dur(path.endMs - path.startMs)}`;
  head += `  agent time ${dur(agent)}`;
  if (wall > 0) head += `  parallelism ${(agent / wall).toFixed(1)}x`;
  const coverage = b.coverage ?? {};
  if (coverage.complete) head += "  coverage complete";
  else {
    const why: string[] = [];
    const gaps = Array.isArray(coverage.gaps) ? coverage.gaps.length : 0;
    if (gaps === 1) why.push("1 gap");
    else if (gaps > 1) why.push(`${gaps} gaps`);
    if (coverage.capped === true) why.push("newest spans only");
    if (typeof coverage.detailSince === "string") why.push(`commands and findings from ${local(coverage.detailSince, zone)}`);
    head += why.length === 0 ? "  coverage incomplete" : `  coverage incomplete (${why.join("; ")})`;
  }
  out.push(head);
  if (path) {
    const pathMs = path.endMs - path.startMs;
    const groups: [string, number][] = [];
    const add = (group: string, ms: number) => {
      const g = groups.find(([n]) => n === group);
      if (g) g[1] += ms;
      else groups.push([group, ms]);
    };
    for (const t of path.totals ?? []) {
      if (t.cat === "pipeline" && Array.isArray(t.kinds)) for (const k of t.kinds) add(pathGroup(k.kind, t.cat), k.ms);
      else if (t.cat === "idle") add("nothing running", t.ms);
      else add(CATEGORY[t.cat] ?? t.cat, t.ms);
    }
    const kept = groups.filter((g) => g[1] > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const rows = [["critical path", dur(pathMs)], ...kept.map(([g, t]) => [`  ${g}`, dur(t), pct(t, pathMs)])];
    out.push("", ...table(rows));
  }
  const cats = (b.byCategory ?? []).filter((c: any) => c.ms > 0);
  // A stable sort by -ms, as sort_by_key.
  cats.sort((x: any, y: any) => y.ms - x.ms);
  out.push("", ...table([["agent time", dur(agent)], ...cats.map((c: any) => [`  ${CATEGORY[c.cat] ?? c.cat}`, dur(c.ms), pct(c.ms, agent)])]));
  const top = b.topCommands ?? [];
  if (top.length > 0) {
    const rows = [["slowest commands", "n", "total", "median", "failed"]];
    for (const c of top.slice(0, 5)) rows.push([`  ${oneLine(c.label, 60)}`, String(c.n), dur(c.totalMs), dur(c.p50Ms), String(c.failed)]);
    out.push("", ...table(rows));
  }
  out.push("");
  const found = insights.insights ?? [];
  if (found.length === 0) out.push("findings: none");
  else {
    out.push("findings");
    found.slice(0, 5).forEach((f: any, i: number) => out.push(`  ${i + 1}. ${f.message}`));
    if (found.length > 5) out.push(`  and ${found.length - 5} more (--json lists them all)`);
  }
  return out.join("\n");
}

/** Thrown with the exit code once its reason is said. */
export class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** A connection to the hub for one command, `name` as in "fleetd <name>: …". */
export class Hub {
  private constructor(
    private readonly client: McpClient,
    private readonly name: string,
  ) {}

  /** The hub `--hub` and `--key-file` give, else the one on this machine. Throws Exit after saying why. */
  static async connect(hub: [string, string] | undefined, home: string | undefined, name: string): Promise<Hub> {
    const clientName = `fleetd-${name}`;
    if (hub !== undefined) {
      let key: string;
      try {
        key = readFileSync(hub[1], "utf8").trim();
      } catch (error) {
        eprintln(`fleetd ${name}: cannot read --key-file: ${ioMessage(error)}`);
        throw new Exit(2);
      }
      try {
        return new Hub(await McpClient.connect(hub[0], key, clientName, 30_000), name);
      } catch (error) {
        throw unreachable(name, error);
      }
    }
    try {
      return new Hub(await connectAs(resolveHome(home), clientName), name);
    } catch (f) {
      if (!isFailure(f)) throw f;
      eprintln(`fleetd ${name}: ${f.message}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>`);
      throw new Exit(4);
    }
  }

  /** One tool call; on failure, Exit after saying why. */
  async call(tool: string, input: unknown): Promise<any> {
    let result;
    try {
      result = await this.client.callTool(tool, input, 30_000);
    } catch (error) {
      throw unreachable(this.name, error);
    }
    if (result.isError) {
      const text = (k: string) => (typeof result.body?.[k] === "string" ? (result.body[k] as string) : undefined);
      const fix = text("fix");
      eprintln(`fleetd ${this.name}: ${text("message") ?? "the hub refused"}${fix === undefined ? "" : `\n  fix: ${fix}`}`);
      throw new Exit(1);
    }
    return result.body;
  }

  /** One tool call whose failure is no reason to stop. */
  async tryCall(tool: string, input: unknown): Promise<any> {
    try {
      const result = await this.client.callTool(tool, input, 30_000);
      return result.isError ? undefined : result.body;
    } catch {
      return undefined;
    }
  }

  get mcp() {
    return this.client;
  }
}

function unreachable(name: string, error: unknown): Exit {
  if (!(error instanceof McpError)) throw error;
  eprintln(`fleetd ${name}: ${error.message}`);
  return new Exit(error.unauthorized ? 3 : 4);
}

/** `fleetd time …`: 0, 1 the hub refused the call, 2 bad arguments, 3 it refused the key, 4 unreachable. */
export async function timeCommand(argv: string[]): Promise<number> {
  let args: TimeArgs;
  try {
    args = parseTimeArgs(argv, Date.now(), hubZone());
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    process.stderr.write(`fleetd: ${error.message}\n\nusage:\n${TIME_USAGE}`);
    return 2;
  }
  try {
    const hub = await Hub.connect(args.hub, args.home, "time");
    await run(hub, args);
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}

async function run(hub: Hub, args: TimeArgs) {
  let scope: unknown;
  if (args.target === "") scope = { kind: "fleet" };
  else if (isOrder(args.target)) scope = { kind: "order", workstreamId: args.target };
  else {
    const listed = await hub.call("project_get", {});
    try {
      scope = { kind: "project", projectRef: resolveProject(args.target, listed?.projects ?? []) };
    } catch (error) {
      eprintln(`fleetd time: ${(error as Error).message}`);
      throw new Exit(2);
    }
  }
  const range = { scope, since: args.since };
  const zone = hubZone();
  const breakdown = await hub.call("time_breakdown", range);
  const insights = await hub.call("time_insights", range);
  if (args.json) {
    println(jsonText({ breakdown, insights }));
    return;
  }
  const order = isOrder(args.target) ? ((await hub.call("order_get", { workstreamId: args.target }))?.order ?? null) : undefined;
  println(render(order, args, breakdown, insights, zone));
}
