//! The shell's side of Add project: opening the sheet from any entry point, sending its requests (to the hub, or
//! to the fixture on the bench), feeding it what comes back, and folders or links dropped on the window.

use std::collections::VecDeque;
use std::path::PathBuf;

use fleetd_contracts::app::AppClientMessage;
use gpui::{AnyElement, Context, Entity, ExternalPaths, Focusable, Window, div, prelude::*};

use super::fixture::{self, AddHub};
use super::sheet::{AddEvent, AddSheet};
use super::{Update, link_url, origin_url};
use crate::client::Incoming;
use crate::shell::Shell;
use crate::state::Echo;

/// Link files read for a GitHub address are small; anything bigger isn't one.
const LINK_FILE_MAX: u64 = 64 * 1024;

#[derive(Default)]
pub struct AddUi {
    pub sheet: Option<Entity<AddSheet>>,
    pub open: bool,
    /// The bench's stand-in hub.
    pub fake: Option<AddHub>,
}

impl Shell {
    /// Opens the sheet, or brings back the one still adding. `prefill` is a pasted or dropped URL or path.
    pub(crate) fn open_add(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<AddSheet>> {
        if !self.connected() {
            return None;
        }
        self.palette = None;
        self.floating = None;
        let keep = self.add.sheet.as_ref().filter(|s| s.read(cx).working()).cloned();
        let sheet = match keep {
            Some(s) => s,
            None => {
                let local = self.local_machine();
                let sheet = cx.new(|cx| AddSheet::new(local, window, cx));
                cx.subscribe_in(&sheet, window, Self::on_add_sheet).detach();
                self.add.sheet = Some(sheet.clone());
                let out = self.state.add_discover();
                self.send_add(out, cx);
                sheet
            }
        };
        self.add.open = true;
        self.pending_focus = Some(sheet.focus_handle(cx));
        cx.notify();
        Some(sheet)
    }

    /// This computer's machine id, when it is one of the workers (its name matches this computer's).
    fn local_machine(&self) -> Option<String> {
        if self.bench.is_some() {
            return Some(fixture::LOCAL.into());
        }
        let me = crate::pair::device_name();
        self.state
            .machines
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(&me) || m.machine_id.as_str().eq_ignore_ascii_case(&me))
            .map(|m| m.machine_id.to_string())
    }

