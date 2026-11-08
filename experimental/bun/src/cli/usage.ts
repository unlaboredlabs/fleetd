// `fleetd usage` (crates/fleetd/src/cli/usage.rs): each machine's usage pause (usage_status), and `fleetd usage resume
// <machine>` to lift one now (usage_resume), the same as the app's Resume.
import { ArgError, parse } from "./args.ts";
import { isMachineId, println, writeErr } from "./common.ts";
import { jsonText } from "./json.ts";
import { padEnd } from "./project.ts";
import { hubZone } from "./steer.ts";
import { hubFlags } from "./status.ts";
import { Exit, Hub, local } from "./time.ts";
import { USAGE_USAGE } from "./usages.ts";
export { USAGE_USAGE };

export type UsageArgs = { hub?: [string, string]; home?: string; resume: boolean; machine: string; json: boolean };

export function parseUsageArgs(argv: string[]): UsageArgs {
  const v = parse(argv, { options: { hub: "str", "key-file": "str", json: "bool" }, positionals: true });
  if (v instanceof ArgError) throw v;
  const hub = hubFlags(v);
  const p = v.positionals;
  let resume = false;
  let machine = "";
  if (p.length === 2 && p[0] === "resume") [resume, machine] = [true, p[1]!];
  else if (p.length === 1 && p[0] === "resume") throw new ArgError("usage resume needs the machine");
  else if (p.length === 1) machine = p[0]!;
  else if (p.length > 1) throw new ArgError("too many arguments");
  if (machine !== "" && !isMachineId(machine)) throw new ArgError(`not a machine id: ${machine}`);
  return { ...(hub ? { hub } : {}), resume, machine, json: v.flag("json") };
}

export async function usageCommand(argv: string[]): Promise<number> {
  let args: UsageArgs;
  try {
    args = parseUsageArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${USAGE_USAGE}`);
    return 2;
  }
  try {
    const hub = await Hub.connect(args.hub, args.home, "usage");
    await run(hub, args, hubZone());
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}

const text = (v: any, path: string[]) => {
  const at = path.reduce((o, k) => o?.[k], v);
  return typeof at === "string" ? at : undefined;
};
const count = (v: any, path: string[]) => {
  const at = path.reduce((o, k) => o?.[k], v);
  return typeof at === "number" && at >= 0 && Number.isInteger(at) ? at : 0;
};

async function run(hub: Hub, args: UsageArgs, zone: string) {
  if (args.resume) {
    const before = await hub.tryCall("usage_status", { machineId: args.machine });
    const first = Array.isArray(before?.machines) ? before.machines[0] : undefined;
    const wasPaused = first === undefined ? undefined : text(first, ["breaker", "state"]) === "open";
    const out = await hub.call("usage_resume", { machineId: args.machine });
    if (args.json) {
      out.pauseLifted = wasPaused ?? null;
      println(jsonText(out));
    } else println(resumedLine(args.machine, wasPaused, out));
    return;
  }
  const out = await hub.call("usage_status", args.machine === "" ? {} : { machineId: args.machine });
  if (args.json) {
    println(jsonText(out));
    return;
  }
  for (const line of statusLines(out, zone)) println(line);
}

export function resumedLine(machine: string, wasPaused: boolean | undefined, out: unknown): string {
  const resumed = count(out, ["resumed"]);
  const sent = `sent "continue" to ${resumed} parked ${resumed === 1 ? "agent" : "agents"}`;
  const still = "One whose login is still limited parks again with the real reset.";
  if (wasPaused === false && resumed === 0) {
    return `Nothing to resume on ${machine}: it wasn't paused and nothing was parked there.`;
  }
  if (wasPaused === true && resumed === 0) {
    return `Resumed ${machine}: lifted its usage pause; nothing was parked there, so its next turn tries the login.`;
  }
  if (wasPaused === true) return `Resumed ${machine}: lifted its usage pause and ${sent}. ${still}`;
  if (wasPaused === undefined && resumed === 0) return `Resumed ${machine}: nothing was parked there.`;
  return `Resumed ${machine}: ${sent}. ${still}`;
}

export function statusLines(out: any, zone: string): string[] {
  const machines: any[] = Array.isArray(out?.machines) ? out.machines : [];
  if (machines.length === 0) return ["No machines."];
  const rows: string[][] = [];
  const more: string[] = [];
  for (const m of machines) {
    const id = text(m, ["machineId"]) ?? "?";
    const n = count(m, ["parked", "leads"]) + count(m, ["parked", "tasks"]);
    const parked = n === 0 ? "nothing parked" : `${n} parked`;
    if (text(m, ["breaker", "state"]) === "open") {
      const when: string[] = [];
      const since = text(m, ["breaker", "since"]);
      if (since !== undefined) when.push(`since ${local(since, zone)}`);
      const until = text(m, ["breaker", "until"]);
      const check = text(m, ["breaker", "checkAt"]);
      if (until !== undefined) when.push(`until ${local(until, zone)}`);
      else if (check !== undefined) when.push(`next check ${local(check, zone)}`);
      rows.push([id, "paused", parked, when.join(", ")]);
      const message = text(m, ["breaker", "message"]);
      if (message !== undefined) more.push(`${id}: ${message}`);
      more.push(`  to go on now: fleetd usage resume ${id}`);
    } else rows.push([id, "ok", parked, ""]);
  }
  const widths = [0, 1, 2, 3].map((c) => Math.max(0, ...rows.map((r) => [...r[c]!].length)));
  const lines = rows.map((r) => r.map((cell, c) => padEnd(cell, widths[c]!)).join("  ").replace(/\s+$/, ""));
  if (more.length > 0) lines.push("", ...more);
  return lines;
}
