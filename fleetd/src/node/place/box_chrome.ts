// A hosted agent's browser in its box: Chrome runs beside the agent's files and on its network, never on the machine
// that drives it. What drives it stays outside the box (the browser broker: its guard, its fills, its recording), and
// only the stream crosses: a connection the box's guest makes inside the box (../sandbox/box.ts `dial`) to a port on
// the box's loopback, where socat hands it to Chrome's pipe.
//
// Chrome's pipe is two FIFOs in the screen's folder, which the launcher holds open itself, so Chrome never sees its
// pipe close when a connection drops (the box's link redialled, or the instance driving it replaced by another):
// socat takes the next connection on the same port, one at a time, for GRACE_MS after each one ends. With none by then,
// or once Chrome exits, the launcher's whole process session goes, Chrome with it. Messages crossing as a connection
// drops are lost with it: a new connection starts with a lone NUL, which ends a frame the last one left cut short
// (Chrome answers it as no command), so that piece never swallows the new connection's first command. Where the cut
// fell right before the old command's own NUL, that piece is a whole command, which the NUL completes: Chrome runs it
// once, as the old connection asked, and its answer, under an old id, is dropped. A new connection's own ids never meet
// an old one's answers (BrowserBroker `adopt`).
//
// The guard and the no-read-back seal hold for the agent's driver, which reaches Chrome only through the broker's
// proxy, outside the box. They don't hold against the box itself: a process in it can open the FIFOs, or socat's port
// on the box's loopback while it waits for a connection, and speak raw CDP to Chrome, as it could already reach
// Chrome's pipe through /proc as the same user. What the seal keeps from the agent is what the broker fills over its
// own connection and never sends back on the driver's.
//
// Each Chrome keeps its files in a folder of its own under /tmp in the box, and runs in a process session of its own
// (setsid), so ending it kills that session and everything in it, and nothing else of the box's. A bot's kept profile
// (its sign-ins) may live elsewhere in the box: it is readied before the launch and pruned after, never deleted. The
// template has what it needs (sandbox/image/Dockerfile): Playwright's headless shell at $CHROME, and socat.
// Box side (docs/CONTRIBUTING.md "The package"): what it does in the box goes through the box's own calls.
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { Cdp, type Transport } from "../browser/cdp.ts";
import { args as chromeArgs, type ChromeHandle, KEPT_PREFS, type Launched, merge, NOT_KEPT } from "../browser/launch_args.ts";
import type { Box } from "../sandbox/box.ts";

/** What a screen needs of its box. */
export type ScreenBox = Pick<Box, "run" | "write" | "dial">;
/** And a kept profile's, whose preferences it reads where it can. */
export type KeptBox = ScreenBox & Partial<Pick<Box, "read">>;

/** Where the template keeps the headless shell when the box's environment doesn't name it (CHROME). */
const CHROME = "/usr/local/bin/chrome-headless-shell";
/** The PATH of what is started in the box. */
export const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** How long a box's Chrome waits for a new connection once one dropped, before it goes. */
export const GRACE_MS = 60_000;
/** How long a screen may take to answer once started: a cold Chrome or Xvfb in a fresh box (a test's own); and the
 * grace a box's Chrome keeps after a dropped connection (a test's own too). */
export const timing = { upMs: 30_000, graceMs: GRACE_MS };
/** How long the close waits for Chrome to close by itself, writing out a kept profile's cookies. */
const CLOSE_MS = 2_000;

export const hex = (n: number) => randomBytes(n).toString("hex");
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const enc = (s: string) => new TextEncoder().encode(s);
/** A port on the box's loopback for one screen's stream: a random one, which a box's few screens rarely share. */
export const port = () => 20_000 + (randomBytes(2).readUInt16LE(0) % 30_000);

/** Runs `script` with `sh` in the box; throws what it printed when it fails. */
export async function sh(box: ScreenBox, script: string, env: Record<string, string> = {}, timeoutSec = 30): Promise<string> {
  const out = await box.run({ argv: ["sh", "-c", script], cwd: "/", env: { PATH, ...env }, timeoutSec });
  if (out.notRun) throw new Error(out.notRun);
  if (out.exitCode !== 0) throw new Error(out.outputTail.trim().slice(-500) || `exit ${out.exitCode}`);
  return out.outputTail;
}

/** Starts `script` (a file in the box) in a process session of its own that outlives the call, its session's pid
 * written to `pidFile`. */
export const detach = (box: ScreenBox, script: string, pidFile: string, env: Record<string, string> = {}) =>
  sh(box, `setsid sh ${shq(script)} </dev/null >/dev/null 2>&1 & echo $! > ${shq(pidFile)}`, env);

