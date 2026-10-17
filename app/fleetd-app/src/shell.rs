use std::time::{Duration, Instant};

use gpui::{
    Context, Div, FocusHandle, KeyDownEvent, Keystroke, Rgba, ScrollDelta, ScrollStrategy,
    ScrollWheelEvent, SharedString, UniformListScrollHandle, Window, div, point, prelude::*, px,
    rgb, uniform_list,
};

use crate::bench::{self, Mode, Probe};
use crate::diff::{self, DiffKind, DiffLine};
use crate::fake::{self, LogKind, LogStream, Row, ThreadState};

const UI_FONT: &str = "IBM Plex Sans";
const MONO_FONT: &str = "Lilex";
const ROW_H: f32 = 22.;
const LINE_H: f32 = 18.;
const LINES_PER_SEC: u64 = 50;
const SCROLL_PX_PER_SEC: f32 = 2400.;

struct Theme;
impl Theme {
    const BG: u32 = 0x1b1c1f;
    const PANEL: u32 = 0x222327;
    const BORDER: u32 = 0x33353a;
    const TEXT: u32 = 0xd6d7da;
    const MUTED: u32 = 0x7d8089;
    const ACCENT: u32 = 0x6ea8fe;
    const GREEN: u32 = 0x7cc47f;
    const RED: u32 = 0xe5737a;
    const YELLOW: u32 = 0xd9b45c;
    const ADD_BG: u32 = 0x1f3324;
    const DEL_BG: u32 = 0x3a2024;
    const HUNK_BG: u32 = 0x23293a;
}

struct LogRow {
    kind: LogKind,
    text: SharedString,
}

