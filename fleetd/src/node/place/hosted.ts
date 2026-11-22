// The `hosted` place: a session runs in a box of the team's own hosted provider (boat.dev), one box
// per session, made by this node (../sandbox/remote/boxes.ts). The box shares nothing with the machine, so it gets
// what the session reads at the same absolute paths as here (../sandbox/remote/files.ts): its worktree cloned and
// synced from the machine's, the files its launch names, its transcript to resume. Then everything in the session's
// spec holds unchanged, and so do its tools: node.sock calls and the browser's and adb's ports come back over the
// guest's link (../sandbox/box.ts), named by the box's link, never by what a call claims.
//
// - The box is made at the session's first need of it: setup's `run`, before `start`, which then reuses it.
// - Secrets reach it only at exec: the bootstrap's own secret at its start, the session's variables at the session
//   host's start, over the guest's link. A box is never paused or snapshotted; it is destroyed. The one exception is a
//   bot's computer image (`buildSnapshot`): a box that ran only its setup, with its bot's variables and no session's,
//   checked for their values, then saved by the provider; a session placed in that provider starts from it.
// - After each of its turns, its work comes back to the machine's worktree and its transcript to the machine's
//   (`checkpoint`), so a box that dies loses only the turn under way; one that doesn't come back is said to the lead.
//   Once the session host in it is gone (the agent idled out, stopped, or the box died), they come back once more
//   where the box still answers, and the box is destroyed. A box whose work still didn't come back is kept instead and
//   tried again for a while (`KEPT`), then given up with the lead told. The next start makes a new one, from the work
//   as it came back last.
// - A box is kept alive by its provider's lifetime, extended while it runs. One that can't be extended (a revoked key,
//   an outage) is reported, and ended with its work brought back before its lifetime is out; so is every box of a
//   provider whose key is disconnected (`endHosted`).
// - A session here has no process on this machine. Its registration names a pid above Linux's PID_MAX_LIMIT (2^22),
//   which no process has, so the node's pid fallbacks (a kill of the group, the orphan sweep) find nothing to act on.
// - The machine's own Claude login never leaves the machine: a session without an account's variables is refused.
// - The team's tailnet (its Tailscale gateway, which the hub runs) is in every box while it is on, from the box's
//   start, before its repo comes in (../sandbox/tailnet_box.ts): Claude's endpoint, a git host or an MCP server there
//   is reached as the box reaches the internet. Nothing of this machine's own network is relayed into a box.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_PATH, logWords, ProviderError, type ProviderId, type Size } from "../../sandbox/providers/index.ts";
import { Stages } from "../../shared/stages.ts";
import { NAMES, troubleLine, troubleOf } from "../../shared/sandbox.ts";
import { configDir, sessionFile } from "../runner/claude.ts";
import { HostLink, LaunchError, PROTOCOL, type HostHandlers, type Launch, type Registration } from "../runner/host.ts";
import { ACCOUNT_CLEARS } from "../actions/accounts.ts";
import type { Box } from "../sandbox/box.ts";
import { boxes, type BoxRecord, type Boxes, EXTEND_MS, LIFETIME_MS } from "../sandbox/remote/boxes.ts";
import { fetchNew, keepMirrored, mirror, mtimeOf, named, prepare, readChatFile, sh, syncIn, syncOut } from "../sandbox/remote/files.ts";
import { BOX_DIR } from "../sandbox/remote/bootstrap.ts";
import { homeDir, nowIso } from "../util.ts";
import { claudeEndpoint, probe, unreached } from "./endpoint.ts";
import { nodeTailnet } from "../sandbox/tailnet.ts";
import type { Place } from "./index.ts";
import { stepped } from "./hosted_steps.ts";
import { KEPT_EVERY_MS, KEPT_FOR_MS } from "./kept.ts";
import { dropChoice, dropDisk, sessionImage, type Backend, type Built, type Job } from "./image.ts";
import { SETUP_TIMEOUT_SEC } from "../worktree/setup.ts";
import { keptToken } from "../repos/github.ts";

/** What a hosted agent can't do, in plain words: its files are in its box, not on this machine. */
export const HOSTED_NO_MAC = "This agent runs in a hosted sandbox, so the agents' Mac can't build from its files, and iOS simulators aren't available to it.";

/** How a box's reach of Claude is checked (./endpoint.ts probe); tests set a stand-in. */
export const hostedProbe: { probe?: (box: Box, url: string) => Promise<void> } = {};

/** The Claude Code every hosted template installs, at the version fleetd was tested with: the recipe's own path
 * (sandbox/providers/recipe.ts CLAUDE_PATH, which every template's build proves before its save), not /usr/local/bin's,
 * which a provider's image may hold another of (boat's did). Tests set a stand-in. */
export const BOX_CLAUDE = { path: CLAUDE_PATH };
/** Dirs every box has, after the machine's own PATH. */
const BOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const TRANSCRIPT_MAX = 512 * 1024 ** 2;

/** What `<hostDir>/place.json` holds for a hosted session. */
export type HostedRecord = BoxRecord & {
  session: string;
  cwd?: string;
  /** The commit the box started from: what `syncOut` builds on. */
  base?: string;
  /** The transcript's path, here and in the box. */
  transcript?: string;
  registration?: Registration;
  /** The box's environment for the node's own git there (`syncOut`): the order's variables come from the file the
   * agent's commands source, `CLAUDE_ENV_FILE`, as it is then. */
  env?: { HOME?: string; PATH?: string; CLAUDE_ENV_FILE?: string };
  /** What the session's launch named under the node's home, kept in the box as it changes, a re-adopt's too. */
  mirrored?: string[];
  /** When the work last came back to the machine (the box's start, then each turn's checkpoint): what a lost box lost
   * is what it did after. */
  since?: string;
  /** Until when (epoch ms) the provider keeps the box, as its last extension set it. */
  aliveUntil?: number;
};

type Live = {
  record: HostedRecord;
  box: Box;
  dir: string;
  extender?: ReturnType<typeof setTimeout>;
  /** Keep-alives that failed in a row. */
  failed: number;
  /** Stops sending the launch's files again as they change (`keepMirrored`). */
  refresher?: () => void;
  /** Its work didn't come back after its last turn, and the lead was told. */
  notBack?: boolean;
};

