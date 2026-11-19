// The screens of an agent that runs in a hosted box, in that box: its browser's Chrome and its Linux desktop's X
// display run beside its files and on its network, never on this machine (the hub's runner has none to lend). What
// the node does with a screen stays where it was: it drives Chrome over its DevTools pipe and the display over its
// own X11 connection, records them, and serves their live view and takeover, as for a machine's own screen. Only the
// stream crosses: each is a connection the box's guest makes inside the box (../sandbox/box.ts `dial`) to a port on
// the box's loopback, where socat hands it to Chrome's pipe or to the display's socket.
//
// Each screen keeps its files in a folder of its own under /tmp in the box, and runs in a process session of its own
// (setsid), so ending it kills that session and everything the agent launched on it, and nothing else of the box's.
// The template has what they need (sandbox/image/Dockerfile): Playwright's headless shell at $CHROME, Xvfb, openbox
// and socat.
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { Cdp, type Transport } from "../browser/cdp.ts";
import { args as chromeArgs, type Launched } from "../browser/chrome.ts";
import { xauth } from "../desktop/display.ts";
import { SIZE } from "../desktop/paths.ts";
import type { Launched as AppLaunched, Lent } from "../desktop/screen.ts";
import { X } from "../desktop/x11.ts";
import type { Box } from "../sandbox/box.ts";

/** What a screen needs of its box. */
export type ScreenBox = Pick<Box, "run" | "write" | "dial">;