pub struct Shell {
    rows: Vec<Row>,
    selected: usize,
    log: Vec<LogRow>,
    log_scroll: UniformListScrollHandle,
    follow: bool,
    stream: LogStream,
    diff: Vec<DiffLine>,
    input: String,
    focus: FocusHandle,
    probe: Option<Probe>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mode = Mode::from_env();
        let history: usize = env_num("FLEETD_HISTORY", 20_000);
        let mut stream = LogStream::new(1);
        let log = (0..history).map(|_| to_row(stream.next_line())).collect();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);

        if env_num("FLEETD_STREAM", 1) == 1 {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(1000 / LINES_PER_SEC)).await;
                    if this.update(cx, |this, cx| this.append(cx)).is_err() {
                        return;
                    }
                }
            })
            .detach();
        }
        if let Some(mode) = mode {
            spawn_bench(mode, window, cx);
        }

        let log_scroll = UniformListScrollHandle::new();
        log_scroll.scroll_to_bottom();
        Self {
            rows: fake::project_rows(),
            selected: 1,
            log,
            log_scroll,
            follow: true,
            stream,
            diff: diff::parse_unified(&fake::diff_text()),
            input: String::new(),
            focus,
            probe: mode.map(|_| Probe::new()),
        }
    }

    fn append(&mut self, cx: &mut Context<Self>) {
        let line = to_row(self.stream.next_line());
        self.push(line, cx);
    }

    fn push(&mut self, line: LogRow, cx: &mut Context<Self>) {
        self.log.push(line);
        if self.follow {
            self.log_scroll.scroll_to_item(self.log.len() - 1, ScrollStrategy::Bottom);
        }
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        if let Some(probe) = &mut self.probe {
            probe.key_received(Instant::now(), &ks.key);
        }
        if ks.modifiers.control || ks.modifiers.platform || ks.modifiers.alt {
            return;
        }
        match ks.key.as_str() {
            "backspace" => {
                self.input.pop();
            }
            "enter" => {
                if !self.input.is_empty() {
                    let text = format!("› you: {}", std::mem::take(&mut self.input));
                    self.follow = true;
                    self.push(LogRow { kind: LogKind::User, text: text.into() }, cx);
                }
            }
            _ => match &ks.key_char {
                Some(ch) if !ch.chars().any(char::is_control) => self.input.push_str(ch),
                _ => return,
            },
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn on_log_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, _: &mut Context<Self>) {
        let up = match event.delta {
            ScrollDelta::Pixels(p) => p.y > px(0.),
            ScrollDelta::Lines(l) => l.y > 0.,
        };
        if up {
            self.follow = false;
        }
    }

    fn project_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        pane(px(280.)).font_family(UI_FONT).child(header("Projects", format!("{}", self.rows.len()))).child(
            uniform_list(
                "projects",
                self.rows.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                    range
                        .map(|ix| {
                            let selected = ix == this.selected;
                            let row = div()
                                .id(ix)
                                .h(px(ROW_H))
                                .px_2()
                                .flex()
                                .items_center()
                                .gap_2()
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .when(selected, |d| d.bg(rgb(0x2d3a52)))
                                .hover(|d| d.bg(rgb(0x2a2c31)))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.selected = ix;
                                    cx.notify();
                                }));
                            match &this.rows[ix] {
                                Row::Project { name, machine, fleet } => row
                                    .text_color(rgb(Theme::TEXT))
                                    .child(div().flex_1().child(name.clone()))
                                    .child(muted(format!("{machine} · {fleet}"))),
                                Row::Thread { title, state, age } => row
                                    .pl_5()
                                    .text_color(rgb(Theme::MUTED))
                                    .child(div().text_color(rgb(state_color(*state))).child("●"))
                                    .child(div().flex_1().overflow_hidden().child(title.clone()))
                                    .child(muted(age.clone())),
                            }
                        })
                        .collect::<Vec<_>>()
                }),
            )
            .flex_1(),
        )
    }

    fn log_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.drive_scroll_bench(window);
        if !self.follow && self.scroll_bench_idle() && self.log_scroll.is_scrolled_to_end() == Some(true) {
            self.follow = true;
        }
        let status = if self.follow { "following" } else { "paused" };
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .bg(rgb(Theme::BG))
            .child(header("lead · fleetd", format!("{} lines · {status}", self.log.len())))
            .child(
                uniform_list(
                    "log",
                    self.log.len(),
                    cx.processor(|this, range: std::ops::Range<usize>, _, _| {
                        range
                            .map(|ix| {
                                let line = &this.log[ix];
                                text_row().text_color(rgb(log_color(line.kind))).child(line.text.clone())
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.log_scroll)
                .on_scroll_wheel(cx.listener(Self::on_log_wheel))
                .flex_1()
                .font_family(MONO_FONT)
                .text_size(px(12.5)),
            )
    }

    fn diff_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        pane(px(620.)).child(header("train.ts and 3 more", format!("{} lines", self.diff.len()))).child(
            uniform_list(
                "diff",
                self.diff.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, _| {
                    range.map(|ix| diff_row(&this.diff[ix])).collect::<Vec<_>>()
                }),
            )
            .flex_1()
            .font_family(MONO_FONT)
            .text_size(px(12.5)),
        )
    }

    fn input_bar(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .h(px(40.))
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .border_t_1()
            .border_color(rgb(if focused { Theme::ACCENT } else { Theme::BORDER }))
            .bg(rgb(Theme::PANEL))
            .font_family(MONO_FONT)
            .text_size(px(13.))
            .child(div().text_color(rgb(Theme::ACCENT)).child("›"))
            .child(if self.input.is_empty() {
                div().text_color(rgb(Theme::MUTED)).child("Message the lead")
            } else {
                div().text_color(rgb(Theme::TEXT)).child(self.input.clone())
            })
            .child(div().w(px(7.)).h(px(16.)).bg(rgb(Theme::ACCENT)))
    }

    fn scroll_bench_idle(&self) -> bool {
        self.probe.as_ref().is_none_or(|p| p.scroll_started.is_none())
    }

    fn drive_scroll_bench(&mut self, window: &mut Window) {
        let Some(started) = self.probe.as_ref().and_then(|p| p.scroll_started) else { return };
        self.follow = false;
        let state = self.log_scroll.0.borrow();
        let max = f32::from(state.base_handle.max_offset().y).max(1.);
        let y = (started.elapsed().as_secs_f32() * SCROLL_PX_PER_SEC) % max;
        state.base_handle.set_offset(point(px(0.), px(-y)));
        window.request_animation_frame();
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(Theme::BG))
            .text_color(rgb(Theme::TEXT))
            .text_size(px(13.))
            .font_family(UI_FONT)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(self.project_pane(cx))
                    .child(self.log_pane(window, cx))
                    .child(self.diff_pane(cx)),
            )
            .child(self.input_bar(window, cx))
    }
}