/** The keep-alive's timing: an extension every `everyMs`; after one fails, again every `retryMs`, and the session ends
 * with its work brought back once the box has `endBeforeMs` left. Tests set shorter ones. */
export const KEEP_ALIVE = { everyMs: EXTEND_MS, retryMs: 2 * 60_000, endBeforeMs: 15 * 60_000 };

/** How often the files a session's launch named are checked for changes (the order's variables, which the node
 * rewrites when the hub renews its GitHub token) and sent to the box again. Tests set a shorter one. */
export const REFRESH = { everyMs: 30_000 };

/** How long a box whose work didn't come back is kept, and how often it is tried again (the node's sweep, and its
 * start): ./kept.ts says why. Tests set shorter ones. */
export const KEPT = { forMs: KEPT_FOR_MS, everyMs: KEPT_EVERY_MS };

/** A box's work that didn't come back, for the task's lead: node/index.ts hands it, as a machine event, to the server
 * the runner links to (fleetd's cloud). */
export type BoxWork = { sessionId: string; state: "not_back" | "kept" | "given_up"; text: string; untilMs?: number };
export const boxWork: { said?: (e: BoxWork) => void } = {};

/** Why, as one short line for the lead: git's first line, not its advice. */
const short = (why: string) => {
  const line = why.split("\n")[0]!.trim();
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
};

const say = (e: BoxWork) => {
  try {
    boxWork.said?.(e);
  } catch {}
};

/** `ms` (epoch, or an ISO time) as the lead reads it: `21:36 UTC`. */
const hhmm = (at: number | string | undefined) => (at === undefined ? "its start" : `${new Date(at).toISOString().slice(11, 16)} UTC`);

/** A kept box, as `<home>/sandbox/kept/<session>.json` holds it: outside the session's host dir, which a stop removes. */
type KeptBox = { record: HostedRecord; untilMs: number };
const keptDir = (home: string) => join(home, "sandbox", "kept");
const keptFile = (home: string, session: string) => join(keptDir(home), `${session}.json`);
/** Kept boxes being tried now, by session: what a settle waits for. */
const retrying = new Map<string, Promise<void>>();

const live = new Map<string, Live>();
const making = new Map<string, Promise<Live>>();
const ending = new Map<string, Promise<void>>();
/** Each session's checkpoint under way, and whether another turn ended meanwhile. */
const checkpoints = new Map<string, { run: Promise<void>; again: boolean }>();
/** Why a session's box ended without its session asking, in plain words, until the session reads it (`boxEnd`). */
const ends = new Map<string, string>();
/** Every session with a box of its provider's, from the box's making until it is destroyed: what the hub's slot board
 * counts against each provider (the heartbeat's `load.places`). */
const boxed = new Map<string, ProviderId>();

/** The sessions with a box now, being made or going, and its provider. */
export const boxPlaces = (): ReadonlyMap<string, ProviderId> => boxed;

const recordFile = (dir: string) => join(dir, "place.json");

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Keeps the files `paths` names in `l`'s box as they change (files.ts `keepMirrored`), saying once when they don't go. */
function watch(l: Live, paths: string[], sent?: Map<string, number>): void {
  l.refresher?.();
  let said = false;
  l.refresher = keepMirrored(l.box, paths, REFRESH.everyMs, {
    ...(sent ? { sent } : {}),
    failed: (error) => {
      if (error && !said) console.warn(`${nowIso()} WARN a hosted box's files (its order's variables) didn't go in again: the next look tries again {"sessionId":"${l.record.session}","error":${JSON.stringify(error.message)}}`);
      said = error !== undefined;
    },
  });
}

/** The files a session's box is kept up to date with, for tests. */
export const mirroredIn = (session: string): string[] | undefined => (live.get(session)?.refresher ? live.get(session)?.record.mirrored : undefined);

/** Whether the session has a box now, or one being made. */
export const hasBox = (session: string) => live.has(session) || making.has(session);
/** The hosted box of session `session`, once it is up. */
export const hostedBox = (session: string): Box | undefined => live.get(session)?.box;

export function readRecord(dir: string): HostedRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(recordFile(dir), "utf8")) as HostedRecord;
    return r.kind === "hosted" && r.boxId ? r : undefined;
  } catch {
    return undefined;
  }
}

function save(dir: string, r: HostedRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(recordFile(dir), JSON.stringify(r), { mode: 0o600 });
}

const need = () => {
  const b = boxes();
  if (!b) throw new LaunchError("this machine makes no hosted sandboxes (they run from Linux machines)");
  return b;
};

/** A pid no process has: PID_MAX_LIMIT is 2^22. Stable for the session, so a re-adopt finds the row's pid. */
export function nobodyPid(session: string): number {
  let h = 0;
  for (const c of session) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 0x40000000 + (h & 0xfffff);
}

/** The ports of this machine a session's tools reach at the same numbers: the browser proxy's and adb's. Claude is
 * the box's to reach, on the internet or the team's tailnet. */
export function forwardedPorts(env: Record<string, string | undefined>): number[] {
  const out: number[] = [];
  const cdp = env.AGENT_BROWSER_CDP ? /:\/\/127\.0\.0\.1:(\d+)/.exec(env.AGENT_BROWSER_CDP)?.[1] : undefined;
  if (cdp) out.push(Number(cdp));
  const adb = Number(env.ANDROID_ADB_SERVER_PORT);
  if (adb > 0) out.push(adb);
  return [...new Set(out.filter((p) => p > 0 && p < 65536))];
}

/** The machine's PATH for the box: what fleetd keeps off inside boxes left out (the build slots' wrapper), and the
 * box's own dirs after it. */
export function boxPath(path: string | undefined, home: string): string {
  const parts = (path ?? "").split(":").filter((p) => p && !p.startsWith(join(home, "build-slots")));
  for (const p of BOX_PATH.split(":")) if (!parts.includes(p)) parts.push(p);
  return parts.join(":");
}

/** The node's home, from a session's host dir (`<home>/hosts/<id>`). */
const homeOf = (dir: string) => dirname(dirname(dir));

