// The little of cliclack the CLI uses in a terminal: log lines, intro/outro, confirm, select, input, a spinner and a
// progress bar. Plain lines and prompts read a line at a time; outside a terminal no command calls these.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isatty } from "node:tty";

const bar = "\x1b[90m│\x1b[0m";
const color = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const out = (text: string) => void process.stderr.write(text);

const line = (mark: string, text: string) => {
  const [first, ...rest] = text.split("\n");
  out(`${bar}\n${mark}  ${first}\n${rest.map((l) => `${bar}  ${l}\n`).join("")}`);
};

export const log = {
  info: (text: string) => line(color(34, "●"), text),
  success: (text: string) => line(color(32, "◆"), text),
  warning: (text: string) => line(color(33, "▲"), text),
  error: (text: string) => line(color(31, "■"), text),
  step: (text: string) => line(color(32, "◇"), text),
  remark: (text: string) => line(color(90, "│"), text),
};

export const intro = (title: string) => out(`${color(90, "┌")}  ${color(7, ` ${title} `)}\n`);
export const outro = (text: string) => out(`${bar}\n${color(90, "└")}  ${text}\n\n`);
export const outroCancel = (text: string) => out(`${bar}\n${color(90, "└")}  ${color(31, text)}\n\n`);

/** The terminal can't be read (an error, not Ctrl-D): a prompt takes its default instead. */
export class NoTerminal extends Error {}

let terminalFd: number | undefined;

/**
 * The person's terminal, as an fd to read prompts from and to hand commands run at it (a login): stdin, unless stdin
 * is /dev/tty itself, as `curl … | sh` hands init `</dev/tty`. Bun on macOS can't watch /dev/tty with kqueue (EINVAL,
 * kqueue), so a Bun program given it (claude) dies at its first read; the terminal's own device (/dev/ttys003) works.
 */
export function terminal(): number {
  if (terminalFd !== undefined) return terminalFd;
  terminalFd = 0;
  try {
    const alias = statSync("/dev/tty").rdev;
    if (!isatty(0) || fstatSync(0).rdev !== alias) return terminalFd;
    const name = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(process.pid)], { stdin: "ignore", stderr: "ignore" }).stdout.toString().trim();
    if (!/^[\w/]+$/.test(name) || name.includes("..")) return terminalFd;
    const fd = openSync(`/dev/${name}`, "r+");
    if (isatty(fd) && fstatSync(fd).rdev !== alias) terminalFd = fd;
    else closeSync(fd);
  } catch {}
  return terminalFd;
}

const pending: number[] = [];

/**
 * Reads one line from the terminal (stdin) with blocking reads; undefined when it ends (Ctrl-D). Never through a
 * stream: Bun's stream reader registers the fd with kqueue, which macOS refuses for /dev/tty. A read that fails throws
 * NoTerminal.
 */
export async function readLine(): Promise<string | undefined> {
  const buf = Buffer.alloc(256);
  for (;;) {
    const nl = pending.indexOf(10);
    if (nl >= 0) {
      const bytes = pending.splice(0, nl + 1);
      return Buffer.from(bytes.slice(0, -1)).toString("utf8").replace(/\r$/, "");
    }
    const n = readSome(buf);
    if (n === 0) {
      if (pending.length === 0) return undefined;
      return Buffer.from(pending.splice(0)).toString("utf8");
    }
    pending.push(...buf.subarray(0, n));
  }
}

