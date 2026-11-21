// The screens of an agent that runs in a hosted box, in that box: its browser's Chrome (./box_chrome.ts) and its Linux
// desktop's X display run beside its files and on its network, never on this machine (the hub's runner has none to
// lend). What the node does with a screen stays where it was: it drives Chrome over its DevTools pipe and the display
// over its own X11 connection, records them, and serves their live view and takeover, as for a machine's own screen.
// Only the stream crosses: each is a connection the box's guest makes inside the box (../sandbox/box.ts `dial`) to a
// port on the box's loopback, where socat hands it to Chrome's pipe or to the display's socket.
//
// Each screen keeps its files in a folder of its own under /tmp in the box, and runs in a process session of its own
// (setsid), so ending it kills that session and everything the agent launched on it, and nothing else of the box's.
// The template has what they need (sandbox/image/Dockerfile): Playwright's headless shell at $CHROME, Xvfb, openbox
// and socat.
import { randomBytes } from "node:crypto";
import { xauth } from "../desktop/display.ts";
import { SIZE } from "../desktop/paths.ts";
import type { Launched as AppLaunched, Lent } from "../desktop/screen.ts";
import { X } from "../desktop/x11.ts";
import { detach, dialUntil, enc, hex, PATH, port, type ScreenBox, sh, shq, sweep } from "./box_chrome.ts";

export { boxChrome, dialUntil, reattachChrome, type ScreenBox, streamTransport, timing } from "./box_chrome.ts";

/** How long `launch` waits before it looks at the app. */
const SETTLE_MS = 500;

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
