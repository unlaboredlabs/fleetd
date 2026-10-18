//! The live checklist `fleetd init` prints: one line per step, rewritten in place from "…" to its outcome when
//! nothing else was printed in between.

use std::io::IsTerminal;

#[derive(Clone, Copy, PartialEq, Eq)]
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

pub struct Checklist {
    pub items: Vec<Item>,
    /// Steps left to the user on purpose (`--no-service`: start the hub and nodes): (what, command).
    pub todos: Vec<(String, String)>,
    tty: bool,
    /// The running step's title and the line count when it started.
    running: Option<(String, usize)>,
}

impl Checklist {
    pub fn new() -> Self {
        Checklist {
            items: Vec::new(),
            todos: Vec::new(),
            tty: std::io::stderr().is_terminal(),
            running: None,
        }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.tty {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    pub fn line(&self, item: &Item) -> String {
        let mark = match item.state {
            State::Done => self.paint("32", "✓"),
            State::Failed => self.paint("31", "✗"),
            State::Skipped => self.paint("2", "–"),
            State::Warn => self.paint("33", "!"),
        };
        let mut text = format!("{mark} {}", item.title);
        if !item.detail.is_empty() {
            text.push_str(&format!(": {}", item.detail));
        }
        if let Some(fix) = &item.fix {
            text.push_str(&format!(". Fix: {}", self.paint("1", fix)));
        }
        text
    }

    /// Shows `… title` until the step's outcome replaces it.
    pub fn start(&mut self, title: &str) {
        super::say(&format!("{} {title}", self.paint("2", "…")));
        self.running = Some((title.to_owned(), super::said()));
    }

    pub fn finish(&mut self, title: &str, state: State, detail: &str, fix: Option<&str>) {
        let item = Item {
            title: title.to_owned(),
            state,
            detail: detail.to_owned(),
            fix: fix.map(str::to_owned),
        };
        let in_place = self.tty
            && self
                .running
                .take()
                .is_some_and(|(running, at)| running == title && at == super::said());
        if in_place {
            eprint!("\x1b[1A\r\x1b[2K");
        }
        super::say(&self.line(&item));
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

    /// What the closing summary lists: each failure once (the doctor may find what a step already reported), then
    /// what was left to the user.
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
            lines.push(self.line(item));
        }
        lines.extend(
            self.todos
                .iter()
                .map(|(what, command)| format!("→ {what}: {}", self.paint("1", command))),
        );
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_closing_list_names_each_problem_once_then_what_is_left_to_you() {
        let mut list = Checklist::new();
        list.tty = false;
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
                "✗ claude: not logged in. Fix: claude auth login",
                "✗ gh: not logged in. Fix: gh auth login",
                "→ start the hub: fleetd hub start --home ~/.fleetd/hub --listen 127.0.0.1:4790",
            ]
        );
    }
}
