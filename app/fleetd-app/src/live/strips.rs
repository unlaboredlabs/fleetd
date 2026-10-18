//! The two strips at the bottom of the window. The machine strip: each machine's running agents, load, memory
//! and claude usage windows (only what it reports), then the global slot board. The train strip: each repo's
//! merge train as chips in train order; a chip that changes slot slides to it, a merged one leaves after 10 s.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::live::{MachineLive, PrChip, TrainLive};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::node_link::LoginLimit;
use fleetd_contracts::tasks::SlotState;
use fleetd_contracts::train::ChangeState;
use gpui::{
    Animation, AnimationExt, Context, Div, EventEmitter, Hsla, IntoElement, Render, SharedString, Task, Window, div, ease_out_quint, prelude::*, px,
    quadratic,
};

use super::chips::{pr_track, stage_tone, stage_word, tone_color};
use super::lanes::LaneEvent;
use super::motion::{self, dur};
use super::state::parse_ms;
use crate::theme::{Theme, metric, size, theme};
use crate::ui;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Quiet,
    Warning,
    Danger,
}

/// One machine's strip text as segments: "6 running", "slept 10m46s" (for an hour after it woke), "load 3.1/32",
/// "mem 41%", "claude 58% 5h · 41% wk"; an offline machine is a single "offline 12 m".
pub fn machine_parts(m: &MachineLive, now_ms: i64) -> Vec<(String, Tone)> {
    if m.status == MachineStatus::Offline {
        let since = parse_ms(m.as_of.as_str()).map(|t| format!(" {}", fmt_ago(now_ms - t))).unwrap_or_default();
        return vec![(format!("offline{since}"), Tone::Warning)];
    }
    let mut out = vec![(format!("{} running", m.running), Tone::Quiet)];
    if m.status == MachineStatus::Degraded {
        out.insert(0, ("degraded".into(), Tone::Warning));
    }
    if let Some(slept) = m.slept.and_then(|s| s.recent_text(now_ms)) {
        out.push((slept, Tone::Warning));
    }
    if let Some(load) = &m.load {
        out.push((format!("load {:.1}/{}", load.load1.get(), load.cpus.get()), Tone::Quiet));
        if let Some(mem) = load.mem_used_pct {
            out.push((format!("mem {}%", mem.get()), Tone::Quiet));
        }
        let limits: Vec<(String, Tone)> = load.limits.iter().filter_map(limit_part).collect();
        if !limits.is_empty() {
            let worst = limits.iter().map(|(_, tone)| *tone).max_by_key(|t| *t as u8).unwrap_or(Tone::Quiet);
            let text = limits.into_iter().map(|(s, _)| s).collect::<Vec<_>>().join(" · ");
            out.push((format!("claude {text}"), worst));
        }
    }
    out
}

fn limit_part(l: &LoginLimit) -> Option<(String, Tone)> {
    let pct = (l.utilization?.get() * 100.).round();
    let window = match l.limit_type.as_str() {
        "five_hour" => "5h",
        "seven_day" => "wk",
        "seven_day_opus" => "opus wk",
        "seven_day_sonnet" => "sonnet wk",
        other => other,
    };
    let tone = match l.status.as_str() {
        "rejected" => Tone::Danger,
        "allowed_warning" => Tone::Warning,
        _ => Tone::Quiet,
    };
    Some((format!("{pct}% {window}"), tone))
}

/// "slots 8/40 · 1 queued".
pub fn slots_text(s: &SlotState) -> String {
    let queued = if s.queued.get() > 0 { format!(" · {} queued", s.queued) } else { String::new() };
    format!("slots {}/{}{queued}", s.used, s.cap)
}

fn fmt_ago(ms: i64) -> String {
    let m = ms.max(0) / 60_000;
    match m {
        0 => "now".into(),
        1..60 => format!("{m} m"),
        60..1440 => format!("{} h", m / 60),
        _ => format!("{} d", m / 1440),
    }
}