/** The box of `session`, made the first time it's needed: its worktree in it as here. */
async function ensure(provider: ProviderId, session: string, dir: string, cwd: string, env: Record<string, string | undefined>, size?: Size): Promise<Live> {
  await ending.get(session);
  const have = live.get(session);
  if (have) return have;
  const pending = making.get(session);
  if (pending) return pending;
  boxed.set(session, provider);
  // What the last box's end said is that box's: a box that ended with no claude to hear it (setup's) says nothing now.
  ends.delete(session);
  const made = (async (): Promise<Live> => {
    const b = need();
    const home = homeOf(dir);
    // A record without a live box here: what a node before this one left. That box goes first.
    const old = readRecord(dir);
    if (old) await teardown(session, dir);
    // Then a box kept from the session's last end (that teardown's own included), its work brought back if it can be:
    // a new box starts from the machine's worktree, and the kept one's work must never land over the new one's.
    await settleKept(home, session);
    // One HOME for setup's git and the session: the git config made here (its credential helper) is the agent's.
    const HOME = env.HOME ?? homeDir();
    const PATH = boxPath(env.PATH, home);
    const git = await gitRoot(cwd);
    const dirs = [HOME ?? "", home, dirname(cwd), ...(git ? [dirname(git)] : [])];
    // From its bot's computer image when it started from one (./image.ts use), else the template: one whose snapshot
    // went starts from the template and runs the setup it skipped.
    const choice = sessionImage(home, session);
    const image = choice?.where === provider ? choice : undefined;
    let setupAgain: string[] = [];
    let made: BoxRecord;
    const asked = Date.now();
    // Each step's time to the log, at info when the box was slow to be ready (shared/stages.ts).
    const stages = new Stages("hosted box", session);
    stepped(session, "computer");
    try {
      made = await b.create(provider, session, forwardedPorts(env), dirs, size, image ? { template: image.ref } : {});
    } catch (error) {
      if (!image) throw error;
      console.warn(`${nowIso()} WARN a session's box couldn't start from its bot's computer image: it starts clean and runs setup {"sessionId":"${session}","error":${JSON.stringify((error as Error).message)}}`);
      dropChoice(home, session);
      setupAgain = image.worktree ? [] : (image.commands ?? []);
      made = await b.create(provider, session, forwardedPorts(env), dirs, size);
    }
    stages.done("computer");
    const record: HostedRecord = { ...made, session, cwd, aliveUntil: asked + LIFETIME_MS };
    record.env = { ...(HOME ? { HOME } : {}), PATH };
    save(dir, record);
    let box: Box | undefined;
    let step: keyof typeof STEP_WORDS = "setup";
    try {
      box = await b.open(record, session);
      stages.done("link");
      // The team's tailnet and the agent's dirs side by side: neither needs the other, and the files go in after both.
      await Promise.all([withTailnet(box, session, false), prepare(box, dirs)]);
      stages.done("tailnet and dirs");
      stepped(session, git ? "clone" : "files");
      step = git ? "repo" : "files";
      record.base = await syncIn(box, { cwd, session, env: { HOME, PATH, ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}) } });
      record.since = nowIso();
      save(dir, record);
      stages.done(git ? "clone" : "files");
      if (setupAgain.length) stepped(session, "setup");
      for (const command of setupAgain) {
        const out = await box.run({ argv: ["sh", "-c", command], cwd, env: { ...env, HOME, PATH }, timeoutSec: SETUP_TIMEOUT_SEC });
        if (out.exitCode !== 0) console.warn(`${nowIso()} WARN a setup command failed in a session's box {"sessionId":"${session}","exitCode":${out.exitCode}}`);
      }
      const l: Live = { record, box, dir, failed: 0 };
      live.set(session, l);
      keepAlive(b, l, KEEP_ALIVE.everyMs);
      if (setupAgain.length) stages.done("setup");
      stages.end();
      console.log(`${nowIso()} INFO a hosted box is ready for the session {"sessionId":"${session}","provider":"${provider}"}`);
      return l;
    } catch (error) {
      box?.close();
      await b.destroy(record).catch(() => {});
      rmSync(recordFile(dir), { force: true });
      if (error instanceof ProviderError || error instanceof HostedDown) throw error;
      throw new StartStep(STEP_WORDS[step], (error as Error).message);
    }
  })();
  made.catch(() => {
    if (!live.has(session)) boxed.delete(session);
  });
  making.set(session, made);
  try {
    return await made;
  } finally {
    making.delete(session);
  }
}

let watching: (() => void) | undefined;

/** The team's tailnet in `box` as the node has it now; `always`: say so to a box when it's off too (a change). A box
 * that can't take it (one from an older template) carries on without it, and the log says why. Live boxes follow each
 * change from here on. */
async function withTailnet(box: Box, session: string, always: boolean): Promise<void> {
  const t = nodeTailnet();
  if (!t) return;
  watching ??= t.onChange(() => {
    for (const [id, l] of live) void withTailnet(l.box, id, true);
  });
  if (!t.on && !always) return;
  try {
    await box.tailnet(t.on ? (t.suffix ?? "") : null);
  } catch (error) {
    console.warn(`${nowIso()} WARN the team's tailnet isn't in a session's box {"sessionId":"${session}","error":${JSON.stringify((error as Error).message)}}`);
  }
}

