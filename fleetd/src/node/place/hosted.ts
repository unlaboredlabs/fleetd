// The `hosted` place: a session runs in a box of the team's own hosted provider (boat.dev, E2B or Daytona), one box
// per session, made by this node (../sandbox/remote/boxes.ts). The box shares nothing with the machine, so it gets
// what the session reads at the same absolute paths as here (../sandbox/remote/files.ts): its worktree cloned and
// synced from the machine's, the files its launch names, its transcript to resume. Then everything in the session's
// spec holds unchanged, and so do its tools: node.sock calls and the browser's and adb's ports come back over the
// guest's link (../sandbox/box.ts), named by the box's link, never by what a call claims.
//
// - The box is made at the session's first need of it: setup's `run`, before `start`, which then reuses it.
// - Secrets reach it only at exec: the bootstrap's own secret at its start, the session's variables at the session
//   host's start, over the guest's link. A box is never paused or snapshotted; it is destroyed.
// - Once the session host in it is gone (the agent idled out, stopped, or the box died), its work comes back to the
//   machine's worktree and its transcript to the machine's, and the box is destroyed. The next start makes a new one.
// - A session here has no process on this machine. Its registration names a pid above Linux's PID_MAX_LIMIT (2^22),
//   which no process has, so the node's pid fallbacks (a kill of the group, the orphan sweep) find nothing to act on.
// - The machine's own Claude login never leaves the machine: a session without an account's variables is refused.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProviderError, type ProviderId } from "../../sandbox/providers/index.ts";
import { NAMES } from "../../shared/sandbox.ts";
import { configDir, sessionFile } from "../runner/claude.ts";
import { HostLink, LaunchError, PROTOCOL, type HostHandlers, type Launch, type Registration } from "../runner/host.ts";
import { ACCOUNT_CLEARS } from "../actions/accounts.ts";
import type { Box } from "../sandbox/box.ts";
import { boxes, type BoxRecord, EXTEND_MS } from "../sandbox/remote/boxes.ts";
import { fetchBack, mirror, mtimeOf, named, prepare, readChatFile, sh, syncIn, syncOut } from "../sandbox/remote/files.ts";
import { BOX_DIR } from "../sandbox/remote/bootstrap.ts";
import { homeDir, nowIso } from "../util.ts";
import { boxArgs, claudeEndpoint, publicEndpoint, reach, reachOf, type Reach } from "./endpoint.ts";
import type { Place } from "./index.ts";

/** What a hosted agent can't do, in plain words: its files are in its box, not on this machine. */
export const HOSTED_NO_DESKTOP_LAUNCH =
  "This agent runs in a hosted sandbox, so its files aren't on this machine and the Linux desktop can't launch them. Open what it serves in a browser session instead, or say in your result that the desktop check was skipped.";
export const HOSTED_NO_MAC = "This agent runs in a hosted sandbox, so the agents' Mac can't build from its files, and iOS simulators aren't available to it.";

/** How a box is pointed at Claude and checked (./endpoint.ts reach); tests set a stand-in. */
export const hostedReach: { reach?: (box: Box, r: Reach) => Promise<void> } = {};

/** The Claude Code every hosted template installs, at the version fleetd was tested with (sandbox/providers/recipe.ts):
 * its own install, not /usr/local/bin's, which a provider's image may hold another of (boat's did). Tests set a
 * stand-in. */
export const BOX_CLAUDE = { path: "/opt/claude/.local/bin/claude" };
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
  env?: { HOME?: string; PATH?: string };
};

type Live = { record: HostedRecord; box: Box; extender: ReturnType<typeof setInterval>; refresher?: ReturnType<typeof setInterval> };

/** How often the files a session's launch named are checked for changes (the order's variables, which the node
 * rewrites when the hub renews its GitHub token) and sent to the box again. */
const REFRESH_MS = 30_000;

const live = new Map<string, Live>();
const making = new Map<string, Promise<Live>>();
const ending = new Map<string, Promise<void>>();
/** Every session with a box of its provider's, from the box's making until it is destroyed: what the hub's slot board
 * counts against each provider (the heartbeat's `load.places`). */
const boxed = new Map<string, ProviderId>();

/** The sessions with a box now, being made or going, and its provider. */
export const boxPlaces = (): ReadonlyMap<string, ProviderId> => boxed;

const recordFile = (dir: string) => join(dir, "place.json");

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Whether the session has a box now, or one being made. */
export const hasBox = (session: string) => live.has(session) || making.has(session);

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

