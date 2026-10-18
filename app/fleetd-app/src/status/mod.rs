//! The Status view (⌘. / Ctrl+.): how far the fleet, a project or an order is, as fleetd verified it, and what is
//! in the way. Spec §10.
//!
//! It cannot be stale: the view asks `status_get` when it opens, then holds one `status_wait` open while it shows,
//! so every change arrives as it happens and nothing polls. Staleness of hub data is the hub's call (each source's
//! as-of and reason come in the doc); the app only knows its own link. While that is down the last doc stays,
//! greyed, under "Not live"; after a reconnect the view is a skeleton until the hub answers again, so a cached
//! number never shows as live.

pub mod fixture;
mod header;
mod health;
pub mod number;
mod sections;
mod skeleton;

use std::time::{Duration, Instant};

use gpui::{AnyElement, Context, Task, div, prelude::*, px};

use crate::shell::{Screen, Shell, now_ms};
use crate::state::{Conn, Echo, Out, Purpose, State, parse};
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};
use fleetd_contracts::mcp::{StatusGetInput, StatusGetOutput, StatusSeenInput, StatusWaitInput, StatusWaitOutput};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::prim::{Int, IntOr};
use fleetd_contracts::status::{StaleMark, StatusDoc, StatusScope};

/// How long `status_wait` holds on the hub before answering "unchanged". Short enough that a wait the hub keeps
/// after the view moved on doesn't linger long.
pub const WAIT_SEC: u64 = 25;
/// A wait not answered by `WAIT_SEC` plus this has been lost (a half-open link after sleep or a network switch).
pub const WAIT_GRACE_MS: i64 = 10_000;
/// A look counts for since-you-last-looked after this long on screen with the window focused.
pub const LOOK: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Call {
    Get,
    Wait,
    Seen,
    /// The fleet's doc for the digest notification, asked fresh when the hub's digest is ready.
    Digest,
}

#[derive(Default)]
pub struct StatusState {
    pub scope: Option<StatusScope>,
    pub doc: Option<StatusDoc>,
    /// The local clock when `doc` arrived, to carry its hub `now` forward.
    pub received_ms: i64,
    /// `doc` came on this connection and the wait loop is running: what shows is live.
    pub fresh: bool,
    /// The last call failed; the view says so and offers Retry.
    pub error: Option<String>,
    /// Bumped each time the view goes back to a skeleton or changes scope: the number never tweens across one.
    pub session: u64,
    generation: u64,
    /// When the outstanding `status_wait` must have answered by (local ms).
    pub wait_deadline: Option<i64>,
    /// Settings → Digest: post the digest notification on the hub's `digest.ready`.
    pub digest_on: bool,
    /// The seq the last digest was built at, so the next one counts from that slot: a notification is not a look.
    pub digest_seq: Option<fleetd_contracts::ids::EventSeq>,
    /// A digest notification to post.
    pub digest: Option<crate::notify::Notification>,
}

/// What the view shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Closed,
    /// Waiting for the first doc after opening or reconnecting: no numbers at all.
    Skeleton,
    Live,
    /// The last doc, greyed, under a banner: the link is down or the wait loop failed.
    NotLive,
}

impl StatusState {
    pub fn phase(&self) -> Phase {
        match (&self.scope, &self.doc, self.fresh) {
            (None, _, _) => Phase::Closed,
            (Some(_), None, _) => Phase::Skeleton,
            (Some(_), Some(_), true) => Phase::Live,
            (Some(_), Some(_), false) => Phase::NotLive,
        }
    }

    /// The hub's clock now, from the doc's `now` and the local time since it arrived.
    pub fn hub_now_ms(&self, local_now_ms: i64) -> i64 {
        let at = self.doc.as_ref().and_then(|d| ms(d.now.as_str())).unwrap_or(local_now_ms);
        at + (local_now_ms - self.received_ms).max(0)
    }

    pub(crate) fn disconnected(&mut self) {
        self.fresh = false;
        self.wait_deadline = None;
    }

    fn reset(&mut self) {
        self.doc = None;
        self.fresh = false;
        self.error = None;
        self.wait_deadline = None;
        self.session += 1;
        self.generation += 1;
    }
}

impl State {
    /// Opens (or re-aims) the view. The scope already open sends nothing.
    pub fn status_open(&mut self, scope: StatusScope) -> Out {
        if self.status.scope.as_ref() == Some(&scope) {
            return Vec::new();
        }
        self.status.reset();
        self.status.scope = Some(scope);
        self.status_get()
    }