/** Where the template keeps the headless shell when the box's environment doesn't name it (CHROME). */
const CHROME = "/usr/local/bin/chrome-headless-shell";
/** The PATH of what the node starts in the box. */
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** How long a screen may take to answer once started: a cold Chrome or Xvfb in a fresh box (a test's own). */
export const timing = { upMs: 30_000 };
/** How long `launch` waits before it looks at the app. */
const SETTLE_MS = 500;

const hex = (n: number) => randomBytes(n).toString("hex");
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const enc = (s: string) => new TextEncoder().encode(s);
/** A port on the box's loopback for one screen's stream: a random one, which a box's few screens rarely share. */
const port = () => 20_000 + (randomBytes(2).readUInt16LE(0) % 30_000);

/** Runs `script` with `sh` in the box; throws what it printed when it fails. */
async function sh(box: ScreenBox, script: string, env: Record<string, string> = {}, timeoutSec = 30): Promise<string> {
  const out = await box.run({ argv: ["sh", "-c", script], cwd: "/", env: { PATH, ...env }, timeoutSec });
  if (out.notRun) throw new Error(out.notRun);
  if (out.exitCode !== 0) throw new Error(out.outputTail.trim().slice(-500) || `exit ${out.exitCode}`);
  return out.outputTail;
}

/** Starts `script` (a file in the box) in a process session of its own that outlives the call, its session's pid
 * written to `pidFile`. */
const detach = (box: ScreenBox, script: string, pidFile: string, env: Record<string, string> = {}) =>
  sh(box, `setsid sh ${shq(script)} </dev/null >/dev/null 2>&1 & echo $! > ${shq(pidFile)}`, env);

/** Kills every process session whose pid a file in `dir` names, and anything still naming `dir` (Xvfb by its cookie,
 * Chrome by its profile), then removes `dir`. */
const sweep = (box: ScreenBox, dir: string) =>
  sh(box, `for f in ${shq(dir)}/*.pid; do [ -f "$f" ] && kill -KILL -- "-$(cat "$f")" 2>/dev/null; done; pkill -KILL -f -- ${shq(dir)} 2>/dev/null; rm -rf ${shq(dir)}; true`).catch(() => "");

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

/**
 * A fresh Chrome in the box, on a throwaway profile, with `extra` flags: what the browser broker drives, records and
 * streams as it does a Chrome of its own (../browser/chrome.ts `launch`). Without Chrome's own sandbox: the box is the
 * sandbox, and its user may be root, whom Chrome's refuses.
 */
export async function boxChrome(box: ScreenBox, extra: string[] = []): Promise<Launched> {
  const dir = `/tmp/fleetd-browser-${hex(6)}`;
  const at = port();
  const argv = chromeArgs("chrome-headless-shell", `${dir}/profile`, false, extra);
  await sh(box, `mkdir -p ${shq(`${dir}/profile`)} && chmod 700 ${shq(dir)}`);
  // socat takes one connection, the node's, and gives the launcher its two ends as stdin and stdout, which become
  // Chrome's pipe; when the node lets go, Chrome's pipe closes and it exits.
  await box.write(`${dir}/chrome.sh`, enc(`exec "\${CHROME:-${CHROME}}" ${argv.map(shq).join(" ")} 3<&0 4>&1 </dev/null >/dev/null 2>>${shq(`${dir}/chrome.log`)}\n`), 0o700);
  await box.write(`${dir}/start.sh`, enc(`socat TCP-LISTEN:${at},bind=127.0.0.1,reuseaddr EXEC:${dir}/chrome.sh\n`), 0o700);
  let stream: Duplex;
  try {
    await detach(box, `${dir}/start.sh`, `${dir}/session.pid`);
    stream = await dialUntil(box, at);
  } catch (e) {
    await sweep(box, dir);
    throw new Error(`Chrome didn't start in the agent's box: ${(e as Error).message}`);
  }
  const cdp = new Cdp(streamTransport(stream));
  const ready = await Promise.race([
    cdp.call(undefined, "Browser.getVersion").then(
      () => true,
      () => false,
    ),
    Bun.sleep(timing.upMs).then(() => false),
  ]);
  const close = async () => {
    await Promise.race([cdp.call(undefined, "Browser.close").catch(() => {}), Bun.sleep(2_000)]);
    stream.destroy();
    cdp.shut();
    await sweep(box, dir);
  };
  if (!ready) {
    const said = await sh(box, `tail -c 600 ${shq(`${dir}/chrome.log`)} 2>/dev/null || true`).catch(() => "");
    await close();
    throw new Error(`Chrome in the agent's box didn't answer on its pipe${said.trim() ? `: ${said.trim()}` : ""}`);
  }
  return { cdp, alive: () => !cdp.isClosed(), close };
}

/**
 * A Linux desktop in the box: an Xvfb of its own with a random MIT cookie and openbox on it, its socket reached
 * through socat on the box's loopback. Apps the agent launches run in the box as its user, in its files, each in a
 * session of its own that goes with the display.
 */
export class BoxDisplay implements Lent {
  readonly backend = "box";
  readonly inBox = true;
  #launched = 0;
  #dropped = false;

  private constructor(
    private readonly box: ScreenBox,
    readonly dir: string,
    /** The display's name in the box, as its apps see it. */
    readonly name: string,
    private readonly at: number,
    readonly cookie: Uint8Array,
  ) {}

  static async start(box: ScreenBox): Promise<BoxDisplay> {
    const dir = `/tmp/fleetd-desktop-${hex(6)}`;
    const n = 100 + (randomBytes(2).readUInt16LE(0) % 400);
    const at = port();
    const cookie = new Uint8Array(randomBytes(16));
    const d = new BoxDisplay(box, dir, `:${n}`, at, cookie);
    const socket = `/tmp/.X11-unix/X${n}`;
    try {
      await sh(box, `mkdir -p ${shq(`${dir}/home`)} && chmod 700 ${shq(dir)}`);
      await box.write(`${dir}/xauth`, xauth(cookie), 0o600);
      const env = Object.entries(d.env())
        .map(([k, v]) => `${k}=${shq(v)}`)
        .join(" ");
      await box.write(
        `${dir}/start.sh`,
        enc(
          [
            `cd ${shq(dir)}`,
            `Xvfb :${n} -screen 0 ${SIZE[0]}x${SIZE[1]}x24 -nolisten tcp -noreset -auth ${shq(`${dir}/xauth`)} >xvfb.log 2>&1 &`,
            `i=0; while [ ! -S ${socket} ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done`,
            `${env} openbox >wm.log 2>&1 &`,
            `exec socat TCP-LISTEN:${at},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${socket}`,
            "",
          ].join("\n"),
        ),
        0o700,
      );
      await detach(box, `${dir}/start.sh`, `${dir}/session.pid`);
      // Answers once Xvfb took its socket: the first connect checks the cookie too.
      (await d.connect()).close();
    } catch (e) {
      const said = await sh(box, `tail -c 600 ${shq(`${dir}/xvfb.log`)} 2>/dev/null || true`).catch(() => "");
      await sweep(box, dir);
      throw new Error(`the desktop didn't start in the agent's box: ${(e as Error).message}${said.trim() ? ` (${said.trim()})` : ""}`);
    }
    return d;
  }

  /** What an app on the display sees: the display, its cookie and a home of the display's own. */
  env(): Record<string, string> {
    return { DISPLAY: this.name, XAUTHORITY: `${this.dir}/xauth`, HOME: `${this.dir}/home`, LANG: "C.UTF-8", PATH };
  }

  /** The node's own X11 connection to it. */
  connect(): Promise<X> {
    return X.connect(() => dialUntil(this.box, this.at), this.cookie);
  }

  async launch(command: string, cwd: string): Promise<AppLaunched> {
    if (this.#dropped) throw new Error("the desktop is gone");
    const n = ++this.#launched;
    const script = `${this.dir}/launch-${n}.sh`;
    await this.box.write(script, enc(`cd ${shq(cwd)} 2>/dev/null || cd ${shq(`${this.dir}/home`)}\nexec sh -c ${shq(command)} >${shq(`${this.dir}/launch-${n}.log`)} 2>&1\n`), 0o700);
    await detach(this.box, script, `${this.dir}/launch-${n}.pid`, this.env());
    await Bun.sleep(SETTLE_MS);
    const said = await sh(
      this.box,
      `p=$(cat ${shq(`${this.dir}/launch-${n}.pid`)}); echo "$p"; if kill -0 "$p" 2>/dev/null; then echo running; else echo exited; tail -c 1500 ${shq(`${this.dir}/launch-${n}.log`)}; fi`,
    );
    const [pidLine = "", state = "", ...output] = said.split("\n");
    const pid = Number(pidLine.trim()) || 0;
    // A launch that ended at once says what it printed; its exit code is the box's, which the node doesn't see.
    return state.trim() === "running" ? { pid } : { pid, exited: { code: null, output: output.join("\n").trim() } };
  }

  async drop(): Promise<void> {
    if (this.#dropped) return;
    this.#dropped = true;
    await sweep(this.box, this.dir);
  }
}