/** The checkout's own dir (the repo the worktree belongs to), or undefined. */
async function gitRoot(cwd: string): Promise<string | undefined> {
  const child = Bun.spawn(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 && out.endsWith("/.git") ? dirname(out) : undefined;
}

/** No box came up for the session: its run fails so that fleetd's recovery starts it again (the hub's `sandbox`
 * failure class), where the slot board then puts it. */
export class HostedDown extends LaunchError {}

/** A box came up but the session couldn't start in it: a step of its start failed (its repo, its files, setup),
 * Claude's endpoint is out of its reach, or fleetd's session host didn't come up there. The provider isn't set aside: a
 * lead's start tries once more (../sessions/index.ts), a task's recovery once, and the run then fails with these plain
 * words; the log keeps the detail. */
export class BoxNotReady extends HostedDown {}

/** A step of a box's start that failed on fleetd's side, not the provider's: `plain` is what a person reads (the
 * provider's row, a queued agent's reason, the lead's chat line); the error's own text, with its paths and tool output,
 * goes to the log only. */
class StartStep extends Error {
  constructor(
    readonly plain: string,
    readonly detail: string,
  ) {
    super(plain);
  }
}

/** What a person reads for each step of a box's start that can fail on fleetd's side. */
const STEP_WORDS = {
  setup: "fleetd couldn't set it up",
  repo: "it couldn't get the repo",
  files: "it couldn't get the bot's files",
} as const;

/** Why no box came up for the session. Only the provider's own refusal (a ProviderError: its key, billing, limits, its
 * template, its API not answering) sets it aside for a while, so the run's retry goes to this machine's slots or waits in
 * line rather than fail there again. A failure of this session's own (a step of its start: its repo, its files, its
 * setup) or of this machine's fails this start alone, in its own words, and every other bot's start goes on. */
function failed(provider: ProviderId, error: unknown): HostedDown {
  if (error instanceof HostedDown) return error;
  const detail = (error as Error).message;
  if (!(error instanceof ProviderError)) {
    // Fleetd's own failures (a step of the start, or before the box) in plain words; their detail stays in the log.
    const logged = error instanceof StartStep ? `${error.plain}: ${error.detail}` : detail;
    console.warn(`${nowIso()} WARN a hosted box didn't come up {"provider":"${provider}","error":${JSON.stringify(logged)}}`);
    return error instanceof StartStep
      ? new BoxNotReady(`its sandbox at ${NAMES[provider]} came up, but ${error.plain}`)
      : new HostedDown(`no hosted sandbox came up at ${NAMES[provider]}: fleetd couldn't start it`);
  }
  const b = boxes();
  b?.setAside(provider, detail, Date.now(), error.reason);
  // In the words the hub shows on the provider's row, in queued agents' reasons and in the lead's chat line.
  const aside = b?.trouble().find((t) => t.provider === provider && t.what === "start");
  return new HostedDown(aside ? troubleLine(troubleOf(provider, aside)) : `no hosted sandbox came up at ${NAMES[provider]}: ${detail}`);
}

/** The session's box, made when it has none; a provider set aside isn't asked for another until its time is out. */
async function boxFor(provider: ProviderId, session: string, dir: string, cwd: string, env: Record<string, string | undefined>, size?: Size): Promise<Live> {
  // In the words the hub shows on the provider's row and in queued agents' reasons.
  const aside = live.has(session) ? undefined : boxes()?.trouble().find((t) => t.provider === provider && t.what === "start");
  if (aside) throw new HostedDown(troubleLine(troubleOf(provider, aside)));
  try {
    return await ensure(provider, session, dir, cwd, env, size);
  } catch (error) {
    throw failed(provider, error);
  }
}

/** `l`'s box is no longer live here: when it was its provider's last, a keep-alive failure has no box left to keep. */
function letGo(l: Live | undefined): void {
  if (!l) return;
  const p = l.record.provider;
  if (![...live.values()].some((o) => o.record.provider === p)) boxes()?.noneLive(p);
}

/** The session's box goes: its work and transcript back here, then the box is destroyed. Idempotent. */
export function teardown(session: string, dir: string, o: { takeBack?: boolean } = {}): Promise<void> {
  const already = ending.get(session);
  if (already) return already;
  const p = (async () => {
    const l = live.get(session);
    live.delete(session);
    letGo(l);
    if (l?.extender) clearTimeout(l.extender);
    l?.refresher?.();
    // A turn's checkpoint under way ends first: one bundle at a time goes into the worktree.
    await checkpoints.get(session)?.run;
    const record = l?.record ?? readRecord(dir);
    if (!record) return;
    const b = boxes();
    if (!b) return;
    let box = l?.box;
    try {
      box ??= await b.open(record, session);
    } catch {}
    // A box whose guest is gone gives nothing back: the machine keeps the work as the last turn's checkpoint brought it.
    if (box?.ended) {
      console.warn(`${nowIso()} WARN a hosted box was lost: its work since its last checkpoint didn't come back {"sessionId":"${session}","since":"${record.since ?? ""}"}`);
      box = undefined;
    }
    let kept = false;
    if (box && o.takeBack !== false && record.cwd && record.base && existsSync(record.cwd)) {
      try {
        await syncOut(box, { cwd: record.cwd, session, base: record.base, env: record.env ?? {} });
      } catch (error) {
        let why: string | undefined = (error as Error).message;
        // Once more at once, over a link of its own: the session's may have dropped as it ended.
        try {
          const again = await b.open(record, session);
          try {
            await syncOut(again, { cwd: record.cwd, session, base: record.base, env: record.env ?? {} });
            why = undefined;
          } finally {
            again.close();
          }
        } catch (error) {
          why = (error as Error).message;
        }
        if (why !== undefined) {
          console.warn(`${nowIso()} WARN a hosted box's work didn't come back {"sessionId":"${session}","error":${JSON.stringify(why)}}`);
          // Not deleted with the only copy of that work: kept, and tried again.
          kept = await keep(b, record, homeOf(dir), why);
        }
      }
    }
    if (box && o.takeBack !== false && record.transcript) await fetchNew(box, record.transcript, TRANSCRIPT_MAX);
    box?.close();
    l?.box.close();
    if (!kept) {
      try {
        await b.destroy(record);
      } catch (error) {
        // The reaper deletes it later, by its labels.
        console.warn(`${nowIso()} WARN a hosted box wasn't deleted {"sessionId":"${session}","error":${JSON.stringify(logWords(error))}}`);
      }
    }
    rmSync(recordFile(dir), { force: true });
  })().finally(() => {
    if (!live.has(session) && !making.has(session)) boxed.delete(session);
  });
  ending.set(session, p);
  return p.finally(() => ending.delete(session));
}

/** The work of `session`'s box back on the machine after one of its turns: its commits and uncommitted work into the
 * worktree, and what its transcript gained. Nothing waits on it: a failure is logged, and the next turn's tries again.
 * A turn that ends while one runs gets one more after it. */
export function checkpoint(session: string): Promise<void> {
  const l = live.get(session);
  if (!l) return Promise.resolve();
  const under = checkpoints.get(session);
  if (under) {
    under.again = true;
    return under.run;
  }
  const c = { again: true, run: Promise.resolve() };
  c.run = (async () => {
    while (c.again && live.get(session) === l && !l.box.ended) {
      c.again = false;
      await bringBack(l);
    }
  })().finally(() => checkpoints.delete(session));
  checkpoints.set(session, c);
  return c.run;
}

async function bringBack(l: Live): Promise<void> {
  const { record, box } = l;
  if (!record.cwd || !record.base || !existsSync(record.cwd)) return;
  const at = nowIso();
  try {
    await syncOut(box, { cwd: record.cwd, session: record.session, base: record.base, env: record.env ?? {} });
    if (record.transcript) await fetchNew(box, record.transcript, TRANSCRIPT_MAX);
    record.since = at;
    l.notBack = false;
    if (live.get(record.session) === l) save(l.dir, record);
  } catch (error) {
    const why = (error as Error).message;
    console.warn(`${nowIso()} WARN a hosted box's work didn't come back after its turn: the next turn tries again {"sessionId":"${record.session}","error":${JSON.stringify(why)}}`);
    if (l.notBack) return;
    l.notBack = true;
    say({ sessionId: record.session, state: "not_back", text: `its sandbox's work since ${hhmm(record.since)} didn't come back to the machine after its turn (${short(why)}); fleetd tries again after its next turn.` });
  }
}

/**
 * Keeps the box of `record`, whose work didn't come back as it ended (`why`): its life set to an hour from now and its
 * record kept for `tryKept`. False when it couldn't be kept: the box goes, and the lead is told its work went with it.
 */
async function keep(b: Boxes, record: HostedRecord, home: string, why: string): Promise<boolean> {
  const untilMs = Date.now() + KEPT.forMs;
  try {
    await b.extend(record);
    mkdirSync(keptDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(keptFile(home, record.session), JSON.stringify({ record, untilMs } satisfies KeptBox), { mode: 0o600 });
  } catch (error) {
    const e = (error as Error).message;
    console.warn(`${nowIso()} WARN a hosted box whose work didn't come back couldn't be kept {"sessionId":"${record.session}","error":${JSON.stringify(e)}}`);
    say({ sessionId: record.session, state: "given_up", text: givenUp(record, why, `the sandbox couldn't be kept to try again: ${short(e)}`) });
    return false;
  }
  console.warn(`${nowIso()} WARN a hosted box is kept: its work didn't come back as it ended {"sessionId":"${record.session}","until":"${new Date(untilMs).toISOString()}"}`);
  say({
    sessionId: record.session,
    state: "kept",
    untilMs,
    text: `its sandbox ended with its work since ${hhmm(record.since)} not back on the machine (${short(why)}), so the sandbox is kept and fleetd tries again every ${KEPT.everyMs / 60_000} minutes until ${hhmm(untilMs)}.`,
  });
  return true;
}

const givenUp = (r: HostedRecord, why: string, then?: string) =>
  `its sandbox's work since ${hhmm(r.since)} never came back to the machine (${short(why)}${then ? `; ${then}` : ""}), so fleetd gave it up and deleted the sandbox; the machine's worktree has its work as of ${hhmm(r.since)}.`;

/** The ids of the boxes kept here (`keep`), which the node's sweep of leftover boxes leaves alone. */
export function keptBoxes(home: string): Set<string> {
  const out = new Set<string>();
  for (const name of existsSync(keptDir(home)) ? readdirSync(keptDir(home)) : []) {
    try {
      out.add((JSON.parse(readFileSync(join(keptDir(home), name), "utf8")) as KeptBox).record.boxId);
    } catch {}
  }
  return out;
}

/** Before a new box for `session` starts: its kept box's work back if it can be, and the kept box gone either way. */
export const settleKept = (home: string, session: string) => tryKept(home, session, true);

/** Tries every kept box again (the node's sweep, and its start). */
export async function retryKept(home: string): Promise<void> {
  for (const name of existsSync(keptDir(home)) ? readdirSync(keptDir(home)) : []) {
    if (name.endsWith(".json")) await tryKept(home, name.slice(0, -".json".length), false);
  }
}

/**
 * Brings the kept box of `session` back, if there is one: deleted once its work is on the machine; kept for the next
 * try while it answers and its time isn't up; else (or `last`: a new box for the session is starting) deleted without
 * it, and the lead is told.
 */
async function tryKept(home: string, session: string, last: boolean): Promise<void> {
  // A try under way ends first; a settle then makes its own last one, as the box may still be kept.
  const going = retrying.get(session);
  if (going) {
    await going;
    if (!last) return;
  }
  // While the session has a box of its own, only its next start settles a kept one: a retry never writes its worktree.
  if (!last && (live.has(session) || making.has(session))) return;
  const file = keptFile(home, session);
  const b = boxes();
  if (!b || !existsSync(file) || retrying.has(session)) return;
  let k: KeptBox;
  try {
    k = JSON.parse(readFileSync(file, "utf8")) as KeptBox;
  } catch {
    return;
  }
  const run = tryOne(b, file, k, session, last);
  retrying.set(session, run);
  try {
    await run;
  } finally {
    retrying.delete(session);
  }
}

/** One try of the kept box `k` (`tryKept`). */
async function tryOne(b: Boxes, file: string, k: KeptBox, session: string, last: boolean): Promise<void> {
  const r = k.record;
  let box: Box | undefined;
  try {
    box = await b.open(r, session);
  } catch {}
  let why: string | undefined;
  if (!box || box.ended) why = "the sandbox is gone";
  else if (!r.cwd || !r.base || !existsSync(r.cwd)) why = "its worktree is gone from the machine";
  else {
    try {
      await syncOut(box, { cwd: r.cwd, session, base: r.base, env: r.env ?? {} });
      if (r.transcript) await fetchNew(box, r.transcript, TRANSCRIPT_MAX);
    } catch (error) {
      why = (error as Error).message;
    }
  }
  const answers = box !== undefined && !box.ended;
  box?.close();
  if (why !== undefined && !last && answers && Date.now() < k.untilMs) return;
  if (why === undefined) console.warn(`${nowIso()} WARN a kept hosted box's work came back {"sessionId":"${session}"}`);
  else say({ sessionId: session, state: "given_up", text: givenUp(r, why, last ? "a new sandbox started from the machine's work" : undefined) });
  try {
    await b.destroy(r);
  } catch (error) {
    // The reaper deletes it later, by its labels.
    console.warn(`${nowIso()} WARN a hosted box wasn't deleted {"sessionId":"${session}","error":${JSON.stringify(logWords(error))}}`);
  }
  rmSync(file, { force: true });
}

/** Why the session's box ended without the session asking, in plain words, once; undefined when it didn't. */
export function boxEnd(session: string): string | undefined {
  const why = ends.get(session);
  ends.delete(session);
  return why;
}

/** What a session whose box was lost is told: since when its work is gone. */
function lostWords(r: HostedRecord): string {
  const since = r.since ? ` since ${r.since.slice(11, 16)} UTC` : "";
  return `its sandbox at ${NAMES[r.provider]} stopped, so its work${since} was lost; it goes on from its work as of then`;
}

/** The session ends, its work brought back while its box still answers, and the box goes; `why` is what it hears. */
function endSession(l: Live, why: string): Promise<void> {
  ends.set(l.record.session, why);
  return teardown(l.record.session, l.dir);
}

/** Every live session in a box of `provider` ends, its work brought back, while the node still holds the key that
 * deletes its box (the key being disconnected). What to wait on, one per session. */
export function endHosted(provider: ProviderId, why: string): Promise<void>[] {
  return [...live.values()].filter((l) => l.record.provider === provider).map((l) => endSession(l, why));
}

/** Extends the box's life every KEEP_ALIVE.everyMs while its session has it. A failure is reported (the hub's provider
 * row) and tried again sooner; once the box has KEEP_ALIVE.endBeforeMs left, the session ends with its work brought
 * back, rather than lose it when the provider stops the box at its time. */
function keepAlive(b: Boxes, l: Live, inMs: number): void {
  const { session, provider } = l.record;
  const report = (error?: unknown) => b.keptAlive(provider, error);
  l.extender = setTimeout(async () => {
    if (live.get(session) !== l) return;
    const asked = Date.now();
    try {
      await b.extend(l.record);
      report();
      if (live.get(session) !== l) return;
      l.failed = 0;
      l.record.aliveUntil = asked + LIFETIME_MS;
      save(l.dir, l.record);
      keepAlive(b, l, KEEP_ALIVE.everyMs);
    } catch (error) {
      report(error);
      if (live.get(session) !== l) return;
      l.failed++;
      if (l.failed === 1) console.warn(`${nowIso()} WARN a hosted box couldn't be kept running {"sessionId":"${session}","provider":"${provider}","error":${JSON.stringify(logWords(error))}}`);
      const left = (l.record.aliveUntil ?? asked) - Date.now();
      if (left - KEEP_ALIVE.retryMs >= KEEP_ALIVE.endBeforeMs) return keepAlive(b, l, KEEP_ALIVE.retryMs);
      console.warn(`${nowIso()} WARN ending a hosted session before its box's time runs out {"sessionId":"${session}","failed":${l.failed}}`);
      const name = NAMES[provider];
      void endSession(l, `its sandbox at ${name} couldn't be kept running (${notKept(error, name)}), so it was ended with its work saved before its time ran out`);
    }
  }, inMs);
  l.extender.unref?.();
}

/** Why a box's life couldn't be extended, in plain words, by the provider's kind of refusal. */
function notKept(error: unknown, name: string): string {
  switch (error instanceof ProviderError ? error.reason : undefined) {
    case "invalid_key":
      return `${name} refused the team's key`;
    case "billing":
      return `${name} want the account's billing sorted out`;
    case "limit":
      return `${name} are at the account's plan limit`;
    default:
      return `${name} didn't answer`;
  }
}

/** The session host's lines through the box, ending the box once the session host is gone for good. */
function linkTo(l: Live, dir: string, registration: Registration): Promise<HostLink> {
  let link: HostLink | undefined;
  const session = l.record.session;
  return HostLink.connect(dir, {
    registration,
    dial: (h: HostHandlers) =>
      l.box.dialHost({
        ...h,
        close: () => {
          // The guest went away (the box died, was stopped at its provider, or its time ran out) while nothing here
          // was ending it: the session hears so, and since when its work is lost.
          if (!link?.detached && live.get(session) === l && l.box.ended && !ends.has(session)) ends.set(session, lostWords(l.record));
          h.close();
          // The node letting go (its shutdown) leaves the box running for the next node.
          if (!link?.detached) void teardown(session, dir);
        },
      }),
  }).then((made) => (link = made));
}

/** A hosted place bound to one session; `size`: its bot's pick, exactly (the provider's default when absent). */
export function hostedPlace(provider: ProviderId, session: string, dir: string, size?: Size): Place {
  const home = homeOf(dir);

  /** The session host in the box `l`, with what the launch names and Claude checked from inside it. */
  async function startIn(l: Live, launch: Launch): Promise<HostLink> {
    const env = launch.env;
    const box = l.box;
    const stages = new Stages("hosted start", session);
    // Claude: the box calls the endpoint as set, on the internet or the team's tailnet, checked from inside the box
    // beside the readying below, which it needs none of; the agent starts there only once it answered.
    const endpoint = claudeEndpoint(launch);
    const reach = (hostedProbe.probe ?? probe)(box, endpoint.url).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    // Setup's commands may have made the box, with none of the session's ports: the browser's, adb's and a Claude
    // gateway's are forwarded now, and kept in the record for a re-adopt.
    const ports = forwardedPorts(env).filter((p) => !l.record.tcp.includes(p));
    for (const p of ports) {
      await box.forward(p);
      l.record.tcp.push(p);
    }
    if (ports.length) save(dir, l.record);
    stages.done("ports");
    const PATH = boxPath(env.PATH, home);
    // A box's user may be root, where claude skips its prompts only in a sandbox it is told of.
    const boxEnv = { ...env, PATH, IS_SANDBOX: "1" };
    // What the launch names under the node's home, but for what has its own way in (the worktree, the scratch dir,
    // the hosts' dirs) or stays off inside boxes (the build slots).
    const skip = [join(home, "hosts"), join(home, "tmp"), join(home, "worktrees"), join(home, "build-slots"), launch.cwd];
    await prepare(box, [env.HOME ?? "", env.TMPDIR ?? "", dirname(env.FLEETD_NODE_SOCK ?? "")]);
    stages.done("dirs");
    // The session's MCP config and hooks run this node's fleetd by its path here: in the box, that path is the fleetd
    // the box was given.
    const self = launch.fleetd.length === 1 ? launch.fleetd[0] : undefined;
    if (self) await sh(box, "linking fleetd", `mkdir -p ${shq(dirname(self))} && ln -sf ${shq(`${BOX_DIR}/fleetd`)} ${shq(self)}`);
    stages.done("fleetd");
    const paths = named(launch.args, env, [home], skip);
    // Read before they go: a change while they do goes again at the first look.
    const sent = new Map(paths.map((p) => [p, mtimeOf(p)]));
    await mirror(box, paths);
    stages.done("files");
    l.record.mirrored = paths;
    if (env.CLAUDE_ENV_FILE) l.record.env = { ...l.record.env, CLAUDE_ENV_FILE: env.CLAUDE_ENV_FILE };
    save(dir, l.record);
    watch(l, paths, sent);
    const transcript = sessionFile(configDir(env), launch.cwd, session);
    if (transcript) {
      l.record.transcript = transcript;
      if (existsSync(transcript)) await box.write(transcript, readFileSync(transcript));
    }
    stages.done("transcript");
    const unreachable = await reach;
    if (unreachable) {
      const detail = unreachable.message;
      console.warn(`${nowIso()} WARN a hosted box can't reach Claude {"sessionId":"${session}","source":${JSON.stringify(endpoint.source)},"error":${JSON.stringify(detail)}}`);
      throw new BoxNotReady(await unreached(endpoint, NAMES[provider], nodeTailnet()?.on === true));
    }
    stages.done("claude check");
    const notUp = (detail: string) => {
      console.warn(`${nowIso()} WARN fleetd's session host didn't come up in a hosted box {"sessionId":"${session}","error":${JSON.stringify(detail)}}`);
      return new BoxNotReady(`its sandbox at ${NAMES[provider]} came up, but fleetd didn't start in it`);
    };
    let info: Awaited<ReturnType<Box["start"]>>;
    try {
      info = await box.start({ sessionId: session, program: BOX_CLAUDE.path, args: launch.args, cwd: launch.cwd, env: boxEnv });
    } catch (error) {
      throw notUp((error as Error).message);
    }
    const pid = nobodyPid(session);
    const registration: Registration = { protocol: info.protocol, hostPid: pid, pid, marker: env.FLEETD_RUNNER_SESSION ?? session, refused: info.refused };
    if (info.refused) throw notUp(info.refused.message);
    if (info.protocol !== PROTOCOL) throw notUp(`the box's session host speaks protocol ${info.protocol}, this node ${PROTOCOL}`);
    stages.done("session host");
    stages.end();
    l.record.registration = registration;
    save(dir, l.record);
    return linkTo(l, dir, registration);
  }

  return {
    kind: "hosted",

    async start(launch: Launch): Promise<HostLink> {
      const env = launch.env;
      if (!ACCOUNT_CLEARS.slice(0, 2).some((k) => env[k]) && !env.ANTHROPIC_AUTH_TOKEN)
        throw new LaunchError("this agent runs on the machine's own Claude login, which never leaves the machine: give its bot a Claude account to run it in a hosted sandbox");
      const l = await boxFor(provider, session, dir, launch.cwd, env, size);
      // A start that fails once the box exists (Claude out of its reach, a host that didn't come up) ends the box and
      // its record, or its keep-alive would renew it and the reaper would spare it; the error reaches the task as is.
      // A box no session ever ran in has nothing to bring back: its files are the worktree's as they went in.
      const ran = l.record.registration !== undefined;
      try {
        return await startIn(l, launch);
      } catch (error) {
        await teardown(session, dir, { takeBack: ran });
        throw error;
      }
    },

    async adopt(d) {
      const record = readRecord(d);
      const b = boxes();
      if (!record?.registration || !b) return undefined;
      try {
        const box = await b.open(record, session);
        await withTailnet(box, session, false);
        const l: Live = { record, box, dir: d, failed: 0 };
        live.set(session, l);
        boxed.set(session, record.provider);
        // The launch's files go on reaching the box: all of them at the first look, as any may have changed while no
        // node ran (a GitHub token renewed meanwhile, which ended the one the box holds).
        if (record.mirrored) watch(l, record.mirrored);
        const link = await linkTo(l, d, record.registration);
        // At once: the node before this one may have been gone a while.
        keepAlive(b, l, 0);
        return link;
      } catch {
        return undefined;
      }
    },

    async stop(d) {
      await teardown(session, d);
      rmSync(d, { recursive: true, force: true });
    },

    async end(d) {
      await teardown(session, d);
      dropDisk(homeOf(d), session);
      return 0;
    },

    async run(r) {
      let l: Live;
      try {
        l = await boxFor(provider, session, dir, r.cwd, r.env ?? {}, size);
      } catch (error) {
        return { exitCode: null, outputTail: "", timedOut: false, notRun: (error as Error).message };
      }
      stepped(session, "setup");
      const env = { ...(r.env ?? {}), PATH: boxPath(r.env?.PATH, homeOf(dir)) };
      const out = await l.box.run({ argv: r.argv, cwd: r.cwd, env, timeoutSec: r.timeoutSec, ...(r.signal ? { signal: r.signal } : {}) });
      let tail = out.outputTail;
      for (const s of r.scrub ?? []) if (s) tail = tail.split(s).join("[secret]");
      return { ...out, outputTail: tail };
    },

    async read(root, path, offset, file) {
      const l = live.get(session);
      if (!l) throw new Error(`${path} is not readable here: the agent's hosted sandbox isn't running`);
      return readChatFile(l.box, root, path, offset, file);
    },
  };
}

/** For the node's sweeps (runner/host.ts `stop`): the hosted box `dir` records goes, without its work coming back. */
export async function destroyHosted(dir: string): Promise<void> {
  const record = readRecord(dir);
  if (!record) return;
  const l = live.get(record.session);
  live.delete(record.session);
  letGo(l);
  if (l?.extender) clearTimeout(l.extender);
  l?.box.close();
  // `fleetd session-host stop-all` (a machine's removal) runs without the node: the keys are read from its home.
  let b = boxes();
  if (!b) {
    const home = homeOf(dir);
    const { Boxes } = await import("../sandbox/remote/boxes.ts");
    const { loadOrCreateBoxKey } = await import("../identity.ts");
    b = new Boxes(home, "", loadOrCreateBoxKey(home));
  }
  await b.destroy(record).catch(() => {});
}

/** Where the hub's runner keeps its bots' computer images: snapshots in `provider`, where it saves them (boat); none
 * where a provider doesn't, whose boxes start from the template and run setup. */
export function hostedBackend(home: string, provider: ProviderId | undefined, HOME = process.env.HOME ?? homeDir()): Backend | undefined {
  const b = boxes();
  if (!provider || !b) return undefined;
  let client;
  try {
    client = b.client(provider);
  } catch {
    return undefined;
  }
  if (!client.snapshot) return undefined;
  return { where: provider, base: b.templateName(), build: (j) => buildSnapshot(home, provider, j, HOME), drop: async (ref) => void (await client.forget?.(ref)) };
}

/** A snapshot's name in the team's account: the bot's and its key's. */
export const snapshotName = (project: string, key: string) => `fleetd-${project.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}-${key.slice(0, 12)}`;

/**
 * A bot's computer image in `provider`: a box from the template gets the repo as a session's would (its clone, the
 * build's worktree), runs the setup commands in it with the bot's variables, is checked for their secret values and
 * stripped of what the box alone needed (fleetd's own dir, the worktree, shell history), and saved by the provider.
 * Its sessions then fetch into the clone that is there rather than clone again (../sandbox/remote/files.ts syncIn).
 */
export async function buildSnapshot(home: string, provider: ProviderId, j: Job, HOME: string): Promise<Built> {
  const b = need();
  const session = `image-${j.project}`;
  const PATH = boxPath(process.env.PATH, home);
  const git = await gitRoot(j.cwd);
  const dirs = [HOME, dirname(j.cwd), ...(git ? [dirname(git)] : [])];
  const record = await b.create(provider, session, [], dirs, undefined, { keep: true });
  // No session's record holds it: the sweep leaves it alone until the build ends. A node that stops meanwhile leaves it
  // to the next one's sweep, which deletes it.
  const release = b.hold(record.boxId);
  let box: Box | undefined;
  try {
    box = await b.open(record, session);
    await prepare(box, dirs);
    // The clone takes the runner's token for the repo, at its call only: setup gets the bot's variables alone.
    const origin = Bun.spawnSync(["git", "-C", j.cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    const token = keptToken(origin);
    await syncIn(box, { cwd: j.cwd, session, env: { HOME, PATH, ...(token ? { GH_TOKEN: token } : {}) } });
    const env = { ...j.env, HOME, PATH };
    for (const command of j.setup.commands ?? []) {
      j.log(`$ ${command}`);
      const out = await box.run({ argv: ["sh", "-c", command], cwd: j.cwd, env, timeoutSec: SETUP_TIMEOUT_SEC, scrub: j.secrets });
      j.log(out.notRun ?? out.outputTail);
      if (out.notRun || out.exitCode !== 0) throw new Error(`\`${command}\` ${out.notRun ?? (out.timedOut ? `passed its ${SETUP_TIMEOUT_SEC} s limit` : `exited ${out.exitCode}`)}`);
    }
    const st = await box.run({ argv: ["git", "status", "--porcelain", "--ignored", "--untracked-files=normal"], cwd: j.cwd, env, timeoutSec: 60 });
    const worktree = st.exitCode !== 0 || st.outputTail.trim() !== "";
    const secrets = [...j.secrets, ...(token ? [token] : [])].filter((v) => v.length >= 8);
    const where = [HOME, ...(git ? [git] : [])].map(shq).join(" ");
    const sealed = await box.run({
      argv: ["sh", "-c", [
        `rm -rf ${shq(`${HOME}/.bash_history`)} ${shq(`${HOME}/.claude`)} ${shq(`${BOX_DIR}`)}/in-*.bundle`,
        git ? `git -C ${shq(git)} worktree remove --force ${shq(j.cwd)} 2>/dev/null; rm -rf ${shq(j.cwd)}` : ":",
        'if [ -n "$FLEETD_SECRETS" ]; then',
        '  f=$(mktemp); printf "%s\\n" "$FLEETD_SECRETS" > "$f"',
        `  hits=$(grep -rlFa -f "$f" ${where} 2>/dev/null | head -5 || true); rm -f "$f"`,
        '  if [ -n "$hits" ]; then echo "$hits"; exit 3; fi',
        "fi",
        "sync",
      ].join("\n")],
      cwd: "/",
      env: { PATH, FLEETD_SECRETS: secrets.join("\n") },
      timeoutSec: SETUP_TIMEOUT_SEC,
      scrub: secrets,
    });
    if (sealed.exitCode === 3) throw new Error(`setup wrote the value of one of the bot's secret variables into ${sealed.outputTail.trim().split("\n").join(", ")}: an image never holds one, so write it where the session starts instead (an environment variable)`);
    if (sealed.notRun || sealed.exitCode !== 0) throw new Error(`the box couldn't be readied for its snapshot: ${sealed.notRun ?? sealed.outputTail.trim().slice(-500)}`);
    const ref = await b.client(provider).snapshot!(record.boxId, snapshotName(j.project, j.key));
    return { ref, worktree };
  } finally {
    box?.close();
    await b.destroy(record).catch(() => {});
    release();
  }
}
