// The node takes up a new privacy grant by itself. macOS gives a running
// process a Screen Recording grant only once it starts again. Each check, the node asks a fresh process of its own
// binary (`fleetd node grants`, which macOS answers as it would a new node) and, when that one has a grant the node
// lacks, has launchd restart it: at most once for each answer, so a grant macOS never shows the running node can't make
// it restart again and again.
//
// The node is also the one that asks macOS for a grant, so fleetd (not Terminal or the app) is what lands in System
// Settings' list: setup's grant step writes `askFile` and the node asks within 2 s (`answer`). Only then: a grant an
// update lost (`lost`) is said by its check, whose fix asks, as a node asking by itself at each start would show
// macOS's prompt again and again (#1340).
//
// `grantsCommand` is `fleetd node grants [--ask <grant>] [--wait <secs>]` (cli/node.rs), with the setup helpers it uses
// (cli/setup/mac_finish.rs `grant`, `ask_node`, `open_pane`, `not_asked`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../shared/version.ts";
import { spawnOutside } from "../../update/service.ts";
import { grant as grantCheck, lostGrant, pane } from "./checks.ts";
import { GRANTS, type MacCheckId, type MacHealth, toolsDir } from "./common.ts";
import { tcc } from "./tcc.ts";
import { selfArgv } from "../util.ts";

/** How often the node checks the Mac's setup again. */
export const CHECK_EVERY = 30_000;

/** Accessibility and Screen Recording, as one process reads them: undefined where macOS can't be asked. */
export type Grants = { accessibility: boolean | undefined; screenRecording: boolean | undefined };

const word = (g: boolean | undefined) => (g === true ? "yes" : g === false ? "no" : "unknown");

/** This process's, as macOS gave them to it. */
export const own = (): Grants => ({ accessibility: tcc.accessibility(), screenRecording: tcc.screenRecording() });

/** What `fleetd node grants` prints, and `parse` reads. */
export const line = (g: Grants) => `accessibility ${word(g.accessibility)} screen_recording ${word(g.screenRecording)}`;

export function parse(text: string): Grants | undefined {
  const read = (w: string | undefined): [boolean | undefined] | undefined =>
    w === "yes" ? [true] : w === "no" ? [false] : w === "unknown" ? [undefined] : undefined;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length !== 4 || words[0] !== "accessibility" || words[2] !== "screen_recording") return undefined;
  const a = read(words[1]);
  const s = read(words[3]);
  return a && s ? { accessibility: a[0], screenRecording: s[0] } : undefined;
}

/** What a fresh process found: its grants, and those an update took away (`lost`). */
export type Fresh = { grants: Grants; lost: MacCheckId[] };

/** The grant checks of `health` as a fresh process found them: what macOS has granted the node. */
export function overlay(health: MacHealth, fresh: Fresh): MacHealth {
  return {
    ...health,
    checks: health.checks.map((c) => {
      const id = c.id as MacCheckId;
      if (fresh.lost.includes(id)) return lostGrant(id);
      if (id === "accessibility") return grantCheck(id, fresh.grants.accessibility);
      if (id === "screen_recording") return grantCheck(id, fresh.grants.screenRecording);
      return c;
    }),
  };
}

/** Whether the node restarts for the grants a fresh process has: one it lacks itself (`ownGrants`), unless it
 * restarted for this same answer before (`last`). The line to keep when it does. */
export function restartFor(ownGrants: Grants, fresh: Grants, last: string | undefined): string | undefined {
  const gained = (o: boolean | undefined, f: boolean | undefined) => f === true && o !== true;
  const l = line(fresh);
  return (gained(ownGrants.accessibility, fresh.accessibility) || gained(ownGrants.screenRecording, fresh.screenRecording)) && last !== l ? l : undefined;
}

/** Whether the node forgets the answer it last restarted for: a fresh process now says otherwise. */
export const forgets = (fresh: Grants, last: string | undefined) => last !== undefined && last !== line(fresh);

