//! What `fleetd init` and `fleetd doctor` print, clack style on a terminal: a step header per group (`◆  Logins
//! 2/6`), a spinner while a check runs that resolves to one ✓/✗/!/– line, a one-line fix under a failure. Without a
//! terminal the same items come out as plain lines. Colors follow NO_COLOR; glyphs fall back to ASCII where the
//! terminal can't show them.

use std::io::{IsTerminal, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use console::{Emoji, style};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Done,
    Failed,
    Skipped,
    Warn,
}

pub struct Item {
    pub title: String,
    pub state: State,
    pub detail: String,
    pub fix: Option<String>,
}

struct Spinner {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

pub struct Checklist {
    pub items: Vec<Item>,
    /// Steps left to the user on purpose (`--no-service`: start the hub and nodes): (what, command).
    pub todos: Vec<(String, String)>,
    pub rich: bool,
    sections: usize,
    section: usize,
    spinner: Option<Spinner>,
    /// The last thing on screen ends with a bar (a prompt's footer, the intro): the next header needs no gap.
    bar_above: bool,
}

const BAR: Emoji = Emoji("│", "|");
const STEP: Emoji = Emoji("◆", "*");
const OK: Emoji = Emoji("✓", "+");
const FAIL: Emoji = Emoji("✗", "x");
const WARN: Emoji = Emoji("!", "!");
const SKIP: Emoji = Emoji("–", "-");
const FRAMES: [Emoji; 4] = [
    Emoji("◒", "-"),
    Emoji("◐", "\\"),
    Emoji("◓", "|"),
    Emoji("◑", "/"),
];

impl Default for Checklist {
    fn default() -> Self {
        Self::new()
    }
}

impl Checklist {
    /// Rich on a terminal, plain lines otherwise.
    pub fn new() -> Self {
        Checklist {
            items: Vec::new(),
            todos: Vec::new(),
            rich: std::io::stderr().is_terminal(),
            sections: 0,
            section: 0,
            spinner: None,
            bar_above: true,
        }
    }

    #[cfg(test)]
    pub fn plain() -> Self {
        let mut list = Self::new();
        list.rich = false;
        list
    }

    pub fn set_sections(&mut self, n: usize) {
        self.sections = n;
    }

    fn out(&mut self, text: &str) {
        self.bar_above = false;
        let text = if self.rich {
            let width = console::Term::stderr().size().1 as usize;
            let bar = format!("{}  ", style(BAR).dim().for_stderr());
            text.lines()
                .map(|line| wrap(line, width, &bar))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            text.to_owned()
        };
        let _ = writeln!(std::io::stderr(), "{text}");
    }

    /// A prompt just finished; cliclack left a bar under it.
    pub fn prompted(&mut self) {
        self.bar_above = true;
    }

    /// A group header: `◆  Logins  2/6`.
    pub fn section(&mut self, name: &str) {
        self.stop_spinner();
        self.section += 1;
        let count = if self.sections > 0 {
            format!("  {}/{}", self.section, self.sections)
        } else {
            String::new()
        };
        if self.rich {
            let gap = if !self.bar_above {
                format!("{}\n", style(BAR).dim().for_stderr())
            } else {
                String::new()
            };
            self.out(&format!(
                "{gap}{}  {}{}",
                style(STEP).cyan().for_stderr(),
                style(name).bold().for_stderr(),
                style(count).dim().for_stderr()
            ));
        } else {
            self.out(&format!("\n{name}{count}"));
        }
    }

    /// A boxed note (the summary); it ends with a bar.
    pub fn boxed(&mut self, title: &str, text: &str) {
        self.stop_spinner();
        let _ = cliclack::note(title, text);
        self.bar_above = true;
    }

    /// Text under the bar: a short explanation or a command to copy.
    pub fn note(&mut self, text: &str) {
        self.stop_spinner();
        for line in text.lines() {
            if self.rich {
                self.out(&format!("{}  {line}", style(BAR).dim().for_stderr()));
            } else {
                self.out(&format!("  {line}"));
            }
        }
    }

    pub fn line(&self, item: &Item) -> String {
        let mark = match item.state {
            State::Done => style(OK).green(),
            State::Failed => style(FAIL).red(),
            State::Warn => style(WARN).yellow(),
            State::Skipped => style(SKIP).dim(),
        }
        .for_stderr();
        let title = style(&item.title).bold().for_stderr();
        let mut text = if item.detail.is_empty() {
            format!("{mark}  {title}")
        } else {
            format!("{mark}  {title} {}", item.detail)
        };
        if let Some(fix) = &item.fix {
            let label = style("Fix:").dim().for_stderr();
            let fix = style(fix).bold().for_stderr();
            if self.rich {
                text.push_str(&format!(
                    "\n{}  {label} {fix}",
                    style(BAR).dim().for_stderr()
                ));
            } else {
                text.push_str(&format!(". Fix: {fix}"));
            }
        }
        text
    }

