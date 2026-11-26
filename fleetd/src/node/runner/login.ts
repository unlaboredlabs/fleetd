// An agent's login from the app: `node_action` `claude_login` starts Claude Code's `auth login` (and
// `antigravity_login` Antigravity's `agy acp --login`) on a terminal of its own (Bun's PTY), with the runner's
// environment so the login lands where sessions read it, and answers with the sign-in URL it prints. `claude_login_code`
// (`antigravity_login_code`) types the code the page showed into the waiting login. The agent keeps its token here:
// nothing of it is read or sent. One login of each at a time: a new one ends the last, and one nobody finishes ends
// after 10 minutes. `fleetd init` drives a login the same way, so its own prompt takes the code.
import { basename } from "node:path";
import type { Env } from "../util.ts";
import { CSI, signInUrl } from "./sign_in_url.ts";

export { signInUrl };

const URL_WAIT_MS = 30_000;
const CODE_WAIT_MS = 60_000;
const ABANDONED_MS = 600_000;
const OUTPUT_MAX = 64 * 1024;
/** Between the code and its Enter, as a person types them: a raw-mode terminal app takes one write as a paste. */
const ENTER_AFTER_MS = 300;
/** What claude says to a wrong code, then waits for another at the same prompt. */
const REFUSED = /invalid code/i;

/** Its last line with words, without terminal sequences. */
export function lastWords(output: string): string {
  const lines = output
    .replace(CSI, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\p{Cc}]+|[\s\p{Cc}]+$/gu, ""))
    .filter(Boolean);
  return [...(lines[lines.length - 1] ?? "it printed nothing")].slice(0, 300).join("");
}

type Waiting = { proc: Bun.Subprocess; name: string; terminal: Bun.Terminal; output: { text: string }; started: number; exited: boolean };

export class Logins {
  #waiting: Waiting | undefined;
  constructor(readonly codeWaitMs = CODE_WAIT_MS) {}

  /** Whether a login waits for its code. */
  get waiting(): boolean {
    return this.#waiting !== undefined;
  }

  /** Ends the waiting login, if any. */
  end(): void {
    const w = this.#waiting;
    this.#waiting = undefined;
    if (!w) return;
    // Its whole group: the login and whatever it started.
    try {
      process.kill(-w.proc.pid, "SIGKILL");
    } catch {}
    try {
      w.proc.kill("SIGKILL");
    } catch {}
    try {
      w.terminal.close();
    } catch {}
  }

  /** Starts `argv` (`claude auth login`, `agy acp --login`) and answers the URL it prints; the last login, if any,
   * ends. `browser`: it may open the sign-in page on this machine's screen, whose sign-in then ends it by itself. */
  async start(argv: string[], env: Env, opts: { browser?: boolean } = {}): Promise<string> {
    const name = [basename(argv[0] ?? ""), ...argv.slice(1)].join(" ");
    this.end();
    const output = { text: "" };
    const decoder = new TextDecoder();
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(argv, {
        env: { ...env, ...(opts.browser ? {} : { BROWSER: "true" }), TERM: "dumb", NO_COLOR: "1" },
        terminal: {
          cols: 2000,
          rows: 40,
          data: (_t, data) => {
            if (output.text.length < OUTPUT_MAX) output.text += decoder.decode(data, { stream: true });
          },
        },
      });
    } catch (error) {
      throw new Error(`couldn't start ${name}: ${(error as Error).message}`);
    }
    const waiting: Waiting = { proc, name, terminal: proc.terminal!, output, started: Date.now(), exited: false };
    void proc.exited.then(() => (waiting.exited = true));
    this.#waiting = waiting;
    const until = Date.now() + URL_WAIT_MS;
    for (;;) {
      const url = signInUrl(output.text);
      if (url) return url;
      if (this.#waiting !== waiting || waiting.exited || Date.now() >= until) {
        const ended = waiting.exited;
        if (ended) await Bun.sleep(100);
        if (this.#waiting === waiting) this.end();
        throw new Error(
          ended
            ? `${name} ended without a sign-in URL: ${lastWords(output.text)}`
            : `${name} printed no sign-in URL in 30 s: ${lastWords(output.text)}`,
        );
      }
      await Bun.sleep(100);
    }
  }

  /** Types `code` into the waiting login, then Enter a moment later, and answers its last words once it ended well.
   * Its words never repeat the code. A code it refuses throws at once, the login still waiting for another. */
  async finish(rawCode: string): Promise<string> {
    const code = rawCode.trim();
    const w = this.#waiting;
    if (!w || Date.now() - w.started >= ABANDONED_MS) {
      this.end();
      throw new Error("no login is waiting for a code: start it again");
    }
    const said = () => lastWords(w.output.text.replaceAll(code, ""));
    const from = w.output.text.length;
    try {
      w.terminal.write(code);
      await Bun.sleep(ENTER_AFTER_MS);
      w.terminal.write("\r");
    } catch (error) {
      this.end();
      throw new Error(`couldn't give the login its code: ${(error as Error).message}`);
    }
    const until = Date.now() + this.codeWaitMs;
    for (;;) {
      if (this.#waiting !== w) throw new Error("the login was replaced by a new one");
      if (w.exited) {
        await Bun.sleep(100);
        const exit = w.proc.exitCode;
        const words = said();
        this.end();
        if (exit === 0) return words;
        throw new Error(`${w.name} failed: ${words}`);
      }
      const since = w.output.text.slice(from);
      if (REFUSED.test(since)) throw new Error(`${w.name} failed: ${lastWords(since.replaceAll(code, ""))}`);
      if (Date.now() >= until) {
        const words = said();
        this.end();
        throw new Error(`${w.name} didn't end within ${Math.round(this.codeWaitMs / 1000)} s of its code: ${words}`);
      }
      await Bun.sleep(100);
    }
  }

  /** The waiting login's last words once it ended well by itself (signed in through the page it opened); undefined
   * while it still waits. One that ended otherwise throws. */
  async ended(): Promise<string | undefined> {
    const w = this.#waiting;
    if (!w) throw new Error("no login is waiting for a code: start it again");
    // Its exit, if it came while nothing here ran (a prompt's blocking read), or a moment after its page's sign-in.
    for (let i = 0; i < 10 && !w.exited; i++) await Bun.sleep(100);
    if (!w.exited) return undefined;
    await Bun.sleep(100);
    const [exit, words] = [w.proc.exitCode, lastWords(w.output.text)];
    this.end();
    if (exit === 0) return words;
    throw new Error(`${w.name} failed: ${words}`);
  }
}

/** The node's one Claude login, and its one Antigravity sign-in. */
export const LOGINS = new Logins();
export const AGY_LOGINS = new Logins();