    fn on_add_sheet(&mut self, sheet: &Entity<AddSheet>, event: &AddEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            AddEvent::Start(request) => {
                let out = self.state.add_project(request.clone());
                self.send_add(out, cx);
            }
            AddEvent::Open(key) => {
                self.add.open = false;
                self.add.sheet = None;
                self.pick(crate::sidebar::Pick::Project(key.clone()), window, cx);
            }
            AddEvent::Dismiss => self.hide_add(cx),
        }
        let _ = sheet;
        cx.notify();
    }

    /// Esc or a click outside: a finished or untouched sheet goes; one still adding keeps going out of sight.
    pub(crate) fn hide_add(&mut self, cx: &mut Context<Self>) {
        if !self.add.open {
            return;
        }
        self.add.open = false;
        match self.add.sheet.as_ref().filter(|s| s.read(cx).working()) {
            Some(s) => {
                let what = match &s.read(cx).phase {
                    super::sheet::Phase::Working(job) => job.what.clone(),
                    _ => String::new(),
                };
                self.state.echo = Some(Echo { text: format!("Still adding {what}; Add project… shows its progress."), ok: true });
            }
            None => self.add.sheet = None,
        }
        self.focus_composer(cx);
        cx.notify();
    }

    /// Sends the sheet's calls to the hub, or on the bench answers them from the fixture and plays its events.
    pub(crate) fn send_add(&mut self, out: Vec<AppClientMessage>, cx: &mut Context<Self>) {
        let Some(fake) = self.add.fake.as_mut() else {
            self.send(out);
            return self.drain_add(cx);
        };
        let mut timeline = Vec::new();
        let mut queue: VecDeque<AppClientMessage> = out.into();
        while let Some(message) = queue.pop_front() {
            let Some((reply, events)) = fake.answer(&message) else { continue };
            timeline.extend(events);
            queue.extend(self.state.apply(Incoming::Message(reply)));
        }
        self.drain_add(cx);
        if timeline.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            for (delay, event) in timeline {
                cx.background_executor().timer(delay).await;
                let ok = this.update(cx, |this, cx| {
                    this.state.apply(Incoming::Message(event));
                    this.drain_add(cx);
                    cx.notify();
                });
                if ok.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    /// Hands what the hub said about the add to the sheet; says so in the echo line when the sheet is hidden.
    pub(crate) fn drain_add(&mut self, cx: &mut Context<Self>) {
        let updates = std::mem::take(&mut self.state.add.updates);
        let Some(sheet) = self.add.sheet.clone() else { return };
        for update in updates {
            if !self.add.open {
                match &update {
                    Update::Ready(r) => self.state.echo = Some(Echo { text: format!("{} is ready on {}.", r.title, r.machine), ok: true }),
                    Update::Failed(f) => self.state.echo = Some(Echo { text: format!("Adding a project failed: {}", f.message), ok: false }),
                    _ => {}
                }
            }
            sheet.update(cx, |s, cx| s.apply(update, cx));
        }
    }

    /// The open sheet, taking drops itself: the overlay around it hides the window's own drop target.
    pub(crate) fn add_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sheet = self.add.sheet.clone().filter(|_| self.add.open)?;
        Some(
            div()
                .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| this.on_window_drop(paths, window, cx)))
                .child(sheet)
                .into_any_element(),
        )
    }

    /// A folder or link file dropped on the window (the composer takes files it can attach before this sees them).
    pub(crate) fn on_window_drop(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = paths.paths().first().cloned() else { return };
        let Some(sheet) = self.open_add(window, cx) else { return };
        if sheet.read(cx).working() {
            return;
        }
        cx.spawn(async move |_, cx| {
            let read = path.clone();
            let (origin, link) = cx.background_executor().spawn(async move { read_drop(&read) }).await;
            sheet.update(cx, |s, cx| s.dropped(path, origin, link, cx));
        })
        .detach();
    }

    /// FLEETD_SCREEN=board+add[-empty|-url|-cloning|-ready|-error]: the sheet in each state, from the fixture.
    pub(crate) fn bench_add(&mut self, which: &str, window: &mut Window, cx: &mut Context<Self>) {
        // The cloning shot stops the clone's events at 42%.
        let freeze_after = (which == "add-cloning").then_some(3);
        self.add.fake = Some(AddHub { empty: which == "add-empty", freeze_after, ..AddHub::default() });
        let Some(sheet) = self.open_add(window, cx) else { return };
        let (text, go) = match which {
            "add-url" => ("https://github.com/acme/checkout-v2", false),
            "add-cloning" | "add-ready" => ("acme/checkout-v2", true),
            "add-error" => ("acme/ledger-ui", true),
            _ => return,
        };
        sheet.update(cx, |s, cx| {
            s.prefill(text, None, cx);
            if go {
                s.submit(cx);
            }
        });
    }
}

/// A dropped folder's GitHub origin, or the GitHub address in a dropped link file.
fn read_drop(path: &PathBuf) -> (Option<String>, Option<String>) {
    if path.is_dir() {
        let origin = std::fs::read_to_string(path.join(".git").join("config")).ok().and_then(|c| origin_url(&c));
        return (origin, None);
    }
    let small = std::fs::metadata(path).is_ok_and(|m| m.len() <= LINK_FILE_MAX);
    let link = small.then(|| std::fs::read(path).ok()).flatten().and_then(|b| link_url(&String::from_utf8_lossy(&b)));
    (None, link)
}