fn tone_of(t: &Theme, tone: Tone) -> Hsla {
    match tone {
        Tone::Quiet => t.quiet,
        Tone::Warning => t.warning,
        Tone::Danger => t.danger,
    }
}

fn strip(t: &Theme) -> Div {
    div()
        .h(px(metric::ROW))
        .flex_none()
        .w_full()
        .px_4()
        .flex()
        .items_center()
        .gap_4()
        .overflow_hidden()
        .whitespace_nowrap()
        .bg(t.sidebar)
        .border_t_1()
        .border_color(t.hairline)
        .text_size(px(size::XS))
        .text_color(t.quiet)
}

/// The machine strip. Shows nothing it wasn't told: no load row for a machine that reports none, no usage
/// windows for a login that sends none.
pub fn machine_strip(t: &Theme, machines: &[MachineLive], slots: Option<&SlotState>) -> Div {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let row = strip(t).children(machines.iter().map(|m| {
        let dot = match m.status {
            MachineStatus::Online => t.success,
            MachineStatus::Degraded | MachineStatus::Offline => t.warning,
        };
        let parts = machine_parts(m, now);
        let mut seg = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_1p5()
            .child(div().text_color(t.text).child(SharedString::from(m.name.to_string())))
            .child(ui::dot(dot));
        for (i, (text, tone)) in parts.into_iter().enumerate() {
            if i > 0 {
                seg = seg.child("·");
            }
            seg = seg.child(div().text_color(tone_of(t, tone)).child(text));
        }
        seg
    }));
    row.child(div().flex_1()).when_some(slots, |d, s| d.child(div().flex_none().font_family(t.mono_font.clone()).child(slots_text(s))))
}

/// A train chip's slot: wide enough for "#1234 ▬▬▬ needs rebase ▸".
const SLOT: f32 = 168.;

struct Shown {
    chip: PrChip,
    /// Merged: fading out.
    leaving: bool,
}

/// The train strip. Remembers each chip's slot so a chip that moves slides there, and when each was first seen
/// merged so it can leave 10 s later.
#[derive(Default)]
pub struct TrainStrip {
    trains: Vec<TrainLive>,
    primed: bool,
    slot_of: HashMap<String, usize>,
    moved_from: HashMap<String, usize>,
    entered: Vec<String>,
    merged_at: HashMap<String, Instant>,
    wake: Option<Task<()>>,
}

impl EventEmitter<LaneEvent> for TrainStrip {}