/**
 * Kills every process session whose id a file in `dir` names (by its session id, as dash's `kill` takes no negative
 * id; never an empty or zero one, which would be pkill's own session), removes `dir`, then kills anything still
 * naming it (Xvfb by its cookie, Chrome by its profile). That last pkill is exec'd: the sweep's own shell names `dir`
 * too, and as pkill it is never one it kills.
 */
export const sweep = (box: ScreenBox, dir: string) =>
  sh(
    box,
    `for f in ${shq(dir)}/*.pid; do [ -f "$f" ] || continue; p=$(cat "$f" 2>/dev/null); case "$p" in ''|*[!0-9]*|0) ;; *) pkill -KILL -s "$p" 2>/dev/null ;; esac; done; rm -rf ${shq(dir)}; exec pkill -KILL -f -- ${shq(dir)} 2>/dev/null`,
  ).catch(() => "");

/** A stream to `port` on the box's loopback once something listens there, trying again until `ms` is up. */
export async function dialUntil(box: ScreenBox, at: number, ms = timing.upMs): Promise<Duplex> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await box.dial("127.0.0.1", at);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`nothing answered in the box within ${ms / 1000} s: ${(e as Error).message}`);
    }
    await Bun.sleep(100);
  }
}

/** Chrome's pipe (NUL-framed JSON, as on fds 3 and 4) over a stream. */
export function streamTransport(s: Duplex): Transport {
  let onMessage: (text: string) => void = () => {};
  const closes: (() => void)[] = [];
  let open = true;
  let buffered = Buffer.alloc(0);
  s.on("data", (chunk: Buffer) => {
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
    for (let at = buffered.indexOf(0); at >= 0; at = buffered.indexOf(0)) {
      const frame = buffered.subarray(0, at).toString("utf8");
      buffered = buffered.subarray(at + 1);
      onMessage(frame);
    }
  });
  const closed = () => {
    if (!open) return;
    open = false;
    for (const fn of closes.splice(0)) fn();
  };
  s.on("close", closed);
  s.on("end", closed);
  s.on("error", closed);
  return {
    send(text) {
      if (!open) return false;
      s.write(`${text}\0`);
      return true;
    },
    onMessage: (fn) => (onMessage = fn),
    onClose: (fn) => closes.push(fn),
    close: () => {
      open = false;
      s.destroy();
    },
  };
}

/** How a box's Chrome starts: on a kept profile at `profile` (a folder in the box) rather than a throwaway one, and
 * the browser at `chrome` rather than the box's $CHROME. */
export type BoxChromeOptions = { profile?: string; chrome?: string };

/** Chrome on the FIFOs, its stderr to its log. */
const chromeLine = (dir: string, chrome: string, argv: string[]) =>
  `exec ${chrome} ${argv.map(shq).join(" ")} 3<${shq(`${dir}/in`)} 4>${shq(`${dir}/out`)} </dev/null >/dev/null 2>>${shq(`${dir}/chrome.log`)}\n`;

/** The launcher: the FIFOs, which it holds open itself, Chrome on them (chrome.sh), and socat handing each connection
 * to them in turn. */
function launcher(dir: string, at: number, graceSec: number): string {
  const q = (name: string) => shq(`${dir}/${name}`);
  return [
    `mkfifo ${q("in")} ${q("out")}`,
    // Held read-write here: Chrome's reads never end and its writes never fail while no connection is there.
    `exec 5<>${q("in")} 6<>${q("out")}`,
    `sh ${q("chrome.sh")} &`,
    "c=$!",
    // Chrome gone: so is everything of this session, and the connection with it.
    `( while kill -0 "$c" 2>/dev/null; do sleep 1; done; kill -KILL 0 ) &`,
    // One connection at a time, however it ended; none within the grace ends the session (socat logs each accept).
    "while :; do",
    `  : >${q("accepts.log")}`,
    `  socat -d -d -lf ${q("accepts.log")} -t 1 TCP-LISTEN:${at},bind=127.0.0.1,reuseaddr,accept-timeout=${graceSec} OPEN:${q("out")},rdonly!!OPEN:${q("in")},wronly`,
    `  grep -q 'accepting connection' ${q("accepts.log")} || break`,
    "done",
    "kill -KILL 0",
    "",
  ].join("\n");
}

/** Readies a bot's kept profile at `dir` in the box for a launch: made when new, the lock and leftovers of a browser
 * before it cleared, what it doesn't keep deleted, and its preferences set (no saved password or form entry, so a value
 * `fill_credential` typed stays only in the session that typed it). */