    /// The view left. `looked`: it was on screen, focused, for at least [`LOOK`], so the hub records the mark
    /// since-you-last-looked counts from next time.
    pub fn status_close(&mut self, looked: bool) -> Out {
        let seen = match (&self.status.scope, &self.status.doc) {
            (Some(scope), Some(doc)) if looked && self.conn == Conn::Live => {
                let input = StatusSeenInput { scope: scope.clone(), seq: doc.seq };
                vec![self.call(Purpose::Status(Call::Seen, 0), &input)]
            }
            _ => Vec::new(),
        };
        self.status.reset();
        self.status.scope = None;
        seen
    }

    /// After a failed call: ask again, keeping the last doc greyed until the answer.
    pub fn status_retry(&mut self) -> Out {
        self.status.error = None;
        self.status.generation += 1;
        // Not live in between: the number must not tween across the gap.
        self.status.session += 1;
        self.status_get()
    }

    /// Called from the shell's 3 s tick: a wait past its deadline was lost, so the view stops claiming to be live
    /// and asks for the doc again.
    pub(crate) fn status_check_deadline(&mut self, now_ms: i64) -> Out {
        match self.status.wait_deadline {
            Some(at) if now_ms > at => {
                let secs = (WAIT_SEC as i64 * 1000 + WAIT_GRACE_MS) / 1000;
                self.status.fresh = false;
                self.status.wait_deadline = None;
                self.status.generation += 1;
                self.status.session += 1;
                // The error stays until a doc arrives; Retry asks again by hand.
                self.status.error = Some(format!("the hub hasn't answered for {secs}s"));
                self.status_get()
            }
            _ => Vec::new(),
        }
    }

    /// Reconnected: back to a skeleton until the hub answers, never the old doc as if live.
    pub(crate) fn status_reconnected(&mut self) -> Out {
        if self.status.scope.is_none() {
            return Vec::new();
        }
        self.status.reset();
        self.status_get()
    }

    fn status_get(&mut self) -> Out {
        match (&self.status.scope, &self.conn) {
            (Some(scope), Conn::Live) => {
                let input = StatusGetInput { scope: scope.clone(), since_seq: None };
                vec![self.call(Purpose::Status(Call::Get, self.status.generation), &input)]
            }
            _ => Vec::new(),
        }
    }

    fn status_wait(&mut self, after: u64) -> Out {
        match (&self.status.scope, &self.conn) {
            (Some(scope), Conn::Live) => {
                let input = StatusWaitInput {
                    scope: scope.clone(),
                    since_seq: None,
                    after: Some(Int::unchecked(after as i64)),
                    timeout_sec: IntOr(Int::unchecked(WAIT_SEC as i64)),
                };
                self.status.wait_deadline = Some(now_ms() + WAIT_SEC as i64 * 1000 + WAIT_GRACE_MS);
                vec![self.call(Purpose::Status(Call::Wait, self.status.generation), &input)]
            }
            _ => Vec::new(),
        }
    }

    /// The hub's morning or evening digest is ready: fetch the fleet's doc now (never a kept one) for the
    /// notification.
    pub(crate) fn status_digest_ready(&mut self) -> Out {
        if !self.status.digest_on || self.conn != Conn::Live {
            return Vec::new();
        }
        let input = StatusGetInput { scope: StatusScope::Fleet, since_seq: self.status.digest_seq };
        vec![self.call(Purpose::Status(Call::Digest, 0), &input)]
    }

    pub(crate) fn on_status_result(&mut self, call: Call, generation: u64, output: serde_json::Value) -> Out {
        if call == Call::Digest {
            let now = now_ms();
            let quiet = self.policy.as_ref().is_some_and(|p| p.quiet_at(now));
            if let (Ok(out), false) = (parse::<StatusGetOutput>(output), quiet) {
                self.status.digest_seq = Some(out.doc.seq);
                let (title, body) = digest_text(&out.doc);
                self.status.digest = Some(crate::notify::Notification { title, body, target: crate::notify::Target::Status });
            }
            return Vec::new();
        }
        if call == Call::Seen || generation != self.status.generation {
            return Vec::new();
        }
        if call == Call::Wait {
            self.status.wait_deadline = None;
        }
        let next = match call {
            Call::Get => parse::<StatusGetOutput>(output).map(|o| Some(o.doc)),
            _ => parse::<StatusWaitOutput>(output).map(|o| o.doc),
        };
        match next {
            Ok(Some(doc)) if Some(&doc.scope) == self.status.scope.as_ref() => {
                let version = doc.version.get() as u64;
                self.status.doc = Some(doc);
                self.status.received_ms = now_ms();
                self.status.fresh = true;
                self.status.error = None;
                self.status_wait(version)
            }
            Ok(Some(_)) => {
                self.on_status_error(call, generation, "the hub answered for another scope".into());
                Vec::new()
            }
            Ok(None) => {
                let version = self.status.doc.as_ref().map_or(0, |d| d.version.get() as u64);
                self.status_wait(version)
            }
            Err(e) => {
                self.on_status_error(call, generation, e);
                Vec::new()
            }
        }
    }

