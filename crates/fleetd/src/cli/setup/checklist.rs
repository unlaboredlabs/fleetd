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
    tty: bool,
    /// The running step's title and the line count when it started.
    running: Option<(String, usize)>,
}

impl Checklist {
    pub fn new() -> Self {
        Checklist {
            items: Vec::new(),
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
}
