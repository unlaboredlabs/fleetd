// Holding a node's agents between steps ahead of its update's restart (crates/fleetd/src/node/hold.rs). The hold is a
// file, `<node home>/update/hold`, naming when it ends (epoch ms); `hold.update` and `hold.screens` beside it note
// whose it is. Every session's PreToolUse hook waits while it lasts (`fleetd update-hold`), each waiting call marked
// held (`update/held/<tool_use_id>`). A hold lasts HOLD_LEASE_SECS past the last ask, so one nobody renews lets go.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const HOLD_LEASE_SECS = 60;
const HOOK_POLL_MS = 1000;
/** The hook's own timeout in claude's settings: past it claude runs the call anyway. */
export const HOOK_TIMEOUT_SECS = 6 * 3600;

export const holdPath = (home: string) => join(home, "update", "hold");
const heldDir = (hold: string) => join(dirname(hold), "held");
const updateMark = (home: string) => join(dirname(holdPath(home)), "hold.update");
const screensMark = (home: string) => join(dirname(holdPath(home)), "hold.screens");

/** Writes a file whole beside `path` (`.name.new`), then renames it over `path`. */
function replaceFile(path: string, text: string) {
  const staging = join(dirname(path), `.${basename(path)}.new`);
  writeFileSync(staging, text);
  renameSync(staging, path);
}

function holdUntil(home: string): number {
  const path = holdPath(home);
  mkdirSync(heldDir(path), { recursive: true });
  const until = Date.now() + HOLD_LEASE_SECS * 1000;
  replaceFile(path, String(until));
  return until;
}

/** Holds the node's agents for HOLD_LEASE_SECS from now, for an update. */
export function hold(home: string) {
  replaceFile(updateMark(home), String(holdUntil(home)));
}

/** A hold for a screen-settings restart, noted as its own. */
export function holdForScreens(home: string) {
  replaceFile(screensMark(home), String(holdUntil(home)));
}

/** Ends a screen-settings restart's hold, unless an update holds too. */
export function releaseScreens(home: string) {
  const mark = screensMark(home);
  const ours = until(mark) !== undefined;
  rmSync(mark, { force: true });
  const u = until(updateMark(home));
  const updating = u !== undefined && Date.now() < u;
  if (ours && !updating) clear(home);
}

/** The tool calls waiting on the hold now. */
export function held(home: string): Set<string> {
  try {
    return new Set(readdirSync(heldDir(holdPath(home))));
  } catch {
    return new Set();
  }
}

/** Ends the hold: every call waiting on it starts. */
export function clear(home: string) {
  const path = holdPath(home);
  for (const f of [path, screensMark(home), updateMark(home)]) rmSync(f, { force: true });
  rmSync(heldDir(path), { recursive: true, force: true });
}

/** When the hold at `path` ends, or undefined when there is none. */
function until(path: string): number | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^\+?[0-9]+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The PreToolUse hook every session gets: free while there is no hold, `fleetd update-hold` while there is. */
export function hookCommand(exe: string, home: string): string {
  const h = quote(holdPath(home));
  return `test -e ${h} || exit 0; exec ${quote(exe)} update-hold ${h}`;
}

/** What `tool_use_id` may be to name a file. */
const pathSafe = (id: string) => id !== "" && id.length <= 128 && /^[A-Za-z0-9\-_.]+$/.test(id) && !id.startsWith(".");

/** `fleetd update-hold <hold>`: waits while the hold lasts, its tool call marked held meanwhile, then exits 0. */
export async function runHook(hold: string): Promise<number> {
  let input = "";
  try {
    input = await Bun.stdin.text();
  } catch {}
  await waitOut(hold, input);
  return 0;
}

export async function waitOut(hold: string, input: string) {
  let id: string | undefined;
  try {
    const v = JSON.parse(input);
    if (typeof v?.tool_use_id === "string" && pathSafe(v.tool_use_id)) id = v.tool_use_id;
  } catch {}
  const marker = id === undefined ? undefined : join(heldDir(hold), id);
  let marked = false;
  for (;;) {
    const u = until(hold);
    if (u === undefined || Date.now() >= u) break;
    if (!marked && marker !== undefined) {
      try {
        writeFileSync(marker, "");
        marked = true;
      } catch {}
    }
    await Bun.sleep(HOOK_POLL_MS);
  }
  if (marked && marker !== undefined) rmSync(marker, { force: true });
}
