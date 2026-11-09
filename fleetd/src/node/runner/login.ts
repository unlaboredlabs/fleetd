// Claude Code's login from the app: `node_action` `claude_login` starts its
// `auth login` on a terminal of its own (Bun's PTY), with the runner's environment so the login lands where sessions
// read it, and answers with the sign-in URL it prints. `claude_login_code` types the code the page showed into the
// waiting login. Claude Code keeps its token here: nothing of it is read or sent. One login at a time: a new one ends
// the last, and one nobody finishes ends after 10 minutes.
import type { Env } from "../util.ts";

const URL_WAIT_MS = 30_000;
const CODE_WAIT_MS = 60_000;
const ABANDONED_MS = 600_000;
const OUTPUT_MAX = 64 * 1024;
/** Between the code and its Enter, as a person types them: a raw-mode terminal app takes one write as a paste. */
const ENTER_AFTER_MS = 300;

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL = /https:\/\/[^\s\x07\x1b"'<>]+/g;

/** The URL to sign in at: the first that names OAuth, else the first; only a whole one, with something after it. */
export function signInUrl(output: string): string | undefined {
  const text = output.replace(CSI, "");
  const urls = [...text.matchAll(URL)].filter((m) => m.index! + m[0].length < text.length).map((m) => m[0]);
  return urls.find((u) => u.includes("oauth")) ?? urls[0];
}

/** Its last line with words, without terminal sequences. */
export function lastWords(output: string): string {
  const lines = output
    .replace(CSI, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\p{Cc}]+|[\s\p{Cc}]+$/gu, ""))
    .filter(Boolean);
  return [...(lines[lines.length - 1] ?? "it printed nothing")].slice(0, 300).join("");
}

type Waiting = { proc: Bun.Subprocess; terminal: Bun.Terminal; output: { text: string }; started: number; exited: boolean };

export class Logins {
  #waiting: Waiting | undefined;
  constructor(readonly codeWaitMs = CODE_WAIT_MS) {}

  #end(): void {
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

  /** Starts `<binary> auth login` and answers the URL it prints; the last login, if any, ends. */
  async start(binary: string, env: Env): Promise<string> {
    this.#end();
    const output = { text: "" };
    const decoder = new TextDecoder();
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([binary, "auth", "login"], {
        env: { ...env, BROWSER: "true", TERM: "dumb", NO_COLOR: "1" },
        terminal: {
          cols: 2000,
          rows: 40,
          data: (_t, data) => {
            if (output.text.length < OUTPUT_MAX) output.text += decoder.decode(data, { stream: true });
          },
        },
      });
    } catch (error) {
      throw new Error(`couldn't start ${binary} auth login: ${(error as Error).message}`);
    }
    const waiting: Waiting = { proc, terminal: proc.terminal!, output, started: Date.now(), exited: false };
    void proc.exited.then(() => (waiting.exited = true));
    this.#waiting = waiting;
    const until = Date.now() + URL_WAIT_MS;
    for (;;) {
      const url = signInUrl(output.text);
      if (url) return url;
      if (this.#waiting !== waiting || waiting.exited || Date.now() >= until) {
        const ended = waiting.exited;
        if (ended) await Bun.sleep(100);
        if (this.#waiting === waiting) this.#end();
        throw new Error(
          ended
            ? `claude auth login ended without a sign-in URL: ${lastWords(output.text)}`
            : `claude auth login printed no sign-in URL in 30 s: ${lastWords(output.text)}`,
        );
      }
      await Bun.sleep(100);
    }
  }

  /** Types `code` into the waiting login, then Enter a moment later, and answers its last words once it ended well.
   * Its words never repeat the code. */
  async finish(rawCode: string): Promise<string> {
    const code = rawCode.trim();
    const w = this.#waiting;
    if (!w || Date.now() - w.started >= ABANDONED_MS) {
      this.#end();
      throw new Error("no login is waiting for a code: start it again");
    }
    const said = () => lastWords(w.output.text.replaceAll(code, ""));
    try {
      w.terminal.write(code);
      await Bun.sleep(ENTER_AFTER_MS);
      w.terminal.write("\r");
    } catch (error) {
      this.#end();
      throw new Error(`couldn't give the login its code: ${(error as Error).message}`);
    }
    const until = Date.now() + this.codeWaitMs;
    for (;;) {
      if (this.#waiting !== w) throw new Error("the login was replaced by a new one");
      if (w.exited) {
        await Bun.sleep(100);
        const exit = w.proc.exitCode;
        const words = said();
        this.#end();
        if (exit === 0) return words;
        throw new Error(`claude auth login failed: ${words}`);
      }
      if (Date.now() >= until) {
        const words = said();
        this.#end();
        throw new Error(`claude auth login didn't end within ${Math.round(this.codeWaitMs / 1000)} s of its code: ${words}`);
      }
      await Bun.sleep(100);
    }
  }
}

/** The node's one login. */
export const LOGINS = new Logins();