/** Where the node writes the answer it last restarted for. */
const marker = (home: string) => join(toolsDir(home), "restarted-for-grants");
/** Where the node writes what it last saw: its version, then the grants a fresh process had. */
export const seenFile = (home: string) => join(toolsDir(home), "grants-seen");

/** What the node last saw, as the seen file holds it: the version, and the grants under it. */
export function parseSeen(text: string): [string, Grants] | undefined {
  const at = text.trim().indexOf("\n");
  if (at < 0) return undefined;
  const t = text.trim();
  const grants = parse(t.slice(at + 1).trim());
  return grants ? [t.slice(0, at).trim(), grants] : undefined;
}

export function seen(home: string): [string, Grants] | undefined {
  try {
    return parseSeen(readFileSync(seenFile(home), "utf8"));
  } catch {
    return undefined;
  }
}

/** The grants an update lost: on when the node last looked, under another version, off now under `version`. A grant
 * already off before the update, or turned off under the same version, isn't one. */
export function lost(grants: Grants, before: [string, Grants] | undefined, version: string): MacCheckId[] {
  if (!before || before[0] === version) return [];
  const was = before[1];
  const out: MacCheckId[] = [];
  if (was.accessibility === true && grants.accessibility === false) out.push("accessibility");
  if (was.screenRecording === true && grants.screenRecording === false) out.push("screen_recording");
  return out;
}

/** Notes what a fresh process had under this version, unless a grant is lost: then what the node saw before the
 * update stays, so the check keeps saying so until the grant is back. */
export function noteSeen(home: string, grants: Grants, lostNow: MacCheckId[], version = VERSION): void {
  const text = `${version}\n${line(grants)}`;
  if (lostNow.length) return;
  try {
    if (readFileSync(seenFile(home), "utf8") === text) return;
  } catch {}
  try {
    mkdirSync(toolsDir(home), { recursive: true });
    writeFileSync(seenFile(home), text);
  } catch {}
}

/** Where setup asks the node to ask macOS for a grant: the grant's id, which the node removes once it asked. */
export const askFile = (home: string) => join(home, "mac-grant-ask");

/** Setup's half: asks the node at `home` to ask macOS for `id`. */
export function request(home: string, id: MacCheckId): void {
  const tmp = join(home, "mac-grant-ask.tmp");
  writeFileSync(tmp, id);
  renameSync(tmp, askFile(home));
}

/** The grant the ask file names, if it names one. */
export const asked = (text: string): MacCheckId | undefined => GRANTS.find((id) => id === text.trim());

/** The node's half: asks macOS for the grant setup asked for, if it did, and removes the ask. */
export function answer(home: string, ask: (id: MacCheckId) => void = (id) => tcc.ask(id)): void {
  let text: string;
  try {
    text = readFileSync(askFile(home), "utf8");
  } catch {
    return;
  }
  rmSync(askFile(home), { force: true });
  const id = asked(text);
  if (id) {
    console.info(`the agents' Mac asks macOS for ${id}, as setup asked`);
    ask(id);
  }
}

/** How often the node asks again: often while a grant is missing (the person is at System Settings), else at the pace
 * of the other checks. */
export const every = (fresh: Grants | undefined) =>
  fresh?.accessibility === true && fresh.screenRecording === true ? CHECK_EVERY : 2_000;


/** How long the fresh process may take to say its grants. */
const FRESH_TIMEOUT = 15_000;

/** A fresh process's grants: `fleetd node grants`, run from this node's own binary, off the event loop. */
async function fresh(): Promise<Grants | undefined> {
  const [program, ...args] = selfArgv();
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn([program!, ...args, "node", "grants"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return undefined;
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), FRESH_TIMEOUT);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return code === 0 ? parse(out.trim()) : undefined;
}

/** Asks a fresh process for its grants, and has launchd restart the node when that process holds a grant the node
 * lacks (`fleetd node restart`, outside the node's own process group). What the fresh process had. */