    pub(crate) fn on_status_error(&mut self, call: Call, generation: u64, text: String) {
        match call {
            Call::Seen => self.echo = Some(Echo { text: format!("Couldn't record that you looked: {text}"), ok: false }),
            // No doc, no digest: a notification from old numbers would be worse than none.
            Call::Digest => {}
            _ if generation != self.status.generation => {}
            _ => {
                self.status.error = Some(text);
                self.status.fresh = false;
                self.status.wait_deadline = None;
            }
        }
    }
}

/// The digest notification from a fresh fleet doc: "fleetd · 72%", then the headline (which starts "Not live: …"
/// when a source is stale; said here too if the hub's line doesn't), what changed since you looked, and how many
/// decisions wait.
pub fn digest_text(doc: &StatusDoc) -> (String, String) {
    let p = &doc.progress;
    let title = if p.total.get() > 0 || p.polish_total.get() > 0 { format!("fleetd · {}%", p.pct) } else { "fleetd".to_string() };
    let mut parts = Vec::new();
    let headline = doc.headline.text.to_string();
    if !doc.stale.is_empty() && !headline.starts_with("Not live") {
        let sources: Vec<&str> = doc.stale.iter().map(|s| s.source.as_str()).collect();
        parts.push(format!("Not live: {} stale.", sources.join(", ")));
    }
    parts.push(headline);
    let s = &doc.since;
    let counts: Vec<String> = [(s.merged.get(), "merged"), (s.verified.get(), "verified"), (s.started.get(), "started"), (s.failed.get(), "failed")]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, w)| format!("{n} {w}"))
        .collect();
    if !counts.is_empty() {
        parts.push(format!("Since you looked: {}.", counts.join(", ")));
    }
    match doc.needs_you.count.get() {
        0 => {}
        1 => parts.push("1 needs you.".into()),
        n => parts.push(format!("{n} need you.")),
    }
    (title, parts.join(" "))
}

/// Time on screen with the window focused, for since-you-last-looked.
#[derive(Default)]
pub struct Looked {
    since: Option<Instant>,
    total: Duration,
}

impl Looked {
    pub fn set(&mut self, visible: bool, now: Instant) {
        match (visible, self.since) {
            (true, None) => self.since = Some(now),
            (false, Some(since)) => {
                self.total += now - since;
                self.since = None;
            }
            _ => {}
        }
    }

    /// Ends the look: whether it was long enough to count.
    pub fn take(&mut self, now: Instant) -> bool {
        self.set(false, now);
        let long = self.total >= LOOK;
        *self = Self::default();
        long
    }
}

/// What a screen change does to the Status view: leave it (stop waiting, record the look), and on coming back,
/// reopen the scope it showed.
#[derive(Debug, PartialEq, Eq)]
pub struct Transition {
    pub leave: bool,
    pub reopen: Option<StatusScope>,
}

pub fn transition(from: Screen, to: Screen, open: Option<&StatusScope>, resume: Option<&StatusScope>) -> Transition {
    let leave = from == Screen::Status && to != Screen::Status;
    let reopen = (to == Screen::Status && open.is_none()).then(|| resume.cloned()).flatten();
    Transition { leave, reopen }
}

/// The view's own state on the shell: the number's tween, the look timer, and the one timer that redraws ages.
#[derive(Default)]
pub struct Ui {
    pub number: number::Number,
    pub lists: sections::Lists,
    pub scroll: gpui::ScrollHandle,
    pub looked: Looked,
    /// Screen to go back to when ⌘. closes the view.
    pub before: Option<crate::shell::Screen>,
    /// The scope it showed when it was left, reopened on coming back (Settings' Done).
    pub resume: Option<StatusScope>,
    ages: Option<Task<()>>,
    ages_due: Option<i64>,
}

// ---- formatting --------------------------------------------------------------------------------------------

pub fn ms(iso: &str) -> Option<i64> {
    crate::live::state::parse_ms(iso)
}

