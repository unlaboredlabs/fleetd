// What `fleetd init` and `fleetd doctor` print (crates/fleetd/src/cli/setup/checklist.rs): on a terminal a step header
// per group, a spinner while a check runs that resolves to one ✓/✗/!/– line and a one-line fix under a failure;
// without one the same items as plain lines. Colors follow NO_COLOR.
export type State = "done" | "failed" | "skipped" | "warn";
export type Item = { title: string; state: State; detail: string; fix?: string };

/** As the Rust CLI's console crate colors stderr: only a terminal, and never with NO_COLOR. */
const colored = () => process.stderr.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (colored() ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);
const BAR = "│";
const FRAMES = ["◒", "◐", "◓", "◑"];

export class Checklist {
  items: Item[] = [];
  /** Steps left to the user on purpose: (what, command). */
  todos: [string, string][] = [];
  rich = process.stderr.isTTY === true;
  private sections = 0;
  private section = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private barAbove = true;

  setSections(n: number) {
    this.sections = n;
  }

  private out(text: string) {
    this.barAbove = false;
    process.stderr.write(`${text}\n`);
  }

  prompted() {
    this.barAbove = true;
  }

  sectionHeader(name: string) {
    this.section++;
    this.header(name, this.sections > 0 ? `  ${this.section}/${this.sections}` : "");
  }

  heading(name: string) {
    this.header(name, "");
  }

  private header(name: string, count: string) {
    this.stopSpinner();
    if (this.rich) {
      const gap = this.barAbove ? "" : `${dim(BAR)}\n`;
      this.out(`${gap}${paint("36", "◆")}  ${bold(name)}${dim(count)}`);
    } else {
      this.out(`\n${name}${count}`);
    }
  }

  note(text: string) {
    this.stopSpinner();
    for (const l of text.split("\n")) this.out(this.rich ? `${dim(BAR)}  ${l}` : `  ${l}`);
  }

  boxed(title: string, text: string) {
    this.stopSpinner();
    process.stderr.write(`${dim(BAR)}\n${paint("32", "◇")}  ${title}\n${text.split("\n").map((l) => `${dim(BAR)}  ${l}\n`).join("")}`);
    this.barAbove = true;
  }

  line(item: Item): string {
    const mark = {
      done: paint("32", "✓"),
      failed: paint("31", "✗"),
      warn: paint("33", "!"),
      skipped: dim("–"),
    }[item.state];
    let text = item.detail === "" ? `${mark}  ${bold(item.title)}` : `${mark}  ${bold(item.title)} ${item.detail}`;
    if (item.fix !== undefined) {
      text += this.rich ? `\n${dim(BAR)}  ${dim("Fix:")} ${bold(item.fix)}` : `. Fix: ${bold(item.fix)}`;
    }
    return text;
  }

  start(title: string) {
    this.stopSpinner();
    if (!this.rich) return;
    let i = 0;
    const draw = () => process.stderr.write(`\r\x1b[2K${paint("35", FRAMES[i++ % FRAMES.length]!)}  ${title}…`);
    draw();
    this.spinner = setInterval(draw, 100);
  }

  stopSpinner() {
    if (this.spinner === undefined) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    process.stderr.write("\r\x1b[2K");
  }

  finish(title: string, state: State, detail: string, fix?: string) {
    this.stopSpinner();
    const item: Item = { title, state, detail, ...(fix === undefined ? {} : { fix }) };
    this.out(this.line(item));
    this.items.push(item);
  }
  done(title: string, detail: string) {
    this.finish(title, "done", detail);
  }
  failed(title: string, detail: string, fix: string) {
    this.finish(title, "failed", detail, fix);
  }
  skipped(title: string, detail: string) {
    this.finish(title, "skipped", detail);
  }
  warn(title: string, detail: string, fix?: string) {
    this.finish(title, "warn", detail, fix);
  }
  failures() {
    return this.items.filter((i) => i.state === "failed");
  }
  todo(title: string, detail: string, what: string, command: string) {
    this.skipped(title, detail);
    this.todos.push([what, command]);
  }
  hasFix(fix: string) {
    return this.failures().some((i) => i.fix === fix);
  }

  /** Each failure once, as "what: fix", then what was left to the user. */
  needsYou(): string[] {
    const lines: string[] = [];
    const fixes: string[] = [];
    for (const item of this.failures()) {
      if (item.fix !== undefined) {
        if (fixes.includes(item.fix)) continue;
        fixes.push(item.fix);
      }
      lines.push(`${item.title}: ${item.fix ?? item.detail}`);
    }
    lines.push(...this.todos.map(([what, command]) => `${what}: ${command}`));
    return lines;
  }

  outro(needsYou: string[], next: string) {
    this.stopSpinner();
    const title = needsYou.length === 1 ? "1 step needs you" : `${needsYou.length} steps need you`;
    if (this.rich) {
      if (needsYou.length === 0) {
        if (!this.barAbove) this.out(dim(BAR));
      } else {
        this.boxed(title, needsYou.join("\n"));
      }
      process.stderr.write(`${dim(BAR)}\n${dim("└")}  ${next}\n\n`);
    } else {
      if (needsYou.length > 0) {
        this.out(`\n${title}:`);
        for (const l of needsYou) this.out(`  ${l}`);
      }
      this.out(`\n${next}`);
    }
  }
}
