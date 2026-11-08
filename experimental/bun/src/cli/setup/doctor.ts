// `fleetd doctor` and how the CLI reaches the hub on this machine (crates/fleetd/src/cli/setup/doctor.rs): the CLI's
// own key, kept 0600 in the hub home beside the database it was minted from, and every setup check run now
// (doctor_list), the hub's setup steps first.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ArgError, parse } from "../args.ts";
import { type Failure, readSetup, resolveHome, writePrivate } from "../common.ts";
import { McpClient } from "../mcp_client.ts";
import { createKey, keyWorks, openHub } from "../store.ts";
import * as versions from "../versions.ts";
import { Checklist, type State } from "./checklist.ts";
import * as steps from "./steps.ts";
import { isFailure } from "./steps.ts";
import { noSetupFix, say, SETUP_USAGE } from "./shared.ts";

const KEY_FILE = "cli.key";

/** The CLI's own admin key, minted again only when it is gone or revoked. */
export function cliKey(home: string): string {
  const file = join(home, KEY_FILE);
  const db = openHub(home);
  try {
    try {
      const key = readFileSync(file, "utf8").trim();
      if (keyWorks(db, key)) return key;
    } catch {}
    const created = createKey(db, "fleetd-cli", [{ role: "admin", machines: "*" }], "agent");
    writePrivate(file, `${created.key}\n`);
    return created.key;
  } finally {
    db.conn.close();
  }
}

const again = (message: string): Failure => ({
  message,
  fix: "fleetd init (it starts the hub and repairs its setup)",
});

/** The hub on this machine, with the CLI's own admin key. Throws a Failure. */
export const connect = (home: string) => connectTo(home, undefined, "fleetd-doctor");
export const connectAs = (home: string, client: string) => connectTo(home, undefined, client);

/** The hub's MCP endpoint with the CLI's own key; `hub` overrides the address `fleetd init` saved. */
export async function connectTo(home: string, hub: string | undefined, client: string): Promise<McpClient> {
  let key: string;
  try {
    key = cliKey(home);
  } catch (error) {
    throw again((error as Error).message);
  }
  return connectWith(home, hub, client, key);
}

/** {@link connectTo} with `key` instead of the CLI's own: what speaks for the person, their human key. */
export async function connectWith(home: string, hub: string | undefined, client: string, key: string): Promise<McpClient> {
  let listen: string;
  if (hub !== undefined) listen = hub.replace(/\/+$/, "");
  else {
    let state;
    try {
      state = readSetup(home);
    } catch (error) {
      throw again((error as Error).message);
    }
    if (!state) throw { message: `${home} has no hub set up`, fix: noSetupFix(home) } satisfies Failure;
    listen = `http://${state.listen}`;
  }
  try {
    return await McpClient.connect(listen, key, client, 15_000);
  } catch (error) {
    throw again(`the hub does not answer at ${listen}: ${(error as Error).message}`);
  }
}

async function listChecks(client: McpClient): Promise<any[]> {
  let result;
  try {
    result = await client.callTool("doctor_list", { rerun: true }, 120_000);
  } catch (error) {
    throw {
      message: `doctor_list failed: ${(error as Error).message}`,
      fix: "fleetd doctor again in a minute; if it keeps failing, fleetd init",
    } satisfies Failure;
  }
  const checks = result.body?.checks;
  if (!Array.isArray(checks)) {
    throw {
      message: "doctor_list answered in an unknown shape: invalid type: null, expected a sequence",
      fix: "fleetd update, so this CLI matches the hub",
    } satisfies Failure;
  }
  return checks;
}

/** Runs every check now. */
export async function run(home: string): Promise<any[]> {
  return listChecks(await connect(home));
}

const CHECKING = ["checking the node's runner", "checking the node's claude runner"];

/** A machine's degraded reason that only means its first runner check hasn't answered yet. */
export const stillChecking = (reason: string) => CHECKING.some((c) => reason.includes(c));

/** The hub answers `name` (an unknown tool comes back as "not found"). */
export async function hubHasTool(home: string, name: string): Promise<boolean> {
  let client;
  try {
    client = await connect(home);
  } catch {
    return false;
  }
  try {
    await client.callTool(name, {}, 15_000);
    return true;
  } catch (error) {
    return !(error as Error).message.includes("not found");
  }
}

/** One checklist line per check that isn't ok, except for machines in `idle`; how many passed. */
export function show(list: Checklist, checks: any[], idle: string[]): number {
  const said: [string | undefined, string][] = [];
  for (const check of checks) {
    if (check.status === "ok" || (check.machineId !== undefined && idle.includes(check.machineId))) continue;
    if (said.some(([m, msg]) => m === check.machineId && msg === check.message)) continue;
    said.push([check.machineId, check.message]);
    const state: State = check.status === "fail" ? "failed" : "warn";
    let fix: string | undefined =
      check.fix === undefined || check.fix === null
        ? undefined
        : (check.fix.command ?? (check.fix.kind === "auto" ? "fleetd doctor --fix" : check.fix.label));
    if (state === "failed" && fix === undefined) fix = "fleetd doctor again once the cause is gone";
    if (fix !== undefined && list.hasFix(fix)) continue;
    const title = check.machineId ?? "hub";
    if (stillChecking(check.message)) {
      list.skipped(`doctor ${title}`, "still checking its claude; run fleetd doctor in a minute for the result");
      continue;
    }
    list.finish(`doctor ${title}`, state, String(check.message).replace(/\.+$/, ""), fix);
  }
  return checks.filter((c) => c.status === "ok").length;
}

export async function doctorCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: {}, positionals: false });
  if (v instanceof ArgError) {
    say(`fleetd: ${v.message}\n\nusage:\n${SETUP_USAGE}`);
    return 2;
  }
  const home = resolveHome();
  const list = new Checklist();
  let client;
  try {
    client = await connect(home);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("doctor", f.message, f.fix);
    return 4;
  }
  let checks;
  try {
    checks = await listChecks(client);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("doctor", f.message, f.fix);
    return 4;
  }
  let other = "";
  try {
    const found = await steps.list(client);
    if (found !== undefined) {
      steps.show(list, found);
      checks = steps.unowned(checks, found);
      other = "other ";
    }
  } catch {}
  const ok = show(list, checks, []);
  const line = await versions.line(client);
  if (line !== undefined) list.warn("versions", line);
  list.done("doctor", `${ok} of ${checks.length} ${other}checks pass`);
  return list.failures().length > 0 ? 1 : 0;
}