/// An age at the view's granularity: "<1m", "4m", "3h", "2d". Ages change once a minute at most, so the view
/// redraws for them at most that often.
pub fn age(ms: i64) -> String {
    let m = ms.max(0) / 60_000;
    match m {
        0 => "<1m".into(),
        1..60 => format!("{m}m"),
        60..2880 => format!("{}h", m / 60),
        _ => format!("{}d", m / 1440),
    }
}

/// A length of time: "40m", "6h", "6h 20m", "3d".
pub fn span(ms: i64) -> String {
    let m = ms.abs() / 60_000;
    match m {
        0 => "<1m".into(),
        1..60 => format!("{m}m"),
        60..600 if m % 60 != 0 => format!("{}h {}m", m / 60, m % 60),
        60..2880 => format!("{}h", m / 60),
        _ => format!("{}d", m / 1440),
    }
}

/// How long until [`age`] would print something else for any of these ages: when to redraw next.
pub fn next_change(ages_ms: impl IntoIterator<Item = i64>) -> Option<i64> {
    ages_ms
        .into_iter()
        .map(|a| {
            let a = a.max(0);
            let step = if a < 3_600_000 {
                60_000
            } else if a < 172_800_000 {
                3_600_000
            } else {
                86_400_000
            };
            step - a % step
        })
        .min()
}

/// A time: "14:02" today (hub clock), "Thu 14:02" within a week, else "Oct 21 14:02".
pub fn when(iso: &str, now_ms: i64) -> String {
    let Some(t) = ms(iso) else { return iso.to_string() };
    let (day, now_day) = (t.div_euclid(86_400_000), now_ms.div_euclid(86_400_000));
    let hm = iso.get(11..16).unwrap_or(iso);
    if day == now_day {
        return hm.to_string();
    }
    if (day - now_day).abs() < 7 {
        const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
        return format!("{} {hm}", DAYS[day.rem_euclid(7) as usize]);
    }
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = iso.get(5..7).and_then(|m| m.parse::<usize>().ok()).unwrap_or(1).clamp(1, 12);
    format!("{} {} {hm}", MONTHS[month - 1], iso.get(8..10).unwrap_or("").trim_start_matches('0'))
}

/// "stale 4m: no heartbeat from buildbox for 4m", for a part the hub marked.
pub fn stale_words(mark: &StaleMark, now: i64) -> String {
    format!("{}: {}", stale_age(mark, now), &*mark.reason)
}

/// "stale 4m", for a part whose reason the list at the top already gives.
pub fn stale_age(mark: &StaleMark, now: i64) -> String {
    ms(mark.since.as_str()).map_or("stale".into(), |at| format!("stale {}", age(now - at)))
}

pub fn project_scope(machine_id: &str, project_id: &str) -> StatusScope {
    StatusScope::Project {
        project_ref: fleetd_contracts::ids::ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(machine_id),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(project_id),
        },
    }
}

pub fn order_scope(workstream_id: &str) -> StatusScope {
    StatusScope::Order { workstream_id: fleetd_contracts::ledger::WorkstreamId::unchecked(workstream_id) }
}

// ---- the screen --------------------------------------------------------------------------------------------

impl Shell {
    pub(crate) fn status_screen(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let phase = self.state.status.phase();
        let local = now_ms();
        let now = self.state.status.hub_now_ms(local);
        let header = self.status_header_bar(phase, now, cx);
        let mut body = div().id("status-body").track_scroll(&self.status_ui.scroll).flex_1().min_h_0().overflow_y_scroll().flex().flex_col();
        let inner = match (phase, self.state.status.doc.clone()) {
            (Phase::Live | Phase::NotLive, Some(doc)) => {
                let session = self.state.status.session;
                let live = phase == Phase::Live;
                let hero = self.status_hero(&doc, session, live, now, cx);
                let rest = div().flex().flex_col().child(self.status_health(&doc, now, cx)).child(self.status_sections(&doc, now, cx));
                self.schedule_ages(&doc, now, cx);
                div().flex().flex_col().child(hero).child(rest).into_any_element()
            }
            _ => skeleton::render(t).into_any_element(),
        };
        let banner = self.status_banner(phase, now, cx);
        body = body.children(banner).child(div().w_full().max_w(px(STATUS_MEASURE)).px_6().pb_6().child(inner));
        div().size_full().flex().flex_col().child(header).child(body).into_any_element()
    }

