// `fleetd steer`, `fleetd steers`: a person redirects one of an order's agents
// mid-run, over the hub's MCP endpoint (steer_send, steer_withdraw, and order_get for an order's steers). A steer speaks
// for the human, so it needs a human key. `--wait` follows the receipt through events_wait.
import { parse, ArgError } from "./args.ts";
import { clientRequestId, eprintln, ioMessage, println, readSetup, resolveHome, st, writeErr } from "./common.ts";
import { McpClient, McpError } from "./mcp_client.ts";
import { readFileSync } from "node:fs";
import { STEER_USAGE } from "./usages.ts";
export { STEER_USAGE };


const CALL_TIMEOUT = 30_000;
/** The longest events_wait the hub takes. */
const WAIT_SEC = 50;

/** Why a command that speaks for the person refuses to run without `--key-file`, and how to make the key. */
export const humanKeyRequired = (what: string) =>
  `--key-file is required: ${what} speaks for you, so it needs your human key. Make one once: fleetd hub key create --human --name <device> --out <file>`;

type SteerCommand =
  | { kind: "send"; target: object; text: string; mode: "now" | "queue"; wait: boolean }
  | { kind: "withdraw"; steerId: string }
  | { kind: "list"; target: object };

export type SteerArgs = { command: SteerCommand; hub?: string; home?: string; keyFile: string };

const isNumbered = (id: string, prefix: string) => new RegExp(`^${prefix}[1-9][0-9]*$`).test(id);

/** `W41` is an order, `T88` one task. */
export function targetOf(id: string): object {
  if (isNumbered(id, "W")) return { workstreamId: id };
  if (isNumbered(id, "T")) return { taskId: id };
  throw new ArgError(`'${id}' is not an order (W41) or a task (T88); \`fleetd status\` lists them`);
}

/** `steer …` when `list` is false, `steers …` when it is. Throws ArgError. */
export function parseSteerArgs(argv: string[], list: boolean): SteerArgs {
  const v = parse(argv, {
    options: { hub: "str", "key-file": "str", now: "bool", wait: "bool" },
    positionals: true,
  });
  if (v instanceof ArgError) throw v;
  const keyFile = v.str("key-file");
  if (!keyFile) throw new ArgError(humanKeyRequired("a steer"));
  const hub = v.str("hub") || undefined;
  const p = v.positionals;
  const noSendFlags = (what: string) => {
    if (v.flag("now") || v.flag("wait")) throw new ArgError(`--now and --wait are for sending a steer, not ${what}`);
  };
  let command: SteerCommand;
  if (list) {
    noSendFlags("listing");
    if (p.length !== 1) throw new ArgError("expected fleetd steers <W|T>");
    command = { kind: "list", target: targetOf(p[0]!) };
  } else if (p[0] === "withdraw") {
    noSendFlags("withdraw");
    if (p.length !== 2 || !isNumbered(p[1]!, "S")) throw new ArgError("expected fleetd steer withdraw S<n>");
    command = { kind: "withdraw", steerId: p[1]! };
  } else {
    const [id, ...words] = p;
    const text = words.join(" ");
    if (id === undefined || text.trim() === "") throw new ArgError(`expected fleetd steer T<n> "<text>"`);
    if (isNumbered(id, "W")) {
      throw new ArgError(
        `${id} is an order: to reach its project's lead, use fleetd chat <machine>/<project> "<text>" [--now]`,
      );
    }
    command = { kind: "send", target: targetOf(id), text, mode: v.flag("now") ? "now" : "queue", wait: v.flag("wait") };
  }
  return { command, ...(hub === undefined ? {} : { hub }), keyFile };
}

// ---- receipts ----