    /// A running check: a spinner with `title…` until [`Checklist::finish`].
    pub fn start(&mut self, title: &str) {
        self.stop_spinner();
        if !self.rich {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let text = format!("{title}…");
        let thread = std::thread::spawn(move || {
            let term = console::Term::stderr();
            let _ = term.hide_cursor();
            let mut i = 0;
            while !flag.load(Ordering::Relaxed) {
                let frame = style(&FRAMES[i % FRAMES.len()]).magenta().for_stderr();
                let _ = term.clear_line();
                let _ = term.write_str(&format!("{frame}  {text}"));
                i += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = term.clear_line();
            let _ = term.show_cursor();
        });
        self.spinner = Some(Spinner {
            stop,
            thread: Some(thread),
        });
    }

    /// Stops the spinner, so a prompt or a program that needs the terminal can take it.
    pub fn stop_spinner(&mut self) {
        if let Some(mut spinner) = self.spinner.take() {
            spinner.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = spinner.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn finish(&mut self, title: &str, state: State, detail: &str, fix: Option<&str>) {
        self.stop_spinner();
        let item = Item {
            title: title.to_owned(),
            state,
            detail: detail.to_owned(),
            fix: fix.map(str::to_owned),
        };
        let line = self.line(&item);
        self.out(&line);
        self.items.push(item);
    }

    pub fn done(&mut self, title: &str, detail: &str) {
        self.finish(title, State::Done, detail, None);
    }

    pub fn failed(&mut self, title: &str, detail: &str, fix: &str) {
        self.finish(title, State::Failed, detail, Some(fix));
    }

    pub fn skipped(&mut self, title: &str, detail: &str) {
        self.finish(title, State::Skipped, detail, None);
    }

    pub fn warn(&mut self, title: &str, detail: &str, fix: Option<&str>) {
        self.finish(title, State::Warn, detail, fix);
    }

    pub fn failures(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|i| i.state == State::Failed)
    }

    /// A step left to the user: shown now as skipped, and listed again at the end with its command.
    pub fn todo(&mut self, title: &str, detail: &str, what: &str, command: &str) {
        self.skipped(title, detail);
        self.todos.push((what.to_owned(), command.to_owned()));
    }

    /// A failure with this fix is already on the list.
    pub fn has_fix(&self, fix: &str) -> bool {
        self.failures().any(|i| i.fix.as_deref() == Some(fix))
    }

    /// What the closing summary lists: each failure once (the doctor may find what a step already reported), as
    /// "what: fix", then what was left to the user.
    pub fn needs_you(&self) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        let mut fixes: Vec<&str> = Vec::new();
        for item in self.failures() {
            if let Some(fix) = item.fix.as_deref() {
                if fixes.contains(&fix) {
                    continue;
                }
                fixes.push(fix);
            }
            lines.push(format!(
                "{}: {}",
                item.title,
                item.fix.as_deref().unwrap_or(&item.detail)
            ));
        }
        lines.extend(
            self.todos
                .iter()
                .map(|(what, command)| format!("{what}: {command}")),
        );
        lines
    }

    /// The end: a short box of what needs you (if anything), then the one next action.
    pub fn outro(&mut self, needs_you: &[String], next: &str) {
        self.stop_spinner();
        if self.rich {
            if needs_you.is_empty() {
                if !self.bar_above {
                    let bar = style(BAR).dim().for_stderr().to_string();
                    self.out(&bar);
                }
            } else {
                self.boxed(
                    &format!("{} step(s) need you", needs_you.len()),
                    &needs_you.join("\n"),
                );
            }
            let _ = cliclack::outro(next);
        } else {
            if !needs_you.is_empty() {
                self.out(&format!("\n{} step(s) need you:", needs_you.len()));
                for line in needs_you {
                    self.out(&format!("  {line}"));
                }
            }
            self.out(&format!("\n{next}"));
        }
    }
}

/// Word-wraps `line` to `width` columns, continuing under the bar; a word longer than a line (a URL) stays whole.
fn wrap(line: &str, width: usize, bar: &str) -> String {
    let measure = console::measure_text_width;
    if width < 20 || measure(line) <= width {
        return line.to_owned();
    }
    let indent = measure(bar);
    let mut out = String::new();
    let mut used = 0;
    for word in line.split(' ') {
        let w = measure(word);
        // Never break right after the leading mark or bar: a long word then just runs long.
        if used > indent && used + 1 + w > width {
            out.push('\n');
            out.push_str(bar);
            used = indent;
        } else if !out.is_empty() {
            out.push(' ');
            used += 1;
        }
        out.push_str(word);
        used += w;
    }
    out
}

impl Drop for Checklist {
    fn drop(&mut self) {
        self.stop_spinner();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_lines_wrap_under_the_bar_and_keep_long_words_whole() {
        assert_eq!(
            wrap(
                "✓  project none picked; run fleetd init in a terminal",
                30,
                "│  "
            ),
            "✓  project none picked; run\n│  fleetd init in a terminal"
        );
        assert_eq!(wrap("short", 30, "│  "), "short");
        assert_eq!(
            wrap(
                "│  open: fleetd://pair?hub=http%3A%2F%2Fdevbox.example:4791&code=X",
                30,
                "│  "
            ),
            "│  open:\n│  fleetd://pair?hub=http%3A%2F%2Fdevbox.example:4791&code=X"
        );
        assert_eq!(
            wrap(
                "│  fleetd://pair?hub=http%3A%2F%2Fdevbox.example:4791&code=X",
                30,
                "│  "
            ),
            "│  fleetd://pair?hub=http%3A%2F%2Fdevbox.example:4791&code=X"
        );
    }

    #[test]
    fn the_closing_list_names_each_problem_once_then_what_is_left_to_you() {
        let mut list = Checklist::plain();
        list.failed("claude", "not logged in", "claude auth login");
        list.failed("gh", "not logged in", "gh auth login");
        list.failed(
            "doctor hub",
            "claude on the hub is not logged in",
            "claude auth login",
        );
        list.todo(
            "hub",
            "not started",
            "start the hub",
            "fleetd hub start --home ~/.fleetd/hub --listen 127.0.0.1:4790",
        );
        assert!(list.has_fix("gh auth login"));
        assert_eq!(
            list.needs_you(),
            [
                "claude: claude auth login",
                "gh: gh auth login",
                "start the hub: fleetd hub start --home ~/.fleetd/hub --listen 127.0.0.1:4790",
            ]
        );
    }
}