    /// "Not live: reconnecting · data from 14:02:07", or the failed call with Retry; the skeleton's own line.
    fn status_banner(&mut self, phase: Phase, _now: i64, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = &theme(cx).clone();
        let st = &self.state.status;
        let data_from = st.doc.as_ref().map(|d| format!(" · data from {}", crate::shell::clock(d.now.as_str()))).unwrap_or_default();
        let (text, retry) = match (phase, &st.error, &self.state.conn) {
            (Phase::Live | Phase::Closed, _, _) => return None,
            (_, _, Conn::Connecting { .. }) => (format!("Not live: reconnecting to the hub{data_from}"), false),
            (_, _, Conn::Refused(_)) => (format!("Not live: the hub refused this key{data_from}"), false),
            (_, Some(e), _) => (format!("Not live: the hub's status answer failed: {e}{data_from}"), true),
            (Phase::Skeleton, None, _) => ("Syncing with the hub. Numbers show once it answers.".to_string(), false),
            (Phase::NotLive, None, _) => (format!("Not live{data_from}"), false),
        };
        let warn = phase == Phase::NotLive || st.error.is_some();
        Some(
            div()
                .w_full()
                .max_w(px(STATUS_MEASURE))
                .px_6()
                .pt_4()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .px_3()
                        .py_2()
                        .rounded(px(crate::theme::radius::MD))
                        .border_1()
                        .border_color(if warn { t.warning } else { t.hairline })
                        .child(ui::dot(if warn { t.warning } else { t.faint }))
                        .child(div().flex_1().min_w_0().whitespace_normal().text_color(if warn { t.text } else { t.quiet }).child(text))
                        .when(retry, |d| {
                            d.child(ui::button(t, "status-retry", "Retry", Variant::Secondary, true).on_click(cx.listener(|this, _, _, cx| {
                                let out = this.state.status_retry();
                                this.status_send(out);
                                cx.notify();
                            })))
                        }),
                )
                .into_any_element(),
        )
    }

    /// The bar: where you are (each part clickable), then live or not and as of when.
    fn status_header_bar(&mut self, phase: Phase, now: i64, cx: &mut Context<Self>) -> gpui::Div {
        let t = &theme(cx).clone();
        let scope = self.state.status.scope.clone().unwrap_or(StatusScope::Fleet);
        let mut crumbs: Vec<(String, StatusScope)> = vec![("Fleet".into(), StatusScope::Fleet)];
        match &scope {
            StatusScope::Project { project_ref } => crumbs.push((project_ref.project_id.to_string(), scope.clone())),
            StatusScope::Order { workstream_id } => {
                if let Some((m, p)) = self.state.project_of(workstream_id.as_str()) {
                    crumbs.push((p.clone(), project_scope(&m, &p)));
                }
                crumbs.push((workstream_id.to_string(), scope.clone()));
            }
            StatusScope::Fleet => {}
        }
        let last = crumbs.len() - 1;
        let mut title = div().flex().items_center().gap_1().child(div().font_weight(STRONG).pr_2().child("Status"));
        for (i, (label, to)) in crumbs.into_iter().enumerate() {
            if i > 0 {
                title = title.child(div().text_color(t.faint).child("›"));
            }
            let current = i == last;
            let crumb = ui::clickable(t, div().id(gpui::SharedString::from(format!("status-crumb-{i}"))))
                .px_1()
                .rounded(px(crate::theme::radius::SM))
                .text_color(if current { t.text } else { t.quiet })
                .font_weight(if current { STRONG } else { crate::theme::REGULAR })
                .hover(|s| s.underline())
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| this.open_status(to.clone(), cx)));
            title = title.child(crumb);
        }
        if let StatusScope::Order { workstream_id } = &scope {
            let w = workstream_id.to_string();
            title = title.child(
                ui::button(t, "status-open-order", "Open order", Variant::Ghost, true)
                    .on_click(cx.listener(move |this, _, _, cx| this.open_order(&w, cx))),
            );
        }
        let (dot, words) = match phase {
            Phase::Live => {
                let doc = self.state.status.doc.as_ref();
                let stale = doc.map_or(0, |d| d.stale.len());
                let as_of = doc.map(|d| crate::shell::clock(d.now.as_str()).to_string()).unwrap_or_default();
                if stale > 0 {
                    (t.warning, format!("live · {stale} source{} stale · as of {as_of}", if stale == 1 { "" } else { "s" }))
                } else {
                    (t.success, format!("live · as of {as_of}"))
                }
            }
            Phase::NotLive => (t.warning, "not live".into()),
            Phase::Skeleton | Phase::Closed => (t.faint, "syncing".into()),
        };
        let _ = now;
        div()
            .h(px(metric::BAR))
            .flex_none()
            .px_4()
            .flex()
            .items_center()
            .justify_between()
            .gap_3()
            .border_b_1()
            .border_color(t.hairline)
            .child(title)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(ui::dot(dot))
                    .child(words)
                    .child(div().pl_2().child(ui::kbd(t, ui::shortcut(".")))),
            )
    }

    pub(crate) fn status_send(&mut self, out: Out) {
        if self.bench.is_some() {
            crate::fake::status_answer(&mut self.state, out);
        } else {
            self.send(out);
        }
    }

    /// Opens the view on `scope`, remembering where ⌘. goes back to.
    pub(crate) fn open_status(&mut self, scope: StatusScope, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        self.status_ui.resume = Some(scope.clone());
        if self.screen != Screen::Status {
            self.status_ui.before = Some(self.screen);
            self.go(Screen::Status);
        }
        let out = self.state.status_open(scope);
        self.status_send(out);
        self.update_live(false, cx);
        cx.notify();
    }

    /// Every screen change goes through here, so leaving Status always stops its wait and records the look, and
    /// coming back always reopens it.
    pub(crate) fn set_screen(&mut self, to: Screen) {
        let open = self.state.status.scope.clone();
        let tr = transition(self.screen, to, open.as_ref(), self.status_ui.resume.as_ref());
        if tr.leave {
            self.leave_status();
        }
        self.screen = to;
        if let Some(scope) = tr.reopen {
            let out = self.state.status_open(scope);
            self.status_send(out);
        }
        self.status_seen_tick();
    }

    /// Tracks whether the view is being looked at (on screen, window focused).
    pub(crate) fn status_seen_tick(&mut self) {
        let visible = self.screen == crate::shell::Screen::Status && self.window_is_active();
        self.status_ui.looked.set(visible, Instant::now());
    }

    /// The view leaves: record the look if it counted, and stop the wait loop.
    fn leave_status(&mut self) {
        if self.state.status.scope.is_some() {
            self.status_ui.resume = self.state.status.scope.clone();
        }
        let looked = self.status_ui.looked.take(Instant::now());
        let out = self.state.status_close(looked);
        if self.bench.is_none() {
            self.send(out);
        }
        self.status_ui.ages = None;
        self.status_ui.ages_due = None;
    }

    /// One timer, to the next moment an age on screen would read differently. Nothing ticks otherwise.
    fn schedule_ages(&mut self, doc: &StatusDoc, now: i64, cx: &mut Context<Self>) {
        let mut ages: Vec<i64> = doc.stale.iter().filter_map(|s| ms(s.since.as_str())).map(|t| now - t).collect();
        ages.extend(
            doc.health
                .machines
                .iter()
                .filter(|m| m.status != MachineStatus::Online)
                .filter_map(|m| m.last_seen_at.as_ref().and_then(|t| ms(t.as_str())))
                .map(|t| now - t),
        );
        ages.extend(doc.health.ci.iter().filter_map(|c| c.as_of.as_ref().and_then(|t| ms(t.as_str()))).map(|t| now - t));
        let Some(wait) = next_change(ages) else { return };
        let due = now + wait;
        if self.status_ui.ages_due == Some(due) {
            return;
        }
        self.status_ui.ages_due = Some(due);
        self.status_ui.ages = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(wait as u64 + 50)).await;
            this.update(cx, |this, cx| {
                this.status_ui.ages_due = None;
                cx.notify();
            })
            .ok();
        }));
    }
}