/** The hub's zone: $TZ, else /etc/localtime's, else UTC (hub/attention `hub_zone`). */
export function hubZone(): string {
  const valid = (tz: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  const env = process.env.TZ?.replace(/^:/, "");
  if (env && valid(env)) return env;
  try {
    const link = require("node:fs").readlinkSync("/etc/localtime") as string;
    const at = link.indexOf("zoneinfo/");
    if (at >= 0 && valid(link.slice(at + 9))) return link.slice(at + 9);
  } catch {}
  return "UTC";
}

/** The parts of `ms` in the hub's zone. */
export function zoned(ms: number, zone = hubZone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second" | "weekday", string>;
}

/** RFC 3339 → ms, or undefined. */
export function parseRfc3339(iso: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(iso)) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** `14:02:07.120`, in this machine's zone. */
function clock(iso: string): string {
  const ms = parseRfc3339(iso);
  if (ms === undefined) return iso;
  const z = zoned(ms);
  return `${z.hour}:${z.minute}:${z.second}.${String(((ms % 1000) + 1000) % 1000).padStart(3, "0")}`;
}

const stageOf = (steer: unknown) => st(steer, "stage") ?? "queued";

/** One line for the steer's current stage, as the hub recorded it. */
export function receiptLine(steer: any): string {
  const id = st(steer, "id") ?? "S?";
  const stage = stageOf(steer);
  const at = (key: string) => {
    const t = st(steer, key);
    return t === undefined ? "" : ` ${clock(t)}`;
  };
  const d = st(steer, "detail");
  const detail = d === undefined ? "" : ` (${d})`;
  const quote = (key: string) => {
    const e = st(steer, key);
    return e === undefined ? "" : `  "${e.replaceAll("\n", " ")}"`;
  };
  switch (stage) {
    case "queued":
      return `${id} queued${at("queuedAt")}${detail}`;
    case "delivered": {
      const how = st(steer, "how");
      const text =
        how === "stopped"
          ? ` (stopped ${st(steer, "stoppedTool") ?? "its current step"})`
          : how === "boundary"
            ? " (after the running tool returned)"
            : how === "turn"
              ? " (started a turn)"
              : how === "joined"
                ? " (joined the running turn)"
                : "";
      return `${id} delivered${at("deliveredAt")}${text}${detail}`;
    }
    case "acknowledged":
      return `${id} acknowledged${at("ackedAt")}${quote("ackExcerpt")}`;
    case "unacknowledged":
      return `${id} not acknowledged: no reply after it was delivered`;
    default:
      return `${id} ${stage}${detail}`;
  }
}

/** The exit code once the receipt stops moving: 0 acknowledged, 1 anything else final; undefined while it can move. */
export function exitForStage(stage: string): number | undefined {
  if (stage === "acknowledged") return 0;
  return ["unacknowledged", "withdrawn", "failed", "expired"].includes(stage) ? 1 : undefined;
}

/** The receipts `--wait` has not printed yet, in order. */
export function newLines(steer: any, printed: string[]): string[] {
  const lines: string[] = [];
  const stage = stageOf(steer);
  const push = (line: string, stage: string) => {
    if (!printed.includes(stage)) {
      printed.push(stage);
      lines.push(line);
    }
  };
  if (stage !== "queued" && st(steer, "deliveredAt") !== undefined && stage !== "delivered") {
    push(receiptLine({ ...steer, stage: "delivered" }), "delivered");
  }
  push(receiptLine(steer), stage);
  return lines;
}

// ---- talking to the hub ----

/** `--hub`, else the hub this machine runs (`fleetd init`). Throws Unreachable. */
export function hubUrl(hub: string | undefined, home?: string): string {
  if (hub !== undefined) return hub;
  const dir = resolveHome(home);
  let state;
  try {
    state = readSetup(dir);
  } catch (error) {
    throw new Unreachable((error as Error).message);
  }
  if (state) return `http://${state.listen}`;
  throw new Unreachable(`no hub is set up on this machine (${dir}); pass --hub <url>`);
}

/** Exit 4: the hub could not be reached. */
export class Unreachable extends Error {}
/** Exit 3: the hub refused (or the key is not a human key). */
export class Refused extends Error {}

/** A failure's line and exit code; anything else is a crash and goes on up. */
export function reportAs(command: string, error: unknown): number {
  if (error instanceof McpError) error = error.unauthorized ? new Refused(error.message) : new Unreachable(error.message);
  if (error instanceof Unreachable || error instanceof Refused) {
    eprintln(`fleetd ${command}: ${error.message}`);
    return error instanceof Unreachable ? 4 : 3;
  }
  throw error;
}

/** The key in a `--key-file`, trimmed; Refused when it can't be read. */
export function readKeyFile(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Refused(`cannot read --key-file: ${ioMessage(error)}`);
  }
}