export async function readyKeptInBox(box: KeptBox, dir: string): Promise<void> {
  const prefs = `${dir}/Default/Preferences`;
  try {
    await sh(box, `mkdir -p ${shq(`${dir}/Default`)} && chmod 700 ${shq(dir)} && cd ${shq(dir)} && rm -f SingletonLock SingletonSocket SingletonCookie`);
    await pruneKeptInBox(box, dir);
    let merged: Record<string, unknown> = {};
    try {
      const read = box.read ? (JSON.parse(new TextDecoder().decode(await box.read(prefs, 8 << 20))) as unknown) : undefined;
      if (read && typeof read === "object" && !Array.isArray(read)) merged = read as Record<string, unknown>;
    } catch {}
    await box.write(prefs, enc(JSON.stringify(merge(merged, structuredClone(KEPT_PREFS)))), 0o600);
  } catch (e) {
    throw new Error(`cannot ready the bot's profile in the box: ${(e as Error).message}`);
  }
}

/** Deletes what a kept profile at `dir` in the box doesn't keep, with no browser on it. */
export const pruneKeptInBox = (box: ScreenBox, dir: string) =>
  sh(box, `cd ${shq(`${dir}/Default`)} 2>/dev/null && rm -rf ${NOT_KEPT.map(shq).join(" ")}; true`);

/** The Chrome at `handle` over a new stream, its pipe answering, and its close. `firstId`: the connection's first id;
 * `again`: an earlier connection to it may have left a frame cut short. */
async function connected(box: ScreenBox, handle: ChromeHandle, kept: string | undefined, firstId: number, ms: number, again = false): Promise<Launched> {
  const stream = await dialUntil(box, handle.port, ms);
  // A frame the last connection left cut short ends here, rather than in front of this one's first: as an empty one,
  // or as the whole command it was but for its NUL, which Chrome then runs, its answer (an old id) dropped.
  if (again) stream.write("\0");
  const cdp = new Cdp(streamTransport(stream), firstId);
  const ready = await Promise.race([
    cdp.call(undefined, "Browser.getVersion").then(
      () => true,
      () => false,
    ),
    Bun.sleep(timing.upMs).then(() => false),
  ]);
  const close = async () => {
    await Promise.race([cdp.call(undefined, "Browser.close").catch(() => {}), Bun.sleep(CLOSE_MS)]);
    stream.destroy();
    cdp.shut();
    await sweep(box, handle.dir);
    if (kept) await pruneKeptInBox(box, kept).catch(() => {});
  };
  if (!ready) {
    stream.destroy();
    cdp.shut();
    throw new Error("it didn't answer on its pipe");
  }
  return { cdp, alive: () => !cdp.isClosed(), close, handle: { ...handle, ...(kept ? { profile: kept } : {}) } };
}

/**
 * A fresh Chrome in the box, on a throwaway profile (or the bot's kept one), with `extra` flags: what the browser
 * broker drives, records and streams as it does a Chrome of its own (../browser/chrome.ts `launch`). Without Chrome's
 * own sandbox: the box is the sandbox, and its user may be root, whom Chrome's refuses.
 */
export async function boxChrome(box: KeptBox, extra: string[] = [], o: BoxChromeOptions = {}): Promise<Launched> {
  const dir = `/tmp/fleetd-browser-${hex(6)}`;
  const at = port();
  const profile = o.profile ?? `${dir}/profile`;
  const argv = chromeArgs("chrome-headless-shell", profile, false, extra);
  await sh(box, `mkdir -p ${shq(o.profile ? dir : profile)} && chmod 700 ${shq(dir)}`);
  if (o.profile) await readyKeptInBox(box, o.profile);
  const chrome = o.chrome ? shq(o.chrome) : `"\${CHROME:-${CHROME}}"`;
  await box.write(`${dir}/chrome.sh`, enc(chromeLine(dir, chrome, argv)), 0o700);
  await box.write(`${dir}/start.sh`, enc(launcher(dir, at, Math.max(1, Math.ceil(timing.graceMs / 1000)))), 0o700);
  try {
    await detach(box, `${dir}/start.sh`, `${dir}/session.pid`);
    return await connected(box, { dir, port: at }, o.profile, 1, timing.upMs);
  } catch (e) {
    const said = await sh(box, `tail -c 600 ${shq(`${dir}/chrome.log`)} 2>/dev/null || true`).catch(() => "");
    await sweep(box, dir);
    throw new Error(`Chrome didn't start in the agent's box: ${(e as Error).message}${said.trim() ? `: ${said.trim()}` : ""}`);
  }
}

/** The box's Chrome at `handle` again, over a new connection, while it still waits for one (GRACE_MS since the last
 * dropped). `firstId`: the new connection's first id, past any the last one used. Throws when it is gone. */
export function reattachChrome(box: ScreenBox, handle: ChromeHandle, firstId: number, ms = timing.upMs): Promise<Launched> {
  return connected(box, { dir: handle.dir, port: handle.port }, handle.profile, firstId, ms, true);
}