fn spawn_bench(mode: Mode, window: &mut Window, cx: &mut Context<Shell>) {
    let x11_window = x11_window_id(window);
    cx.spawn_in(window, async move |this, cx| {
        let tick = Duration::from_millis(10);
        let wait = async |cx: &mut gpui::AsyncWindowContext, d: Duration| cx.background_executor().timer(d).await;
        // First present.
        loop {
            wait(cx, tick).await;
            let Ok(Some(first)) = this.update(cx, |s, _| {
                let p = s.probe.as_mut().unwrap();
                p.poll();
                p.first_present.map(|at| (p.unix_ns(at), p.first_draw.map_or(0, |d| p.unix_ns(d)), p.draws_to_first_present))
            }) else {
                continue;
            };
            let (present, draw, draws) = first;
            let x11 = x11_window.unwrap_or(0);
            this.update(cx, |s, _| {
                s.probe.as_ref().unwrap().emit(&format!("event=first_present unix_ns={present} first_draw_unix_ns={draw} draws={draws} x11_window={x11}"))
            })
            .ok();
            break;
        }
        let emit_keys = |s: &mut Shell| {
            let p = s.probe.as_mut().unwrap();
            for (key, lat) in p.poll() {
                p.emit(&format!("event=key key={key} latency_ns={}", lat.as_nanos()));
            }
        };
        match mode {
            Mode::Cold => {}
            Mode::Idle => return,
            Mode::KeysInternal => {
                wait(cx, Duration::from_secs(1)).await;
                for i in 0..bench::KEYSTROKES {
                    // Enter every 40 letters keeps the echo on screen; the driver counts letters only.
                    if i > 0 && i % 40 == 0 {
                        cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx)).ok();
                        wait(cx, Duration::from_millis(50)).await;
                    }
                    let key = ((b'a' + (i % 26) as u8) as char).to_string();
                    // Not inside an entity update: dispatch re-enters Shell's key handler.
                    cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse(&key).unwrap(), cx)).ok();
                    wait(cx, Duration::from_millis(50)).await;
                    this.update(cx, |s, _| emit_keys(s)).ok();
                }
                wait(cx, Duration::from_millis(300)).await;
                this.update(cx, |s, _| emit_keys(s)).ok();
                this.update_in(cx, |s, window, _| s.probe.as_ref().unwrap().emit(&format!("event=keys active={}", window.is_window_active()))).ok();
            }
            Mode::KeysExternal => {
                wait(cx, Duration::from_secs(1)).await;
                this.update(cx, |s, _| {
                    s.probe.as_ref().unwrap().emit(&format!("event=ready x11_window={}", x11_window.unwrap_or(0)))
                })
                .ok();
                // The driver quits us after its last key; keep resolving latencies until then.
                loop {
                    wait(cx, Duration::from_millis(20)).await;
                    if this.update(cx, |s, _| emit_keys(s)).is_err() {
                        return;
                    }
                }
            }
            Mode::Scroll => {
                wait(cx, Duration::from_secs(1)).await;
                let start = Instant::now();
                this.update(cx, |s, cx| {
                    s.probe.as_mut().unwrap().scroll_started = Some(start);
                    cx.notify();
                })
                .ok();
                wait(cx, bench::SCROLL_FOR).await;
                let end = Instant::now();
                wait(cx, Duration::from_millis(100)).await;
                this.update_in(cx, |s, window, _| {
                    let p = s.probe.as_mut().unwrap();
                    p.poll();
                    let (fps, worst) = bench::scroll_stats(&p.presents, start, end);
                    p.scroll_started = None;
                    let active = window.is_window_active();
                    p.emit(&format!("event=scroll fps={fps:.1} worst_frame_us={} active={active}", worst.as_micros()));
                })
                .ok();
            }
        }
        this.update(cx, |s, _| s.probe.as_ref().unwrap().emit("event=done")).ok();
        cx.update(|_, cx| cx.quit()).ok();
    })
    .detach();
}