impl TrainStrip {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, trains: Vec<TrainLive>, cx: &mut Context<Self>) {
        let now = Instant::now();
        let long_ago = now.checked_sub(dur::MERGED_HOLD + dur::EXIT).unwrap_or(now);
        for chip in trains.iter().flat_map(|t| t.chips.iter()).filter(|c| c.state == ChangeState::Merged) {
            // Merges already there when the strip first loads are old news: "merged today" counts them.
            let at = if self.primed { now } else { long_ago };
            self.merged_at.entry(chip.change_id.to_string()).or_insert(at);
        }
        self.trains = trains;
        self.relayout(now);
        self.schedule(cx);
        cx.notify();
    }

    /// Recomputes slots and which chips moved or arrived since the last layout.
    fn relayout(&mut self, now: Instant) {
        let mut slot_of = HashMap::new();
        self.moved_from.clear();
        self.entered.clear();
        let rows: Vec<Vec<String>> =
            self.trains.iter().map(|tr| self.visible(tr, now).iter().map(|s| s.chip.change_id.to_string()).collect()).collect();
        for ids in rows {
            for (i, id) in ids.into_iter().enumerate() {
                match self.slot_of.get(&id) {
                    Some(&prev) if prev != i => {
                        self.moved_from.insert(id.clone(), prev);
                    }
                    None if self.primed => self.entered.push(id.clone()),
                    _ => {}
                }
                slot_of.insert(id, i);
            }
        }
        self.slot_of = slot_of;
        self.primed = true;
    }

    fn visible(&self, train: &TrainLive, now: Instant) -> Vec<Shown> {
        train
            .chips
            .iter()
            .filter_map(|c| match self.merged_at.get(c.change_id.as_str()) {
                Some(&at) if c.state == ChangeState::Merged => {
                    let age = now.duration_since(at);
                    (age < dur::MERGED_HOLD + dur::EXIT).then(|| Shown { chip: c.clone(), leaving: age >= dur::MERGED_HOLD })
                }
                _ => Some(Shown { chip: c.clone(), leaving: false }),
            })
            .collect()
    }

    /// One timer, for the next merged chip to start or finish leaving; nothing runs when nothing is due.
    fn schedule(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let next = self.merged_at.values().flat_map(|&at| [at + dur::MERGED_HOLD, at + dur::MERGED_HOLD + dur::EXIT]).filter(|&due| due > now).min();
        self.wake = next.map(|due| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(due - Instant::now() + Duration::from_millis(5)).await;
                this.update(cx, |this, cx| {
                    let now = Instant::now();
                    this.merged_at.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3600));
                    this.relayout(now);
                    this.schedule(cx);
                    cx.notify();
                })
                .ok();
            })
        });
    }

    fn chip_el(&self, t: &Theme, shown: &Shown, last: bool, cx: &mut Context<Self>) -> gpui::AnyElement {
        let c = &shown.chip;
        let id = c.change_id.to_string();
        let tone = tone_color(t, stage_tone(c.state));
        let url = c.url.clone();
        let hover = t.hover;
        let body = div()
            .id(SharedString::from(format!("chip-{id}")))
            .h(px(metric::ROW))
            .w(px(SLOT))
            .flex()
            .items_center()
            .gap_1()
            .cursor_pointer()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap_1()
                    .px_1()
                    .rounded(px(crate::theme::radius::SM))
                    .hover(move |s| s.bg(hover))
                    .child(
                        div()
                            .font_family(t.mono_font.clone())
                            .text_size(px(size::SM))
                            .text_color(t.text)
                            .child(SharedString::from(format!("#{}", c.number))),
                    )
                    .child(div().px_1().self_center().child(pr_track(t, &id, c.state, 0.)))
                    .child(div().text_color(tone).child(stage_word(c.state))),
            )
            .when(!last, |d| d.child(div().text_color(t.faint).child("▸")))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(LaneEvent::OpenPr(url.clone()))));
        let slot = self.slot_of.get(&id).copied().unwrap_or(0);
        let to = px(SLOT * slot as f32);
        if shown.leaving {
            return div()
                .absolute()
                .top_0()
                .left(to)
                .child(body)
                .with_animation(SharedString::from(format!("chip-out-{id}")), Animation::new(dur::EXIT).with_easing(quadratic), |d, p| {
                    d.opacity(1. - p)
                })
                .into_any_element();
        }
        if let Some(&from) = self.moved_from.get(&id) {
            return motion::slide_x(SharedString::from(format!("chip-{id}-at-{slot}")), body, px(SLOT * from as f32), to);
        }
        if self.entered.contains(&id) {
            return div()
                .absolute()
                .top_0()
                .left(to)
                .child(body)
                .with_animation(SharedString::from(format!("chip-in-{id}")), Animation::new(dur::ENTER).with_easing(ease_out_quint()), |d, p| {
                    d.opacity(p)
                })
                .into_any_element();
        }
        div().absolute().top_0().left(to).child(body).into_any_element()
    }
}