export async function takeUp(
  home: string,
  freshGrants: () => Promise<Grants | undefined> | Grants | undefined = fresh,
  restart: () => void = restartNode,
): Promise<Fresh | undefined> {
  const grants = await freshGrants();
  if (!grants) return undefined;
  const found: Fresh = { grants, lost: lost(grants, seen(home), VERSION) };
  noteSeen(home, grants, found.lost);
  let last: string | undefined;
  try {
    last = readFileSync(marker(home), "utf8").trim();
  } catch {}
  const next = restartFor(own(), grants, last);
  if (!next) {
    if (forgets(grants, last)) rmSync(marker(home), { force: true });
    return found;
  }
  try {
    mkdirSync(toolsDir(home), { recursive: true });
    writeFileSync(marker(home), next);
  } catch (e) {
    console.warn(`the agents' Mac can't note its restart for a new grant, so it doesn't restart: ${(e as Error).message}`);
    return found;
  }
  console.info(`the agents' Mac restarts its node to take up a new grant (${next})`);
  try {
    restart();
  } catch (e) {
    console.warn(`the agents' Mac couldn't restart its node for a new grant: ${(e as Error).message}`);
  }
  return found;
}

function restartNode(): void {
  const [program, ...args] = selfArgv();
  spawnOutside(program!, [...args, "node", "restart"]);
}

// ---- `fleetd node grants`, and setup's grant step (cli/setup/mac_finish.rs) ----

/** How long setup waits for the node to ask macOS for a grant: within 2 s while it runs. */
export const ASK_WAIT = 30_000;

const grantName = (id: MacCheckId) => (id === "screen_recording" ? "Screen Recording" : "Accessibility");

/** Has the node at `home` ask macOS for the grant and waits up to `waitMs` for it to; whether it did. */
export async function askNode(home: string, id: MacCheckId, waitMs: number): Promise<boolean> {
  try {
    request(home, id);
  } catch {
    return false;
  }
  const until = Date.now() + waitMs;
  for (;;) {
    if (!existsSync(askFile(home))) return true;
    if (Date.now() >= until) return false;
    await Bun.sleep(250);
  }
}

/** Opens the grant's pane at the Mac. Only on macOS: elsewhere `open` is another program. */
export function openPane(id: MacCheckId): void {
  if (process.platform === "darwin") spawnSync("open", [pane(id)], { stdio: "ignore" });
}

/** What to do when the node didn't ask in time, so isn't running. */
export const notAsked = (id: MacCheckId) =>
  `fleetd node restart: the node asks once it runs. Then turn on fleetd in System Settings › Privacy & Security › ${grantName(id)}.`;

/**
 * `fleetd node grants`: what a node started now would be granted (one line, `line`); with `ask`, setup's grant step:
 * the running node at `home` asks macOS for it (waiting up to `waitSecs`), then its pane opens. The exit code; what it
 * says goes to `out` and `err`.
 */
export async function grantsCommand(
  args: { ask?: string; wait?: string; home: string },
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  if (args.ask === undefined) {
    out(`${line(own())}\n`);
    return 0;
  }
  const id = asked(args.ask);
  if (!id) {
    err("fleetd: --ask takes accessibility or screen_recording\n");
    return 2;
  }
  let waitMs = ASK_WAIT;
  if (args.wait !== undefined) {
    if (!/^\d+$/.test(args.wait)) {
      err("fleetd: --wait takes a number of seconds\n");
      return 2;
    }
    waitMs = Number(args.wait) * 1000;
  }
  const did = await askNode(args.home, id, waitMs);
  openPane(id);
  const name = grantName(id);
  if (did) {
    out(`macOS asks for ${name} now: turn on fleetd in System Settings › Privacy & Security › ${name}\n`);
    return 0;
  }
  err(`fleetd: the node didn't ask macOS for ${name}: it isn't running. Fix: ${notAsked(id)}\n`);
  return 1;
}
