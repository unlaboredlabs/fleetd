// `fleetd doctor` and how the CLI reaches the hub on this machine: the CLI's
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
  fix: "fleetd init (it starts the workspace and repairs its setup)",
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
    if (!state) throw { message: `${home} has no workspace set up`, fix: noSetupFix(home) } satisfies Failure;
    listen = `http://${state.listen}`;
  }
  try {
    return await McpClient.connect(listen, key, client, 15_000);
  } catch (error) {
    throw unreachable(listen, (error as Error).message);
  }
}

/**
 * Why the hub at `listen` didn't answer, in plain words rather than the HTTP client's (Bun's "socket connection was
 * closed unexpectedly … pass `verbose: true`"): nothing there, something that isn't the hub holding its port, or slow.
 */
export function unreachable(listen: string, said: string): Failure {
  let port = "4790";
  try {
    port = new URL(listen).port || port;
  } catch {}
  if (/ConnectionRefused|ECONNREFUSED|Unable to connect/i.test(said)) {
    return again(`nothing answers at ${listen}: the workspace isn't running`);
  }
  if (/closed unexpectedly|ECONNRESET|Malformed_HTTP_Response|Parse Error|Expected HTTP|HTTP \d{3}|invalid JSON|no answer to|without text content/i.test(said)) {
    const which = process.platform === "darwin" ? `lsof -nP -iTCP:${port} -sTCP:LISTEN` : `ss -ltnp 'sport = :${port}'`;
    return {
      message: `something else answers at ${listen}, not fleetd's workspace: another program may have taken port ${port}`,
      fix: `see which with ${which}, stop it, then run fleetd init`,
    };
  }
  if (/timed out|timeout/i.test(said)) {
    return { message: `the workspace at ${listen} didn't answer within 15 seconds`, fix: "fleetd doctor again in a minute; if it keeps failing, fleetd init" };
  }
  return again(`the workspace doesn't answer at ${listen}: ${said.replace(/\s*For more information, pass `verbose: true`.*$/s, "").replace(/\.+$/, "")}`);
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
      fix: "fleetd update, so this CLI matches the workspace",
    } satisfies Failure;
  }
  return checks;
}

/** Runs every check now. */
export async function run(home: string): Promise<any[]> {
  return listChecks(await connect(home));
}

/** Registers `path` on `machineId` as a project through the hub (project_add, the path the app and agents use). */
export async function addProject(home: string, machineId: string, path: string): Promise<void> {
  const client = await connect(home);
  const title = path.split("/").filter(Boolean).pop() ?? "";
  const fix = `fleetd doctor shows whether ${machineId} is online; then run fleetd init again`;
  let result;
  try {
    result = await client.callTool("project_add", { machineId, path, title }, 60_000);
  } catch (error) {
    const m = (error as Error).message;
    throw {
      message: `project_add failed: ${m}`,
      fix: m.includes("not found") ? "this workspace's fleetd predates project_add: fleetd update, then run fleetd init again" : fix,
    } satisfies Failure;
  }
  if (result.isError) {
    const text = (k: string) => (typeof result.body?.[k] === "string" ? (result.body[k] as string) : undefined);
    throw { message: text("message") ?? JSON.stringify(result.body), fix: text("fix") ?? fix } satisfies Failure;
  }
}

// "Starting…" from this hub on; the words before it from older hubs.
const CHECKING = ["Starting…", "checking the node's runner", "checking the node's claude runner"];

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

/** Screens agents may use, which a machine needs only if they want them: the Android emulator and Linux desktops. */
const OPTIONAL = [["android", "Android screens"], ["desktop", "Desktop screens"]] as const;

/** An optional extra's name, for a check that is one (`<machine>/android`, `<machine>/desktop`). */
export const optionalExtra = (id: unknown): string | undefined =>
  typeof id === "string" ? OPTIONAL.find(([name]) => id.endsWith(`/${name}`))?.[1] : undefined;

/** How many checks passed, of those that count: an optional extra that's off isn't a check failing. */
export type Tally = [ok: number, of: number];

/** The doctor's line under the checks: ✓ when every one that counts passes, else ! (each failing one is above). */
export function tally(list: Checklist, [ok, of]: Tally, what: string) {
  const text = `${ok} of ${of} ${what} pass`;
  if (ok === of) list.done("doctor", text);
  else list.warn("doctor", text);
}

/**
 * One checklist line per check that isn't ok, except for machines in `idle`; an optional extra that's off reads as
 * optional (–), with its fix, never as something that needs you.
 */
export function show(list: Checklist, checks: any[], idle: string[]): Tally {
  const said: [string | undefined, string][] = [];
  let optionalOff = 0;
  for (const check of checks) {
    if (check.status === "ok" || (check.machineId !== undefined && idle.includes(check.machineId))) continue;
    const extra = optionalExtra(check.id);
    if (extra !== undefined) {
      optionalOff++;
      const fix = check.fix?.command ?? check.fix?.label;
      const message = String(check.message).replace(/\.+$/, "");
      // This hub's nodes say what it is and that it's optional; an older node's words don't.
      const said = /optional/i.test(message) ? message : `${extra} are optional: ${message}`;
      list.finish(check.machineId ?? "hub", "skipped", said, typeof fix === "string" ? fix : undefined);
      continue;
    }
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
  return [checks.filter((c) => c.status === "ok").length, checks.length - optionalOff];
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
  const counted = show(list, checks, []);
  const line = await versions.line(client);
  if (line !== undefined) list.warn("versions", line);
  tally(list, counted, `${other}checks`);
  return list.failures().length > 0 ? 1 : 0;
}