function readSome(buf: Buffer): number {
  for (;;) {
    try {
      return readSync(terminal(), buf, 0, buf.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") Bun.sleepSync(20);
      else if (code !== "EINTR") throw new NoTerminal(String(code ?? error));
    }
  }
}

/**
 * Reads one line that never shows on the screen (a passphrase): in a terminal the keys aren't echoed; outside one it
 * is stdin's next line. undefined when the person cancels (Ctrl-C, Ctrl-D).
 */
export async function readHidden(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine();
  out(prompt);
  // Raw mode only changes the terminal's settings; the keys are read as readLine reads, never through the stream.
  stdin.setRawMode(true);
  try {
    const buf = Buffer.alloc(64);
    let text = "";
    for (;;) {
      const n = readSome(buf);
      if (n === 0) return undefined;
      for (const ch of buf.subarray(0, n).toString("utf8")) {
        if (ch === "\r" || ch === "\n") return text;
        if (ch === "\u0003" || ch === "\u0004") return undefined;
        if (ch === "\u007f" || ch === "\b") text = [...text].slice(0, -1).join("");
        else if (ch >= " ") text += ch;
      }
    }
  } finally {
    stdin.setRawMode(false);
    out("\n");
  }
}

/** Thrown when the person cancels a prompt. */
export class Cancelled extends Error {}

export async function confirm(question: string, initial: boolean): Promise<boolean> {
  out(`${bar}\n${color(36, "◆")}  ${question} ${color(90, initial ? "(Y/n)" : "(y/N)")} `);
  const answer = await readLine();
  if (answer === undefined) throw new Cancelled();
  const a = answer.trim().toLowerCase();
  return a === "" ? initial : a === "y" || a === "yes";
}

export type Item<T> = { value: T; label: string; hint?: string };

export async function select<T>(question: string, items: Item<T>[], initial = 0): Promise<T> {
  out(`${bar}\n${color(36, "◆")}  ${question}\n`);
  items.forEach((item, i) => out(`${bar}  ${i + 1}. ${item.label}${item.hint ? color(90, `  ${item.hint}`) : ""}\n`));
  for (;;) {
    out(`${bar}  ${color(90, `number (${initial + 1}):`)} `);
    const answer = await readLine();
    if (answer === undefined) throw new Cancelled();
    const n = answer.trim() === "" ? initial + 1 : Number(answer.trim());
    const picked = Number.isInteger(n) ? items[n - 1] : undefined;
    if (picked) return picked.value;
  }
}

export async function input(
  question: string,
  opts: { placeholder?: string; initial?: string; validate?: (text: string) => string | undefined } = {},
): Promise<string> {
  for (;;) {
    const hint = opts.initial ?? opts.placeholder;
    out(`${bar}\n${color(36, "◆")}  ${question}${hint ? color(90, ` (${hint})`) : ""}: `);
    const answer = await readLine();
    if (answer === undefined) throw new Cancelled();
    const text = answer === "" && opts.initial !== undefined ? opts.initial : answer;
    const why = opts.validate?.(text);
    if (why === undefined) return text;
    log.warning(why);
  }
}

/** A spinner: its start line now, its stop line once done. */
export function spinner() {
  return {
    start: (text: string) => out(`${bar}\n${color(35, "◒")}  ${text}\n`),
    stop: (text: string) => line(color(32, "◇"), text),
    error: (text: string) => line(color(31, "■"), text),
  };
}

/** A progress bar: one line per change of message or every 10 percent. */
export function progressBar(total: number) {
  let message = "";
  let shown = -1;
  let position = 0;
  const show = () => {
    const pct = Math.floor((position / Math.max(total, 1)) * 100);
    if (Math.floor(pct / 10) === Math.floor(shown / 10)) return;
    shown = pct;
    out(`${bar}  ${color(90, `${pct}%`)} ${message}\n`);
  };
  return {
    start: (text: string) => {
      message = text;
      out(`${bar}\n${color(35, "◒")}  ${text}\n`);
    },
    setPosition: (n: number) => {
      position = n;
      show();
    },
    setMessage: (text: string) => {
      if (text !== message) shown = -100;
      message = text;
      show();
    },
    stop: (text: string) => line(color(32, "◇"), text),
    error: (text: string) => line(color(31, "■"), text),
  };
}

/** Several of `items`, as numbers separated by commas or spaces; Enter keeps the preselected ones. */
export async function multiselect<T>(question: string, items: Item<T>[], initial: T[]): Promise<T[]> {
  out(`${bar}\n${color(36, "◆")}  ${question}\n`);
  items.forEach((item, i) =>
    out(`${bar}  ${i + 1}. [${initial.includes(item.value) ? "x" : " "}] ${item.label}${item.hint ? color(90, `  ${item.hint}`) : ""}\n`),
  );
  for (;;) {
    out(`${bar}  ${color(90, "numbers (Enter keeps the marked ones, - for none):")} `);
    const answer = await readLine();
    if (answer === undefined) throw new Cancelled();
    const a = answer.trim();
    if (a === "") return initial;
    if (a === "-") return [];
    const picked = a.split(/[\s,]+/).map(Number);
    if (picked.every((n) => Number.isInteger(n) && items[n - 1] !== undefined)) return picked.map((n) => items[n - 1]!.value);
  }
}