impl Render for TrainStrip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx).clone();
        let now = Instant::now();
        let rows: Vec<Div> = self
            .trains
            .iter()
            .filter_map(|train| {
                let shown = self.visible(train, now);
                if shown.is_empty() && !train.frozen {
                    return None;
                }
                let n = shown.len();
                let chips: Vec<gpui::AnyElement> = shown.iter().enumerate().map(|(i, s)| self.chip_el(&t, s, i + 1 == n, cx)).collect();
                let merged = train.merged_today.get();
                Some(
                    strip(&t)
                        .child(div().flex_none().child("train"))
                        .child(
                            div()
                                .flex_none()
                                .font_family(t.mono_font.clone())
                                .text_size(px(size::SM))
                                .text_color(t.text)
                                .child(SharedString::from(train.repo.to_string())),
                        )
                        .when(train.frozen, |d| {
                            let why =
                                train.frozen_reason.as_deref().filter(|r| !r.is_empty()).map_or("frozen".to_string(), |r| format!("frozen: {r}"));
                            d.child(div().flex_none().text_color(t.warning).child(why))
                        })
                        .child(div().relative().flex_1().min_w_0().h_full().overflow_hidden().children(chips))
                        .when(merged > 0, |d| d.child(div().flex_none().child(format!("merged today {merged}")))),
                )
            })
            .collect();
        div().flex().flex_col().w_full().children(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(json: serde_json::Value) -> MachineLive {
        serde_json::from_value(json).unwrap()
    }

    fn texts(parts: Vec<(String, Tone)>) -> Vec<String> {
        parts.into_iter().map(|(s, _)| s).collect()
    }

    #[test]
    fn a_machine_says_only_what_it_reports() {
        let now = parse_ms("2026-10-18T10:07:12Z").unwrap();
        let build = machine(serde_json::json!({
            "machineId": "devbox", "name": "devbox", "status": "online", "running": 6, "asOf": "2026-10-18T10:07:00Z",
            "load": {"cpus": 32, "load1": 3.06, "memUsedPct": 41, "limits": [
                {"limitType": "five_hour", "utilization": 0.58, "status": "allowed"},
                {"limitType": "seven_day", "utilization": 0.41, "status": "allowed_warning"},
                {"limitType": "seven_day_opus", "status": "allowed"}
            ]}
        }));
        let parts = machine_parts(&build, now);
        assert_eq!(parts.last().unwrap().1, Tone::Warning);
        assert_eq!(texts(parts), ["6 running", "load 3.1/32", "mem 41%", "claude 58% 5h · 41% wk"]);
        let bare =
            machine(serde_json::json!({"machineId": "lab-a", "name": "lab-a", "status": "online", "running": 0, "asOf": "2026-10-18T10:07:00Z"}));
        assert_eq!(texts(machine_parts(&bare, now)), ["0 running"]);
        let woke = now - 2 * 60_000;
        let napped = machine(serde_json::json!({"machineId": "lab-a", "name": "lab-a", "status": "online", "running": 2,
            "asOf": "2026-10-18T10:07:00Z", "slept": {"fromMs": woke - 646_000, "toMs": woke}}));
        assert_eq!(texts(machine_parts(&napped, now)), ["2 running", "slept 10m46s"]);
        assert_eq!(texts(machine_parts(&napped, woke + 3_600_000)), ["2 running"]);
        let off =
            machine(serde_json::json!({"machineId": "lab-b", "name": "lab-b", "status": "offline", "running": 0, "asOf": "2026-10-18T09:55:00Z"}));
        assert_eq!(machine_parts(&off, now), vec![("offline 12 m".to_string(), Tone::Warning)]);
    }

    #[test]
    fn slots_mention_the_queue_only_when_there_is_one() {
        let s = |q: i64| -> SlotState {
            serde_json::from_value(serde_json::json!({"cap": 40, "used": 8, "queued": q, "reservedBand": 2, "perProject": []})).unwrap()
        };
        assert_eq!(slots_text(&s(0)), "slots 8/40");
        assert_eq!(slots_text(&s(3)), "slots 8/40 · 3 queued");
    }
}