/** The ports of this machine a session's tools reach at the same numbers: the browser proxy's and adb's. Claude,
 * wherever it is, is the box's relay (./endpoint.ts). */
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
async function ensure(provider: ProviderId, session: string, dir: string, cwd: string, env: Record<string, string | undefined>): Promise<Live> {
  await ending.get(session);
  const have = live.get(session);
  if (have) return have;
  const pending = making.get(session);
  if (pending) return pending;
  boxed.set(session, provider);
  const made = (async (): Promise<Live> => {
    const b = need();
    const home = homeOf(dir);
    // A record without a live box here: what a node before this one left. That box goes first.
    const old = readRecord(dir);
    if (old) await teardown(session, dir);
    // One HOME for setup's git and the session: the git config made here (its credential helper) is the agent's.
    const HOME = env.HOME ?? homeDir();
    const PATH = boxPath(env.PATH, home);
    const git = await gitRoot(cwd);
    const dirs = [HOME ?? "", home, dirname(cwd), ...(git ? [dirname(git)] : [])];
    const record: HostedRecord = { ...(await b.create(provider, session, forwardedPorts(env), dirs)), session, cwd };
    record.env = { ...(HOME ? { HOME } : {}), PATH };
    save(dir, record);
    let box: Box | undefined;
    try {
      box = await b.open(record, session);
      await prepare(box, dirs);
      record.base = await syncIn(box, { cwd, session, env: { HOME, PATH, ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}) } });
      save(dir, record);
      const extender = setInterval(() => void b.extend(record).catch(() => {}), EXTEND_MS);
      extender.unref?.();
      const l: Live = { record, box, extender };
      live.set(session, l);
      console.log(`${nowIso()} INFO a hosted box is ready for the session {"sessionId":"${session}","provider":"${provider}"}`);
      return l;
    } catch (error) {
      box?.close();
      await b.destroy(record).catch(() => {});
      rmSync(recordFile(dir), { force: true });
      throw error;
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

/** The checkout's own dir (the repo the worktree belongs to), or undefined. */
async function gitRoot(cwd: string): Promise<string | undefined> {
  const child = Bun.spawn(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 && out.endsWith("/.git") ? dirname(out) : undefined;
}

/** Why no box came up, in the provider's plain words; a provider that refused is set aside for a while, so the run's
 * retry goes to this machine's slots or waits in line. */
function failed(provider: ProviderId, error: unknown): LaunchError {
  const why = (error as Error).message;
  if (error instanceof ProviderError) boxes()?.setAside(provider, why);
  return new LaunchError(`no hosted sandbox came up at ${NAMES[provider]}: ${why}`);
}

/** The session's box goes: its work and transcript back here, then the box is destroyed. Idempotent. */
export function teardown(session: string, dir: string): Promise<void> {
  const already = ending.get(session);
  if (already) return already;
  const p = (async () => {
    const l = live.get(session);
    live.delete(session);
    if (l) clearInterval(l.extender);
    if (l?.refresher) clearInterval(l.refresher);
    const record = l?.record ?? readRecord(dir);
    if (!record) return;
    const b = boxes();
    if (!b) return;
    let box = l?.box;
    try {
      box ??= await b.open(record, session);
    } catch {}
    if (box && record.cwd && record.base && existsSync(record.cwd)) {
      try {
        await syncOut(box, { cwd: record.cwd, session, base: record.base, env: record.env ?? {} });
      } catch (error) {
        console.warn(`${nowIso()} WARN a hosted box's work didn't come back {"sessionId":"${session}","error":${JSON.stringify((error as Error).message)}}`);
      }
    }
    if (box && record.transcript) await fetchBack(box, record.transcript, TRANSCRIPT_MAX);
    box?.close();
    try {
      await b.destroy(record);
    } catch (error) {
      // The reaper deletes it later, by its labels.
      console.warn(`${nowIso()} WARN a hosted box wasn't deleted {"sessionId":"${session}","error":${JSON.stringify((error as Error).message)}}`);
    }
    rmSync(recordFile(dir), { force: true });
  })().finally(() => {
    if (!live.has(session) && !making.has(session)) boxed.delete(session);
  });
  ending.set(session, p);
  return p.finally(() => ending.delete(session));
}

/** The session host's lines through the box, ending the box once the session host is gone for good. */
function linkTo(l: Live, dir: string, registration: Registration): Promise<HostLink> {
  let link: HostLink | undefined;
  return HostLink.connect(dir, {
    registration,
    dial: (h: HostHandlers) =>
      l.box.dialHost({
        ...h,
        close: () => {
          h.close();
          // The node letting go (its shutdown) leaves the box running for the next node.
          if (!link?.detached) void teardown(l.record.session, dir);
        },
      }),
  }).then((made) => (link = made));
}

/** A hosted place bound to one session. */
export function hostedPlace(provider: ProviderId, session: string, dir: string): Place {
  return {
    kind: "hosted",

    async start(launch: Launch): Promise<HostLink> {
      const env = launch.env;
      if (!ACCOUNT_CLEARS.slice(0, 2).some((k) => env[k]) && !env.ANTHROPIC_AUTH_TOKEN)
        throw new LaunchError("this agent runs on the machine's own Claude login, which never leaves the machine: give its project a Claude account to run it in a hosted sandbox");
      let l: Live;
      try {
        l = await ensure(provider, session, dir, launch.cwd, env);
      } catch (error) {
        throw failed(provider, error);
      }
      const home = homeOf(dir);
      const box = l.box;
      // Setup's commands may have made the box, with none of the session's ports: the browser's, adb's and a Claude
      // gateway's are forwarded now, and kept in the record for a re-adopt.
      const ports = forwardedPorts(env).filter((p) => !l.record.tcp.includes(p));
      for (const p of ports) {
        await box.forward(p);
        l.record.tcp.push(p);
      }
      if (ports.length) save(dir, l.record);
      const PATH = boxPath(env.PATH, home);
      // A box's user may be root (Daytona's is), where claude skips its prompts only in a sandbox it is told of.
      const boxEnv = { ...env, PATH, IS_SANDBOX: "1" };
      // What the launch names under the node's home, but for what has its own way in (the worktree, the scratch dir,
      // the hosts' dirs) or stays off inside boxes (the build slots).
      const skip = [join(home, "hosts"), join(home, "tmp"), join(home, "worktrees"), join(home, "build-slots"), launch.cwd];
      await prepare(box, [env.HOME ?? "", env.TMPDIR ?? "", dirname(env.FLEETD_NODE_SOCK ?? "")]);
      // The session's MCP config and hooks run this node's fleetd by its path here: in the box, that path is the fleetd
      // the box was given.
      const self = launch.fleetd.length === 1 ? launch.fleetd[0] : undefined;
      if (self) await sh(box, "linking fleetd", `mkdir -p ${shq(dirname(self))} && ln -sf ${shq(`${BOX_DIR}/fleetd`)} ${shq(self)}`);
      const paths = named(launch.args, env, [home], skip);
      await mirror(box, paths);
      // The files among them go again when they change, while the box lives.
      const seen = new Map(paths.filter((p) => !isDir(p)).map((p) => [p, mtimeOf(p)]));
      if (l.refresher) clearInterval(l.refresher);
      l.refresher = setInterval(() => {
        const changed = [...seen].filter(([p, t]) => mtimeOf(p) !== t).map(([p]) => p);
        if (changed.length === 0) return;
        for (const p of changed) seen.set(p, mtimeOf(p));
        void mirror(box, changed.filter((p) => existsSync(p))).catch(() => {});
      }, REFRESH_MS);
      l.refresher.unref?.();
      const transcript = sessionFile(configDir(env), launch.cwd, session);
      if (transcript) {
        l.record.transcript = transcript;
        if (existsSync(transcript)) await box.write(transcript, readFileSync(transcript));
      }
      // Claude: a public endpoint (Anthropic's API) on the box's own network, any other (a gateway on this machine or
      // its tailnet, which a hosted box can't reach) through the node; checked from inside the box before the agent
      // starts there.
      const endpoint = claudeEndpoint(launch);
      let args: string[];
      try {
        const r = reachOf(endpoint.url, { direct: await publicEndpoint(endpoint.url) });
        await (hostedReach.reach ?? reach)(box, r);
        args = boxArgs(launch.args, r);
      } catch (error) {
        throw new LaunchError(`${(error as Error).message} (the endpoint from ${endpoint.source})`);
      }
      l.record.relays = box.relays;
      save(dir, l.record);
      const info = await box.start({ sessionId: session, program: BOX_CLAUDE.path, args, cwd: launch.cwd, env: boxEnv });
      const pid = nobodyPid(session);
      const registration: Registration = { protocol: info.protocol, hostPid: pid, pid, marker: env.FLEETD_RUNNER_SESSION ?? session, refused: info.refused };
      if (info.refused) throw new LaunchError(`no host came up in the box: ${info.refused.message}`, info.refused);
      if (info.protocol !== PROTOCOL) throw new LaunchError(`the box's session host speaks protocol ${info.protocol}, this node ${PROTOCOL}`);
      l.record.registration = registration;
      save(dir, l.record);
      return linkTo(l, dir, registration);
    },

    async adopt(d) {
      const record = readRecord(d);
      const b = boxes();
      if (!record?.registration || !b) return undefined;
      try {
        const box = await b.open(record, session);
        const extender = setInterval(() => void b.extend(record).catch(() => {}), EXTEND_MS);
        extender.unref?.();
        const l: Live = { record, box, extender };
        live.set(session, l);
        boxed.set(session, record.provider);
        return await linkTo(l, d, record.registration);
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
      return 0;
    },

    async run(r) {
      let l: Live;
      try {
        l = await ensure(provider, session, dir, r.cwd, r.env ?? {});
      } catch (error) {
        return { exitCode: null, outputTail: "", timedOut: false, notRun: failed(provider, error).message };
      }
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
  live.get(record.session)?.box.close();
  live.delete(record.session);
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
