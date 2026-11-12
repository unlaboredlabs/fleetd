// The little of cliclack the CLI uses in a terminal: log lines, intro/outro, confirm, select, input, a spinner and a
// progress bar. Plain lines and prompts read a line at a time; outside a terminal no command calls these.
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

/** Reads one line from stdin; undefined when it ends (Ctrl-D) or is interrupted. */
export async function readLine(): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolve) => {
    let done = false;
    rl.once("line", (l) => {
      done = true;
      rl.close();
      resolve(l);
    });
    rl.once("close", () => {
      if (!done) resolve(undefined);
    });
  });
}

/**
 * Reads one line that never shows on the screen (a passphrase): in a terminal the keys aren't echoed; outside one it
 * is stdin's next line. undefined when the person cancels (Ctrl-C, Ctrl-D).
 */
export async function readHidden(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine();
  out(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise((resolve) => {
      let text = "";
      const done = (value: string | undefined) => {
        stdin.off("data", onData);
        resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return done(text);
          if (ch === "\u0003" || ch === "\u0004") return done(undefined);
          if (ch === "\u007f" || ch === "\b") text = [...text].slice(0, -1).join("");
          else if (ch >= " ") text += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
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