export async function call(client: McpClient, tool: string, input: unknown, timeoutMs: number): Promise<any> {
  const result = await client.callTool(tool, input, timeoutMs);
  if (result.isError) {
    const text = (k: string) => (typeof result.body?.[k] === "string" ? (result.body[k] as string) : undefined);
    const fix = text("fix");
    throw new Refused(`${text("message") ?? "the hub refused"}${fix === undefined ? "" : `\n  fix: ${fix}`}`);
  }
  return result.body;
}

/** The newest steers of an order, or of one task, from its order's order_get. */
async function steersOf(client: McpClient, target: any): Promise<any[]> {
  const task = st(target, "taskId");
  let workstream = st(target, "workstreamId") ?? "";
  if (!st(target, "workstreamId") && task !== undefined) {
    const got = await call(client, "task_get", { taskId: task }, CALL_TIMEOUT);
    workstream = typeof got?.task?.workstreamId === "string" ? got.task.workstreamId : "";
  }
  const order = await call(client, "order_get", { workstreamId: workstream }, CALL_TIMEOUT);
  const all: any[] = Array.isArray(order?.steers) ? order.steers : [];
  return all.filter((s) => task === undefined || st(s?.target, "taskId") === task);
}

async function readSteer(client: McpClient, steer: any): Promise<any> {
  const id = st(steer, "id") ?? "";
  const steers = await steersOf(client, { workstreamId: st(steer, "workstreamId") ?? "" });
  return steers.find((s) => st(s, "id") === id) ?? steer;
}

/** Prints each receipt as the hub records it, until it is final. */
async function follow(client: McpClient, steer: any, cursor: unknown): Promise<number> {
  const id = st(steer, "id") ?? "";
  const printed = ["queued"];
  for (;;) {
    steer = await readSteer(client, steer);
    for (const line of newLines(steer, printed)) println(line);
    const code = exitForStage(stageOf(steer));
    if (code !== undefined) return code;
    for (;;) {
      const page = await call(
        client,
        "events_wait",
        {
          cursor,
          timeoutSec: WAIT_SEC,
          types: ["steer.delivered", "steer.acknowledged", "steer.unacknowledged", "steer.withdrawn", "steer.failed"],
        },
        (WAIT_SEC + 20) * 1000,
      );
      cursor = page?.cursor ?? cursor;
      const events: any[] = Array.isArray(page?.events) ? page.events : [];
      if (events.some((e) => st(e?.data, "steerId") === id)) break;
    }
  }
}

async function run(args: SteerArgs): Promise<number> {
  const key = readKeyFile(args.keyFile);
  const url = hubUrl(args.hub, args.home);
  const client = await McpClient.connect(url, key, "fleetd-steer", 15_000);
  const c = args.command;
  if (c.kind === "send") {
    const cursor = c.wait ? ((await call(client, "fleetd_status", {}, CALL_TIMEOUT))?.cursor ?? 0) : null;
    const steer = await call(
      client,
      "steer_send",
      { target: c.target, text: c.text, mode: c.mode, clientRequestId: clientRequestId() },
      CALL_TIMEOUT,
    );
    println(receiptLine(steer));
    if (!c.wait) {
      const id = st(steer, "id") ?? "S?";
      println(
        c.mode === "now"
          ? "it stops the agent's current step; `fleetd steers` shows its receipt"
          : `it lands at the agent's next step; \`fleetd steer withdraw ${id}\` takes it back until then`,
      );
      return 0;
    }
    return follow(client, steer, cursor);
  }
  if (c.kind === "withdraw") {
    println(receiptLine(await call(client, "steer_withdraw", { steerId: c.steerId }, CALL_TIMEOUT)));
    return 0;
  }
  const steers = await steersOf(client, c.target);
  if (steers.length === 0) println("no steers yet");
  for (const steer of steers) {
    const to = st(steer?.target, "taskId") ?? st(steer?.target, "workstreamId") ?? "?";
    const text = [...(st(steer, "text") ?? "")].slice(0, 80).join("");
    println(`${st(steer, "id") ?? "S?"} → ${to}: "${text}"`);
    println(`  ${receiptLine(steer)}`);
  }
  return 0;
}

/** `fleetd steer …` (`list` false) and `fleetd steers …` (`list` true). */
export async function steerCommand(argv: string[], list: boolean): Promise<number> {
  let args: SteerArgs;
  try {
    args = parseSteerArgs(argv, list);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${STEER_USAGE}`);
    return 2;
  }
  try {
    return await run(args);
  } catch (error) {
    return reportAs("steer", error);
  }
}