/// The view's reading width: wide enough for a row with its activity and ETA, narrow enough to scan.
pub const STATUS_MEASURE: f32 = 1040.;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Incoming;
    use fleetd_contracts::app::{AppCallId, AppClientMessage, AppServerMessage};

    fn live() -> State {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        s
    }

    fn tool(m: &AppClientMessage) -> (String, String, serde_json::Value) {
        match m {
            AppClientMessage::Call { id, tool, input } => (id.to_string(), tool.to_string(), input.clone()),
            _ => panic!("not a call"),
        }
    }

    fn answer(s: &mut State, id: &str, output: serde_json::Value) -> Out {
        s.apply(Incoming::Message(AppServerMessage::Result { id: AppCallId::new(id).unwrap(), output }))
    }

    fn doc(version: u64, pct: i64) -> serde_json::Value {
        let mut d = serde_json::to_value(fixture::doc(&StatusScope::Fleet, fixture::Variant::Live)).unwrap();
        d["version"] = version.into();
        d["progress"]["pct"] = pct.into();
        d
    }

    #[test]
    fn open_gets_then_waits_after_each_version_and_never_polls() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        let (id, name, _) = tool(&out[0]);
        assert_eq!(name, "status_get");
        assert_eq!(s.status.phase(), Phase::Skeleton);
        let out = answer(&mut s, &id, serde_json::json!({ "doc": doc(4, 72) }));
        assert_eq!(s.status.phase(), Phase::Live);
        let (id, name, input) = tool(&out[0]);
        assert_eq!((name.as_str(), input["after"].as_u64()), ("status_wait", Some(4)));
        // Nothing new within the timeout: wait again from the same version.
        let out = answer(&mut s, &id, serde_json::json!({ "unchanged": true, "version": 4 }));
        let (id, _, input) = tool(&out[0]);
        assert_eq!(input["after"].as_u64(), Some(4));
        let out = answer(&mut s, &id, serde_json::json!({ "doc": doc(5, 74), "version": 5 }));
        assert_eq!(s.status.doc.as_ref().unwrap().progress.pct.get(), 74);
        assert_eq!(tool(&out[0]).2["after"].as_u64(), Some(5));
    }

    #[test]
    fn a_reconnect_greys_then_shows_a_skeleton_until_the_hub_answers() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        answer(&mut s, &tool(&out[0]).0, serde_json::json!({ "doc": doc(4, 72) }));
        let session = s.status.session;
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: Duration::from_secs(1) });
        assert_eq!(s.status.phase(), Phase::NotLive, "the last doc stays, marked not live");
        let out = s.apply(Incoming::Ready);
        assert_eq!(s.status.phase(), Phase::Skeleton, "never the cached doc as if live");
        assert!(s.status.session > session);
        let get = out.iter().map(tool_name).find(|n| n == "status_get");
        assert!(get.is_some());
    }

    fn tool_name(m: &AppClientMessage) -> String {
        match m {
            AppClientMessage::Call { tool, .. } => tool.to_string(),
            _ => String::new(),
        }
    }

    #[test]
    fn answers_for_a_closed_or_reaimed_view_are_dropped() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        let old = tool(&out[0]).0;
        s.status_open(order_scope("W14"));
        assert!(answer(&mut s, &old, serde_json::json!({ "doc": doc(4, 72) })).is_empty());
        assert_eq!(s.status.phase(), Phase::Skeleton);
    }

    #[test]
    fn a_failed_wait_stops_being_live_and_retry_asks_again() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        let out = answer(&mut s, &tool(&out[0]).0, serde_json::json!({ "doc": doc(4, 72) }));
        let id = tool(&out[0]).0;
        s.apply(Incoming::Message(AppServerMessage::Error(fleetd_contracts::app::AppError {
            id: Some(AppCallId::new(&id).unwrap()),
            code: fleetd_contracts::mcp::ErrorCode::Failed,
            message: "boom".into(),
            fix: None,
        })));
        assert_eq!(s.status.phase(), Phase::NotLive);
        assert!(s.status.error.is_some());
        let out = s.status_retry();
        assert_eq!(tool_name(&out[0]), "status_get");
    }

    #[test]
    fn leaving_records_the_mark_only_after_a_real_look() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        answer(&mut s, &tool(&out[0]).0, serde_json::json!({ "doc": doc(4, 72) }));
        let seq = s.status.doc.as_ref().unwrap().seq.0.get() as u64;
        let out = s.status_close(true);
        let (_, name, input) = tool(&out[0]);
        assert_eq!((name.as_str(), input["seq"].as_u64()), ("status_seen", Some(seq)));
        let out = s.status_open(StatusScope::Fleet);
        answer(&mut s, &tool(&out[0]).0, serde_json::json!({ "doc": doc(4, 72) }));
        assert!(s.status_close(false).is_empty());
        assert_eq!(s.status.phase(), Phase::Closed);
    }

    #[test]
    fn a_look_counts_after_three_focused_seconds_in_total() {
        let t0 = Instant::now();
        let mut l = Looked::default();
        l.set(true, t0);
        l.set(false, t0 + Duration::from_secs(2));
        l.set(true, t0 + Duration::from_secs(10));
        assert!(!Looked { since: l.since, total: l.total }.take(t0 + Duration::from_millis(10_500)));
        assert!(l.take(t0 + Duration::from_secs(11)));
        assert!(!l.take(t0 + Duration::from_secs(60)), "taking resets it");
    }

    #[test]
    fn ages_redraw_only_when_their_text_changes() {
        assert_eq!(age(59_000), "<1m");
        assert_eq!(age(4 * 60_000 + 5_000), "4m");
        assert_eq!(age(3 * 3_600_000), "3h");
        assert_eq!(next_change([59_000, 4 * 60_000 + 5_000]), Some(1_000));
        assert_eq!(next_change([3_600_000 + 60_000]), Some(3_540_000));
        assert_eq!(next_change(Vec::new()), None);
    }

    #[test]
    fn the_digest_says_the_figure_what_changed_and_when_it_is_not_live() {
        let (title, body) = digest_text(&fixture::doc(&StatusScope::Fleet, fixture::Variant::Live));
        assert_eq!(title, "fleetd · 72%");
        // buildbox is offline (a stale source) and the hub's line doesn't say so: the digest does.
        assert!(body.starts_with("Not live: machine:buildbox, usage:buildbox stale. Fixing cart rounding"), "{body}");
        assert!(body.ends_with("Since you looked: 7 merged, 3 verified, 2 started, 1 failed. 3 need you."), "{body}");
        let mut stale = fixture::doc(&StatusScope::Fleet, fixture::Variant::Stale);
        let (_, body) = digest_text(&stale);
        assert!(body.starts_with("Not live: GitHub unchecked") && body.matches("Not live").count() == 1, "the hub's own clause, once: {body}");
        stale.headline.text = fleetd_contracts::prim::Line::unchecked("Nothing running.");
        let (_, body) = digest_text(&stale);
        assert!(body.starts_with("Not live: machine:buildbox, usage:buildbox, github:acme/storefront stale. Nothing running."), "{body}");
    }

    #[test]
    fn leaving_stops_the_view_and_coming_back_reopens_it() {
        let fleet = StatusScope::Fleet;
        let w14 = order_scope("W14");
        // Status → an order (⌘. back, a row click, ⌘1): leave.
        assert_eq!(transition(Screen::Status, Screen::Order, Some(&w14), None), Transition { leave: true, reopen: None });
        // Back from Settings: reopen what it showed.
        assert_eq!(transition(Screen::Settings, Screen::Status, None, Some(&w14)), Transition { leave: false, reopen: Some(w14.clone()) });
        // Opening fresh: the scope open_status set.
        assert_eq!(transition(Screen::Board, Screen::Status, None, Some(&fleet)), Transition { leave: false, reopen: Some(fleet.clone()) });
        // Status to Status, already open: nothing.
        assert_eq!(transition(Screen::Status, Screen::Status, Some(&fleet), Some(&fleet)), Transition { leave: false, reopen: None });
        // Elsewhere to elsewhere: nothing.
        assert_eq!(transition(Screen::Board, Screen::Machines, None, Some(&fleet)), Transition { leave: false, reopen: None });
    }

    #[test]
    fn a_wait_past_its_deadline_is_not_live_and_asks_again() {
        let mut s = live();
        let out = s.status_open(StatusScope::Fleet);
        answer(&mut s, &tool(&out[0]).0, serde_json::json!({ "doc": doc(4, 72) }));
        let deadline = s.status.wait_deadline.expect("a wait is out with a deadline");
        assert!(deadline - now_ms() <= WAIT_SEC as i64 * 1000 + WAIT_GRACE_MS);
        // The shell redraws on the 3 s tick only when the phase changed: not before the deadline, once after it.
        assert!(s.status_check_deadline(deadline - 1).is_empty());
        assert_eq!(s.status.phase(), Phase::Live);
        let out = s.status_check_deadline(deadline + 1);
        assert_eq!(s.status.phase(), Phase::NotLive);
        assert!(s.status.error.as_deref().unwrap().contains("hasn't answered"));
        assert_eq!(tool_name(&out[0]), "status_get");
        assert_eq!(s.status.wait_deadline, None);
        assert!(s.status_check_deadline(deadline + 60_000).is_empty(), "one miss, one resync");
    }

    #[test]
    fn times_say_the_day_only_when_it_is_not_today() {
        let now = ms("2026-10-18T10:07:12.000Z").unwrap();
        assert_eq!(when("2026-10-18T14:00:00.000Z", now), "14:00");
        assert_eq!(when("2026-10-22T14:00:00.000Z", now), "Thu 14:00");
        assert_eq!(when("2026-11-30T09:00:00.000Z", now), "Nov 30 09:00");
        assert_eq!(span(6 * 3_600_000 + 20 * 60_000), "6h 20m");
        assert_eq!(span(14 * 3_600_000), "14h");
    }
}