fn x11_window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => Some(h.window as u32),
        _ => None,
    }
}

fn to_row(line: fake::LogLine) -> LogRow {
    LogRow { kind: line.kind, text: line.text.into() }
}

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn pane(width: gpui::Pixels) -> Div {
    div()
        .w(width)
        .flex_none()
        .flex()
        .flex_col()
        .bg(rgb(Theme::PANEL))
        .border_color(rgb(Theme::BORDER))
        .border_r_1()
}

fn header(title: &str, detail: String) -> Div {
    div()
        .h(px(32.))
        .px_3()
        .flex()
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(rgb(Theme::BORDER))
        .font_family(UI_FONT)
        .child(div().text_color(rgb(Theme::TEXT)).child(title.to_string()))
        .child(muted(detail))
}

fn muted(text: impl Into<SharedString>) -> Div {
    div().text_color(rgb(Theme::MUTED)).text_size(px(11.5)).child(text.into())
}

fn text_row() -> Div {
    div().h(px(LINE_H)).px_3().flex().items_center().whitespace_nowrap().overflow_hidden()
}

fn diff_row(line: &DiffLine) -> Div {
    let num = |n: Option<u32>| {
        div()
            .w(px(40.))
            .flex_none()
            .flex()
            .justify_end()
            .pr_2()
            .text_color(rgb(Theme::MUTED))
            .child(n.map(|n| n.to_string()).unwrap_or_default())
    };
    let (bg, fg, sign): (Option<u32>, u32, &str) = match line.kind {
        DiffKind::File => (None, Theme::TEXT, ""),
        DiffKind::Hunk => (Some(Theme::HUNK_BG), Theme::ACCENT, ""),
        DiffKind::Context => (None, Theme::MUTED, " "),
        DiffKind::Added => (Some(Theme::ADD_BG), Theme::GREEN, "+"),
        DiffKind::Removed => (Some(Theme::DEL_BG), Theme::RED, "-"),
    };
    let row = div().h(px(LINE_H)).flex().items_center().whitespace_nowrap().overflow_hidden();
    let row = match bg {
        Some(bg) => row.bg(Rgba::from(rgb(bg))),
        None => row,
    };
    row.child(num(line.old))
        .child(num(line.new))
        .child(div().text_color(rgb(fg)).child(format!("{sign}{}", line.text)))
}

fn state_color(state: ThreadState) -> u32 {
    match state {
        ThreadState::Running => Theme::ACCENT,
        ThreadState::Waiting => Theme::YELLOW,
        ThreadState::Done => Theme::GREEN,
        ThreadState::Failed => Theme::RED,
    }
}

fn log_color(kind: LogKind) -> u32 {
    match kind {
        LogKind::Tool => Theme::ACCENT,
        LogKind::Output => Theme::MUTED,
        LogKind::Thought => Theme::TEXT,
        LogKind::Ok => Theme::GREEN,
        LogKind::Error => Theme::RED,
        LogKind::User => Theme::YELLOW,
    }
}

