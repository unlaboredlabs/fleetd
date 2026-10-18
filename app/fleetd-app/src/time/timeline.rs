//! The order timeline: one row per lane (the lead, each agent, the PR, each of its CI checks, the asks), each
//! row's spans as bars on one time axis, the critical path as a line under them.
//!
//! Drawing stays inside the frame budget at any span count: rows are a virtualized list (only visible rows are
//! laid out), and within a row the spans narrower than a pixel at the current zoom merge into one bar per pixel
//! column, coloured by the category with the most time in it. A 10k-span order draws a few hundred quads.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

use fleetd_contracts::live::AgentRole;
use fleetd_contracts::time::{Category, CriticalPath, DecidedBy, Span, SpanKind, SpanStatus};
use gpui::{
    AnyElement, BorderStyle, Bounds, Context, Div, Hsla, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Window, canvas, div,
    fill, point, prelude::*, px, quad, relative, size, uniform_list,
};

use super::{
    Highlight, Hover, Names, TimeView, cat_label, cat_paint, clock_ms, fmt_bytes, fmt_dur, inexact, kind_word, lane_name, span_title, swatch,
};
use crate::live::chips::role_tag;
use crate::state::Linked;
use crate::theme::{STRONG, Theme, metric, size as tsize};
use crate::ui::{self, Variant};

const LABEL_W: f32 = 220.;
const ROW_H: f32 = 26.;
const BAR_H: f32 = 12.;
/// Off the critical path, bars drop to this.
const OFF_PATH: f32 = 0.6;
/// With a highlight on, the other bars drop to this.
const UNLIT: f32 = 0.22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Lead,
    Agent,
    Change,
    Check,
    Asks,
    Other,
}

pub struct Row {
    pub name: String,
    pub task: Option<String>,
    pub role: Option<AgentRole>,
    pub kind: RowKind,
    pub items: Range<usize>,
    /// "Bash 41m · model 22m": the row's two biggest kinds.
    pub summary: String,
    pub agent_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Item {
    /// Index into `Model::spans`.
    pub span: usize,
    pub start: i64,
    pub end: i64,
    pub cat: Category,
    pub on_path: bool,
    pub failed: bool,
}

pub struct Seg {
    pub row: Option<usize>,
    pub start: i64,
    pub end: i64,
    pub cat: Category,
    pub kind: SpanKind,
    pub label: Option<String>,
    pub span: Option<usize>,
}

/// An order's spans arranged for drawing. Built once per answer from the hub, never per frame.
pub struct Model {
    pub spans: Vec<Span>,
    pub by_id: HashMap<i64, usize>,
    pub rows: Vec<Row>,
    pub items: Vec<Item>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub path: Vec<Seg>,
    /// Calls that ran inside a `tools.parallel` group: each one's own time is an upper bound.
    pub parallel: HashSet<i64>,
    /// parent span id → its children (a message's phases, a group's calls).
    pub children: HashMap<i64, Vec<usize>>,
    pub has_path: bool,
}

fn row_key(s: &Span) -> String {
    match (s.kind, s.extra.as_ref().and_then(|e| e.check.as_ref())) {
        (SpanKind::CiCheck, Some(name)) => format!("{}#{}", s.lane, name),
        // Asks that blocked nothing overlap the blocking ones; they get their own row.
        (SpanKind::AskInfo, _) => format!("{}#info", s.lane),
        _ => s.lane.to_string(),
    }
}

impl Model {
    pub fn build(spans: &[Span], path: Option<&CriticalPath>, names: &Names, now_ms: i64) -> Self {
        let spans = spans.to_vec();
        let by_id: HashMap<i64, usize> = spans.iter().enumerate().map(|(i, s)| (s.id.get(), i)).collect();
        let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
        for (i, s) in spans.iter().enumerate() {
            if let Some(p) = s.parent {
                children.entry(p.get()).or_default().push(i);
            }
        }
        let parallel: HashSet<i64> = spans
            .iter()
            .filter(|s| s.parent.and_then(|p| by_id.get(&p.get())).is_some_and(|&p| spans[p].kind == SpanKind::ToolsParallel))
            .map(|s| s.id.get())
            .collect();
        let path_ids: HashSet<i64> = path.iter().flat_map(|p| p.segments.iter()).filter_map(|s| s.span_id.map(|i| i.get())).collect();
        // Leaves only: an envelope's time is its children's, and a group is drawn instead of its overlapping calls.
        let drawn = |s: &Span| match s.kind {
            SpanKind::Run | SpanKind::Idle => false,
            SpanKind::ModelMessage => !children.contains_key(&s.id.get()),
            _ => !parallel.contains(&s.id.get()),
        };
        let mut rows_by_key: HashMap<String, (i64, Vec<Item>, RowKind)> = HashMap::new();
        for (i, s) in spans.iter().enumerate() {
            if !drawn(s) {
                continue;
            }
            let end = s.end_ms.map_or(now_ms, |e| e.get()).max(s.start_ms.get());
            let lane = s.lane.as_str();
            let kind = if s.kind == SpanKind::CiCheck {
                RowKind::Check
            } else if lane.starts_with("change:") {
                RowKind::Change
            } else if lane.starts_with("asks:") {
                RowKind::Asks
            } else if s.thread_id.as_ref().is_some_and(|t| names.leads.contains(t.as_str())) {
                RowKind::Lead
            } else if lane.starts_with("thread:") {
                RowKind::Agent
            } else {
                RowKind::Other
            };
            let item = Item {
                span: i,
                start: s.start_ms.get(),
                end,
                cat: s.cat,
                on_path: path_ids.contains(&s.id.get()),
                failed: matches!(s.status, SpanStatus::Failed),
            };
            let e = rows_by_key.entry(row_key(s)).or_insert((i64::MAX, Vec::new(), kind));
            e.0 = e.0.min(item.start);
            e.1.push(item);
        }
        // Lead, agents by start, then each PR with its checks under it, then the asks and the rest.
        let mut keys: Vec<(String, i64, RowKind)> = rows_by_key.iter().map(|(k, (first, _, kind))| (k.clone(), *first, *kind)).collect();
        let rank = |k: &str, kind: RowKind| match kind {
            RowKind::Lead => (0, String::new()),
            RowKind::Agent => (1, String::new()),
            RowKind::Change | RowKind::Check => (2, k.split('#').next().unwrap_or(k).to_string()),
            RowKind::Asks => (3, k.to_string()),
            RowKind::Other => (4, String::new()),
        };
        keys.sort_by(|a, b| {
            let (ra, rb) = (rank(&a.0, a.2), rank(&b.0, b.2));
            ra.cmp(&rb).then((a.2 == RowKind::Check).cmp(&(b.2 == RowKind::Check))).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0))
        });
        let mut rows = Vec::new();
        let mut items = Vec::new();
        for (key, _, kind) in keys {
            let (_, mut list, _) = rows_by_key.remove(&key).unwrap();
            list.sort_by_key(|it| (it.start, it.end));
            let first = &spans[list[0].span];
            let mut totals: HashMap<&'static str, i64> = HashMap::new();
            let mut agent_ms = 0;
            for it in &list {
                let s = &spans[it.span];
                let ms = s.excl_ms.map_or(it.end - it.start, |e| e.get());
                agent_ms += ms;
                let word = match s.cat {
                    Category::Model => "model",
                    _ => kind_word(s.kind),
                };
                *totals.entry(word).or_default() += ms;
            }
            let mut top: Vec<(&str, i64)> = totals.into_iter().collect();
            top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            let summary = top.iter().take(2).map(|(w, ms)| format!("{w} {}", fmt_dur(*ms))).collect::<Vec<_>>().join(" · ");
            let thread = first.thread_id.as_ref().map(|t| t.to_string());
            let lane = thread.as_deref().and_then(|t| names.threads.get(t));
            let (name, task, role) = match kind {
                RowKind::Lead => ("lead".to_string(), None, Some(AgentRole::Lead)),
                RowKind::Agent => match lane {
                    Some((role, task, title)) => (title.clone(), task.clone(), Some(*role)),
                    None => (first.task_id.as_ref().map_or_else(|| thread.clone().unwrap_or_default(), |t| t.to_string()), None, None),
                },
                RowKind::Check => (key.split_once('#').map_or(key.clone(), |(_, n)| n.to_string()), None, None),
                RowKind::Asks if key.ends_with("#info") => ("asks that blocked nothing".to_string(), None, None),
                _ => (lane_name(names, first), None, None),
            };
            let start = items.len();
            items.extend(list);
            rows.push(Row { name, task, role, kind, items: start..items.len(), summary, agent_ms });
        }
        let row_of = |span: &Span| -> Option<usize> {
            let key = row_key(span);
            rows.iter().position(|r| {
                let first = &spans[items[r.items.start].span];
                row_key(first) == key
            })
        };
        let path_segs: Vec<Seg> = path
            .iter()
            .flat_map(|p| p.segments.iter())
            .map(|seg| {
                let span = seg.span_id.and_then(|id| by_id.get(&id.get()).copied());
                Seg {
                    row: span.and_then(|i| row_of(&spans[i])),
                    start: seg.start_ms.get(),
                    end: seg.end_ms.get(),
                    cat: seg.cat,
                    kind: seg.kind,
                    label: seg.label.as_ref().map(|l| l.to_string()),
                    span,
                }
            })
            .collect();
        let (start_ms, end_ms) = match path {
            Some(p) => (p.start_ms.get(), p.end_ms.get()),
            None => (items.iter().map(|i| i.start).min().unwrap_or(now_ms), items.iter().map(|i| i.end).max().unwrap_or(now_ms)),
        };
        Model { spans, by_id, rows, items, start_ms, end_ms: end_ms.max(start_ms + 1), has_path: path.is_some(), path: path_segs, parallel, children }
    }
}

/// One drawn bar: a span, or (`n > 1`) the spans that share one pixel column at this zoom.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bar {
    pub x0: f32,
    pub x1: f32,
    pub cat: Category,
    /// Absolute index into `Model::items` of the first item in the bar.
    pub first: usize,
    pub n: u32,
    pub start: i64,
    pub end: i64,
    pub on_path: bool,
    pub failed: bool,
    pub lit: bool,
}

/// The bars of one row's items (`items` is the row's slice, `offset` its start in `Model::items`) for the view
/// `[v0, v1)` across `width` px. Items at least a pixel wide stay one bar each; narrower ones merge per pixel
/// column into a bar coloured by the category with the most time in it.
pub fn bars(items: &[Item], offset: usize, v0: i64, v1: i64, width: f32, lit: &dyn Fn(&Item) -> bool) -> Vec<Bar> {
    let mut out = Vec::new();
    if v1 <= v0 || width <= 0. {
        return out;
    }
    let k = width as f64 / (v1 - v0) as f64;
    // Leaves tile their lane, so ends are in order too; a binary search skips what is left of the view.
    let from = items.partition_point(|it| it.end <= v0);
    let to = items.partition_point(|it| it.start < v1);
    let mut bucket: Option<(f32, [i64; 7], Bar)> = None;
    let flush = |b: &mut Option<(f32, [i64; 7], Bar)>, out: &mut Vec<Bar>| {
        if let Some((_, ms, mut bar)) = b.take() {
            if bar.n > 1 {
                let best = (0..7).max_by_key(|&c| (ms[c], std::cmp::Reverse(c))).unwrap();
                bar.cat = Category::ALL[best];
            }
            out.push(bar);
        }
    };
    for (i, it) in items.iter().enumerate().take(to.max(from)).skip(from) {
        if it.end <= v0 {
            continue;
        }
        let x0 = ((it.start.max(v0) - v0) as f64 * k) as f32;
        let x1 = ((it.end.min(v1) - v0) as f64 * k) as f32;
        let one =
            Bar { x0, x1, cat: it.cat, first: offset + i, n: 1, start: it.start, end: it.end, on_path: it.on_path, failed: it.failed, lit: lit(it) };
        if x1 - x0 >= 1. {
            flush(&mut bucket, &mut out);
            out.push(one);
            continue;
        }
        let col = x0.floor();
        match &mut bucket {
            Some((c, ms, bar)) if *c == col => {
                ms[it.cat.code() as usize] += it.end - it.start;
                bar.n += 1;
                bar.end = bar.end.max(it.end);
                bar.on_path |= it.on_path;
                bar.failed |= it.failed;
                bar.lit |= one.lit;
            }
            _ => {
                flush(&mut bucket, &mut out);
                let mut ms = [0; 7];
                ms[it.cat.code() as usize] = it.end - it.start;
                bucket = Some((col, ms, Bar { x0: col, x1: col + 1., ..one }));
            }
        }
    }
    flush(&mut bucket, &mut out);
    out
}

/// The bar under the pointer, with a few px of slack for hairline bars.
pub fn hit(bars: &[Bar], x: f32) -> Option<Bar> {
    bars.iter()
        .filter(|b| x >= b.x0 - 2. && x <= b.x1 + 2.)
        .min_by(|a, b| {
            let d = |b: &Bar| if x >= b.x0 && x <= b.x1 { 0. } else { (b.x0 - x).abs().min((b.x1 - x).abs()) };
            d(a).total_cmp(&d(b))
        })
        .copied()
}

/// Tick step and first tick for about 8 ticks across `[v0, v1)`.
pub fn ticks(v0: i64, v1: i64) -> Vec<i64> {
    const STEPS: [i64; 16] = [
        1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000,
        43_200_000, 86_400_000,
    ];
    let span = (v1 - v0).max(1);
    let step = STEPS.iter().copied().find(|s| span / s <= 8).unwrap_or(86_400_000);
    let first = v0.div_euclid(step) * step + if v0.rem_euclid(step) == 0 { 0 } else { step };
    (0..).map(|i| first + i * step).take_while(|&t| t < v1).collect()
}

fn tick_label(t: i64, v0: i64, v1: i64) -> String {
    let c = clock_ms(t);
    if v1 - v0 < 10 * 60_000 { c } else { c[..5].to_string() }
}

impl TimeView {
    fn range(&self, m: &Model) -> (i64, i64) {
        self.view.unwrap_or((m.start_ms, m.end_ms))
    }

    fn x_to_ms(&self, m: &Model, x: Pixels) -> i64 {
        let b = self.track.get();
        let (v0, v1) = self.range(m);
        let f = ((f32::from(x - b.origin.x)) / f32::from(b.size.width).max(1.)).clamp(0., 1.) as f64;
        v0 + ((v1 - v0) as f64 * f) as i64
    }

    pub(crate) fn row_bars_pub(&self, m: &Model, row: usize) -> Vec<Bar> {
        self.row_bars(m, row)
    }

    fn row_bars(&self, m: &Model, row: usize) -> Vec<Bar> {
        let r = &m.rows[row];
        let (v0, v1) = self.range(m);
        let width = f32::from(self.track.get().size.width);
        let ids = self.highlight.as_ref().map(|h| h.ids.clone());
        let lit = |it: &Item| ids.as_ref().is_some_and(|ids| ids.contains(&m.spans[it.span].id.get()));
        bars(&m.items[r.items.clone()], r.items.start, v0, v1, width, &lit)
    }

    fn on_track_move(&mut self, row: usize, e: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(m) = self.model.clone() else { return };
        if let Some(drag) = self.drag.as_mut()
            && e.dragging()
        {
            drag.1 = f32::from(e.position.x);
            cx.notify();
            return;
        }
        let x = f32::from(e.position.x - self.track.get().origin.x);
        let next = hit(&self.row_bars(&m, row), x).map(|bar| Hover::Bar { row, bar, at: e.position });
        let same = match (&self.hover, &next) {
            (Some(Hover::Bar { row: r0, bar: b0, .. }), Some(Hover::Bar { row: r1, bar: b1, .. })) => {
                r0 == r1 && b0.first == b1.first && b0.n == b1.n
            }
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.hover = next;
            cx.notify();
        }
    }

    fn on_track_down(&mut self, e: &MouseDownEvent, cx: &mut Context<Self>) {
        let x = f32::from(e.position.x);
        self.drag = Some((x, x));
        self.hover = None;
        cx.notify();
    }

    fn on_track_up(&mut self, row: usize, e: &MouseUpEvent, cx: &mut Context<Self>) {
        let Some(m) = self.model.clone() else { return };
        let Some((from, to)) = self.drag.take() else { return };
        cx.notify();
        if (to - from).abs() > 4. {
            let (a, b) = (self.x_to_ms(&m, px(from.min(to))), self.x_to_ms(&m, px(from.max(to))));
            if b - a >= 1_000 {
                self.view = Some((a, b));
            }
            return;
        }
        let x = f32::from(e.position.x - self.track.get().origin.x);
        if let Some(bar) = hit(&self.row_bars(&m, row), x) {
            self.click_bar(&m, &bar, cx);
        }
    }

    fn click_bar(&mut self, m: &Model, bar: &Bar, cx: &mut Context<Self>) {
        let pad = |a: i64, b: i64| {
            let d = ((b - a) / 4).max(2_000);
            (a - d, b + d)
        };
        if bar.n > 1 {
            self.view = Some(pad(bar.start, bar.end));
            return;
        }
        let span = m.spans[m.items[bar.first].span].clone();
        if let Some(url) = span.extra.as_ref().and_then(|e| e.url.as_ref()) {
            cx.open_url(url.as_str());
            return;
        }
        if !self.open_transcript(&span, cx) {
            self.view = Some(pad(bar.start, bar.end));
        }
    }

    fn zoom_to_row(&mut self, row: usize, cx: &mut Context<Self>) {
        let Some(m) = self.model.clone() else { return };
        let r = &m.rows[row];
        let (a, b) = (m.items[r.items.clone()].iter().map(|i| i.start).min(), m.items[r.items.clone()].iter().map(|i| i.end).max());
        if let (Some(a), Some(b)) = (a, b) {
            self.view = Some((a, b.max(a + 1_000)));
            cx.notify();
        }
    }
}

/// The paint inputs every row shares this frame.
#[derive(Clone)]
struct Paint {
    model: Rc<Model>,
    v: (i64, i64),
    ids: Option<Rc<HashSet<i64>>>,
    drag: Option<(f32, f32)>,
    ticks: Rc<Vec<i64>>,
    colors: Rc<[(Option<gpui::Background>, Option<Hsla>); 7]>,
    danger: Hsla,
    accent: Hsla,
    grid: Hsla,
    selection: Hsla,
    track: Rc<std::cell::Cell<Bounds<Pixels>>>,
    row0: Rc<std::cell::Cell<Pixels>>,
}

fn paint_row(p: &Paint, row: usize, bounds: Bounds<Pixels>, window: &mut Window) {
    p.track.set(bounds);
    if row == 0 {
        p.row0.set(bounds.origin.y);
    }
    let (v0, v1) = p.v;
    let w = f32::from(bounds.size.width);
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let h = f32::from(bounds.size.height);
    let scale = window.scale_factor();
    let snap = |v: f32| (v * scale).round() / scale;
    for &t in p.ticks.iter() {
        let x = snap(ox + ((t - v0) as f64 / (v1 - v0) as f64 * w as f64) as f32);
        window.paint_quad(fill(Bounds::new(point(px(x), px(oy)), size(px(1. / scale), px(h))), p.grid));
    }
    if let Some((a, b)) = p.drag {
        let (a, b) = (a.min(b).max(ox), a.max(b).min(ox + w));
        if b > a {
            window.paint_quad(fill(Bounds::new(point(px(a), px(oy)), size(px(b - a), px(h))), p.selection));
        }
    }
    let r = &p.model.rows[row];
    let ids = p.ids.clone();
    let lit = |it: &Item| ids.as_ref().is_some_and(|ids| ids.contains(&p.model.spans[it.span].id.get()));
    let y = snap(oy + (h - BAR_H) / 2.);
    for bar in bars(&p.model.items[r.items.clone()], r.items.start, v0, v1, w, &lit) {
        let (bg, border) = &p.colors[bar.cat.code() as usize];
        let opacity = match (&p.ids, p.model.has_path) {
            (Some(_), _) if bar.lit => 1.,
            (Some(_), _) => UNLIT,
            (None, true) if !bar.on_path => OFF_PATH,
            _ => 1.,
        };
        let x0 = snap(ox + bar.x0);
        let bw = snap((bar.x1 - bar.x0).max(1. / scale));
        let b = Bounds::new(point(px(x0), px(y)), size(px(bw), px(BAR_H)));
        let bgc = bg.map(|bg| bg.opacity(opacity)).unwrap_or_else(|| gpui::transparent_black().into());
        let edge = if bar.failed { Some(p.danger) } else { border.map(|c| c.opacity(opacity)) };
        window.paint_quad(quad(b, px(1.), bgc, px(if edge.is_some() && bw >= 3. { 1. } else { 0. }), edge.unwrap_or_default(), BorderStyle::Solid));
        if bar.lit {
            window.paint_quad(fill(Bounds::new(point(px(x0), px(y + BAR_H + 2.)), size(px(bw), px(2.))), p.accent));
        }
    }
}

pub fn render(v: &mut TimeView, t: &Theme, _window: &mut Window, cx: &mut Context<TimeView>) -> AnyElement {
    let Some(m) = v.model.clone() else {
        let msg = match (&v.spans_error, v.spans_done) {
            (Some(e), _) => e.clone(),
            (None, false) => "Loading this order's spans…".to_string(),
            (None, true) => "No spans for this order yet. Spans start when its first agent starts; a node older than the hub records none.".into(),
        };
        return div().p_4().child(ui::quiet(t, msg)).into_any_element();
    };
    let (v0, v1) = v.range(&m);
    let tick_list = ticks(v0, v1);
    let paint = Paint {
        model: m.clone(),
        v: (v0, v1),
        ids: v.highlight.as_ref().map(|h| h.ids.clone()),
        drag: v.drag,
        ticks: Rc::new(tick_list.clone()),
        colors: Rc::new(Category::ALL.map(|c| cat_paint(t, c))),
        danger: t.danger,
        accent: t.accent,
        grid: t.hairline,
        selection: t.selected,
        track: v.track.clone(),
        row0: v.row0.clone(),
    };
    let axis = div().h(px(metric::LINE + 6.)).flex_none().flex().border_b_1().border_color(t.hairline).child(div().w(px(LABEL_W)).flex_none()).child(
        div().flex_1().relative().h_full().children(tick_list.iter().map(|&tk| {
            let f = (tk - v0) as f32 / (v1 - v0) as f32;
            div()
                .absolute()
                .top(px(4.))
                .left(relative(f))
                .pl_1()
                .font_family(t.mono_font.clone())
                .text_size(px(tsize::XS))
                .text_color(t.quiet)
                .child(tick_label(tk, v0, v1))
        })),
    );
    let rows = m.rows.len();
    let this = cx.entity().downgrade();
    let hover_bg = t.hover;
    let paint_rows = paint.clone();
    let list = uniform_list("time-rows", rows, move |range: Range<usize>, _, cx| {
        let t = crate::theme::theme(cx).clone();
        range
            .map(|ix| {
                let r = &paint_rows.model.rows[ix];
                let p = paint_rows.clone();
                let (wm, wd, wu, wh, wl) = (this.clone(), this.clone(), this.clone(), this.clone(), this.clone());
                let label = ui::clickable(&t, div().id(("time-label", ix)))
                    .w(px(LABEL_W))
                    .flex_none()
                    .h_full()
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .hover(move |s| s.bg(hover_bg))
                    .when(r.kind == RowKind::Check, |d| d.pl(px(28.)))
                    .when_some(r.role, |d, role| d.child(role_tag(&t, role, tsize::XS).w(px(64.))))
                    .when(r.kind == RowKind::Check, |d| d.child(div().text_size(px(tsize::XS)).text_color(t.quiet).child("ci")))
                    .when_some(r.task.clone(), |d, task| {
                        d.child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(tsize::SM)).text_color(t.quiet).child(task))
                    })
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(tsize::XS))
                            .when(r.kind == RowKind::Check, |d| d.font_family(t.mono_font.clone()).text_size(px(tsize::SM)))
                            .child(if r.kind == RowKind::Lead { "split across its orders".to_string() } else { r.name.clone() }),
                    )
                    .on_hover(move |hovered, window, cx| {
                        let at = window.mouse_position();
                        wl.update(cx, |v, cx| {
                            let next = hovered.then_some(Hover::Lane { row: ix, at });
                            if *hovered || matches!(v.hover, Some(Hover::Lane { row, .. }) if row == ix) {
                                v.hover = next;
                                cx.notify();
                            }
                        })
                        .ok();
                    })
                    .on_click(move |_, _, cx| {
                        wh.update(cx, |v, cx| v.zoom_to_row(ix, cx)).ok();
                    });
                let track = div()
                    .id(("time-track", ix))
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .cursor_pointer()
                    .child(canvas(|_, _, _| (), move |bounds, _, window, _| paint_row(&p, ix, bounds, window)).size_full())
                    .on_mouse_move(move |e: &MouseMoveEvent, _, cx| {
                        wm.update(cx, |v, cx| v.on_track_move(ix, e, cx)).ok();
                    })
                    .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, window, cx| {
                        window.prevent_default();
                        wd.update(cx, |v, cx| v.on_track_down(e, cx)).ok();
                    })
                    .on_mouse_up(MouseButton::Left, move |e: &MouseUpEvent, _, cx| {
                        wu.update(cx, |v, cx| v.on_track_up(ix, e, cx)).ok();
                    });
                div().id(("time-row", ix)).w_full().h(px(ROW_H)).flex().items_center().child(label).child(track)
            })
            .collect::<Vec<_>>()
    })
    .track_scroll(&v.scroll)
    .size_full();
    let list = div().id("time-rows-wrap").flex_1().min_h_0().child(list).on_hover(cx.listener(|v, hovered: &bool, _, cx| {
        if !hovered && matches!(v.hover, Some(Hover::Bar { .. })) {
            v.hover = None;
            cx.notify();
        }
    }));
    let path_row = path_row(v, t, &paint, cx);
    let banner = v.highlight.clone().map(|h| highlight_banner(t, &h, cx));
    let loading = (!v.spans_done)
        .then(|| div().px_4().py_1().text_size(px(tsize::XS)).text_color(t.quiet).child(format!("Loading spans… {} so far", m.spans.len())));
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .children(banner)
        .children(loading)
        .child(axis)
        .child(list)
        .child(path_row)
        .child(legend(v, t, cx))
        .into_any_element()
}

fn highlight_banner(t: &Theme, h: &Highlight, cx: &mut Context<TimeView>) -> Div {
    let n = h.ids.len();
    let linked = h.linked.clone();
    div()
        .px_4()
        .py_1p5()
        .flex()
        .items_center()
        .gap_2()
        .border_b_1()
        .border_color(t.hairline)
        .text_size(px(tsize::XS))
        .child(div().w(px(10.)).h(px(2.)).bg(t.accent))
        .child(div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().text_color(t.text).child(format!(
            "{n} span{} lit: {}",
            if n == 1 { "" } else { "s" },
            h.title.replace('`', "")
        )))
        .child(div().flex_1())
        .child(ui::button(t, "hl-list", "List them", Variant::Ghost, true).on_click(cx.listener(move |_, _, _, cx| {
            cx.emit(super::TimeEvent::Linked(linked.clone()));
        })))
        .child(ui::button(t, "hl-clear", "Clear", Variant::Ghost, true).on_click(cx.listener(|v, _, _, cx| v.clear_highlight(cx))))
}

fn path_row(v: &TimeView, t: &Theme, p: &Paint, cx: &mut Context<TimeView>) -> Div {
    let m = p.model.clone();
    let total: i64 = m.path.iter().map(|s| s.end - s.start).sum();
    let label = div()
        .w(px(LABEL_W))
        .flex_none()
        .px_2()
        .flex()
        .items_center()
        .gap_1p5()
        .text_size(px(tsize::XS))
        .child(div().font_weight(STRONG).child("critical path"))
        .child(div().text_color(t.quiet).child(if m.has_path { fmt_dur(total) } else { "when the order is done".into() }));
    let (v0, v1) = p.v;
    let accent = t.accent;
    let danger = t.danger;
    let segs: Vec<(i64, i64, bool)> = m.path.iter().map(|s| (s.start, s.end, s.span.is_none())).collect();
    let mm = m.clone();
    let track = div()
        .id("time-path")
        .flex_1()
        .h_full()
        .cursor_pointer()
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let w = f32::from(bounds.size.width) as f64;
                    let ox = f32::from(bounds.origin.x);
                    let y = f32::from(bounds.origin.y) + f32::from(bounds.size.height) / 2. - 1.;
                    for &(a, b, gap) in &segs {
                        if b <= v0 || a >= v1 {
                            continue;
                        }
                        let x0 = ox + ((a.max(v0) - v0) as f64 / (v1 - v0) as f64 * w) as f32;
                        let x1 = ox + ((b.min(v1) - v0) as f64 / (v1 - v0) as f64 * w) as f32;
                        window.paint_quad(fill(
                            Bounds::new(point(px(x0), px(y)), size(px((x1 - x0).max(1.)), px(2.))),
                            if gap { danger } else { accent },
                        ));
                    }
                },
            )
            .size_full(),
        )
        .on_mouse_move(cx.listener(move |v, e: &MouseMoveEvent, _, cx| {
            let at = v.x_to_ms(&mm, e.position.x);
            let seg = mm.path.iter().position(|s| s.start <= at && at < s.end);
            let next = seg.map(|seg| Hover::Path { seg, at: e.position });
            if next.as_ref().map(|h| matches!(h, Hover::Path { seg, .. } if Some(*seg) == seg_of(&v.hover))) != Some(true) {
                v.hover = next;
                cx.notify();
            }
        }))
        .on_hover(cx.listener(|v, hovered: &bool, _, cx| {
            if !hovered && matches!(v.hover, Some(Hover::Path { .. })) {
                v.hover = None;
                cx.notify();
            }
        }))
        .on_click(cx.listener(move |v, e: &gpui::ClickEvent, _, cx| {
            let Some(m) = v.model.clone() else { return };
            let at = v.x_to_ms(&m, e.position().x);
            if let Some(s) = m.path.iter().find(|s| s.start <= at && at < s.end) {
                match s.span.map(|i| m.spans[i].clone()) {
                    Some(span) if v.open_transcript(&span, cx) => {}
                    _ => v.view = Some((s.start - 2_000, s.end + 2_000)),
                }
                cx.notify();
            }
        }));
    let _ = v;
    div().h(px(ROW_H)).flex_none().flex().items_center().border_t_1().border_color(t.hairline).child(label).child(track)
}

fn seg_of(h: &Option<Hover>) -> Option<usize> {
    match h {
        Some(Hover::Path { seg, .. }) => Some(*seg),
        _ => None,
    }
}

fn legend(v: &TimeView, t: &Theme, cx: &mut Context<TimeView>) -> Div {
    let zoomed = v.view.is_some();
    div()
        .h(px(metric::BAR - 8.))
        .flex_none()
        .px_4()
        .flex()
        .items_center()
        .gap_3()
        .border_t_1()
        .border_color(t.hairline)
        .text_size(px(tsize::XS))
        .text_color(t.quiet)
        .children(super::SHOWN.iter().map(|&c| div().flex().items_center().gap_1().child(swatch(t, c)).child(cat_label(c))))
        .child(
            div().flex().items_center().gap_1().child(div().w(px(14.)).h(px(8.)).border_1().border_color(t.danger).rounded(px(1.))).child("failed"),
        )
        .child(div().flex_1())
        .child("drag to zoom · click a bar for its transcript")
        .when(zoomed, |d| {
            d.child(ui::button(t, "time-unzoom", "Whole order", Variant::Secondary, true).on_click(cx.listener(|v, _, _, cx| {
                v.view = None;
                cx.notify();
            })))
        })
}

// ---- hover cards ----------------------------------------------------------------------------

fn line(t: &Theme) -> Div {
    div().flex().items_center().gap_1p5().text_color(t.quiet).whitespace_nowrap()
}

fn note(t: &Theme, text: &str) -> Div {
    div().pt_1().text_color(t.quiet).whitespace_normal().child(text.to_string())
}

pub fn bar_card(t: &Theme, m: &Model, row: usize, bar: &Bar, names: &Names) -> Vec<Div> {
    let r = &m.rows[row];
    if bar.n > 1 {
        let items = &m.items[bar.first..bar.first + bar.n as usize];
        let mut ms = [0i64; 7];
        for it in items {
            ms[it.cat.code() as usize] += it.end - it.start;
        }
        let total: i64 = ms.iter().sum();
        let pct = ms[bar.cat.code() as usize] * 100 / total.max(1);
        return vec![
            div().font_weight(STRONG).child(format!("{} spans, mostly {} ({pct}%)", bar.n, cat_label(bar.cat))),
            line(t).child(format!("{} · {} to {}", fmt_dur(total), clock_ms(bar.start), clock_ms(bar.end))),
            note(t, "Too short to draw one by one at this zoom. Click to zoom in."),
        ];
    }
    let span = &m.spans[m.items[bar.first].span];
    let parallel = m.parallel.contains(&span.id.get());
    let end = span.end_ms.map(|e| e.get());
    let dur = fmt_dur(end.unwrap_or(m.items[bar.first].end) - span.start_ms.get());
    let mark = inexact(span, names, parallel);
    let dur = match mark {
        Some((mk, _)) if mk == "≈" || mk == "≤" => format!("{mk} {dur}"),
        _ => dur,
    };
    let title = span_title(span);
    let machine_text = span.label.as_ref().is_some_and(|l| !l.is_empty()) || span.extra.as_ref().is_some_and(|e| e.check.is_some());
    let mut out = vec![
        div()
            .flex()
            .gap_2()
            .child(
                div()
                    .min_w_0()
                    .whitespace_normal()
                    .text_color(t.text)
                    .when(machine_text, |d| d.font_family(t.mono_font.clone()).text_size(px(tsize::SM)))
                    .when(!machine_text, |d| d.font_weight(STRONG))
                    .child(title),
            )
            .child(div().flex_none().text_color(t.quiet).child(cat_label(span.cat))),
    ];
    let mut facts = vec![r.task.clone().map_or(r.name.clone(), |task| format!("{} ({task})", r.name)), dur];
    if let Some(code) = span.exit_code {
        facts.push(format!("exit {}", code.get()));
    }
    if let Some(b) = span.out_bytes {
        facts.push(format!("{} output", fmt_bytes(b.get())));
    }
    match span.status {
        SpanStatus::Failed if span.exit_code.is_none() => facts.push("failed".into()),
        SpanStatus::Cancelled => facts.push("cancelled".into()),
        SpanStatus::Incomplete => facts.push("cut short".into()),
        _ => {}
    }
    out.push(line(t).child(facts.join(" · ")));
    out.push(line(t).child(match end {
        Some(e) => format!("{} to {}", clock_ms(span.start_ms.get()), clock_ms(e)),
        None => format!("since {}, still running", clock_ms(span.start_ms.get())),
    }));
    let ex = span.extra.clone().unwrap_or_default();
    // A model phase: the whole message it belongs to.
    if let Some(parent) = span.parent.and_then(|p| m.by_id.get(&p.get())).map(|&i| &m.spans[i])
        && parent.kind == SpanKind::ModelMessage
    {
        let phases: Vec<String> = m
            .children
            .get(&parent.id.get())
            .into_iter()
            .flatten()
            .map(|&c| {
                let s = &m.spans[c];
                format!("{} {}", kind_word(s.kind), fmt_dur(s.end_ms.map_or(0, |e| e.get()) - s.start_ms.get()))
            })
            .collect();
        let total = parent.end_ms.map_or(0, |e| e.get()) - parent.start_ms.get();
        out.push(line(t).child(format!("message {} · {}", fmt_dur(total), phases.join(" · "))));
        let pex = parent.extra.clone().unwrap_or_default();
        let mut tok = Vec::new();
        if let Some(o) = pex.output_tokens {
            tok.push(format!("{} output tokens", o.get()));
        }
        if let Some(th) = pex.thinking_tokens {
            tok.push(format!("{} thinking (exact)", th.get()));
        }
        if let Some(sr) = pex.stop_reason {
            tok.push(format!("stopped: {sr}"));
        }
        if !tok.is_empty() {
            out.push(line(t).child(tok.join(" · ")));
        }
    }
    if span.kind == SpanKind::ToolsParallel {
        let kids = m.children.get(&span.id.get()).cloned().unwrap_or_default();
        out.push(line(t).child(format!("{} calls at once; the group's time is exact", kids.len())));
        for c in kids.iter().take(6) {
            let s = &m.spans[*c];
            out.push(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        div()
                            .w(px(56.))
                            .flex_none()
                            .text_color(t.quiet)
                            .child(format!("≤ {}", fmt_dur(s.end_ms.map_or(0, |e| e.get()) - s.start_ms.get()))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .font_family(t.mono_font.clone())
                            .text_size(px(tsize::SM))
                            .child(span_title(s)),
                    ),
            );
        }
    }
    if let Some(by) = ex.decided_by {
        let who = match by {
            DecidedBy::Policy => "the machine's policy, at once".to_string(),
            DecidedBy::HubRule => "a project tool rule".into(),
            DecidedBy::Lead => "the lead".into(),
            DecidedBy::Human => ex.answered_by.as_ref().map_or("you".into(), |a| format!("you ({a})")),
        };
        out.push(line(t).child(format!("answered by {who}")));
    }
    if let Some(status) = ex.http_status {
        let stated = ex.stated_delay_ms.map(|d| format!(" · claude said wait {}", fmt_dur(d.get()))).unwrap_or_default();
        out.push(line(t).child(format!("retried on HTTP {}{stated}", status.get())));
    }
    if let Some(r) = ex.reason.filter(|r| !r.is_empty()) {
        out.push(line(t).child(r.to_string()));
    }
    if let Some(c) = ex.claude_ms {
        out.push(line(t).child(format!("claude's own figure: {}", fmt_dur(c.get()))));
    }
    if bar.on_path {
        out.push(div().text_color(t.accent).child("on the critical path"));
    }
    if let Some((_, why)) = mark {
        out.push(note(t, why));
    }
    let hint = if ex.url.is_some() {
        "Click to open the check on GitHub."
    } else if span.item_id.is_some() && span.thread_id.is_some() {
        "Click to open the transcript here."
    } else {
        "Click to zoom to it."
    };
    out.push(div().pt_1().text_color(t.quiet).child(hint));
    out
}

pub fn lane_card(t: &Theme, m: &Model, row: usize) -> Vec<Div> {
    let r = &m.rows[row];
    let mut out = vec![div().font_weight(STRONG).child(match (&r.role, &r.task) {
        (Some(role), Some(task)) => format!("{} {task}: {}", crate::live::chips::role_word(*role), r.name),
        _ if r.kind == RowKind::Lead => "The project's lead".to_string(),
        _ => r.name.clone(),
    })];
    out.push(line(t).child(format!("{} spans · {} of agent time", r.items.len(), fmt_dur(r.agent_ms))));
    if !r.summary.is_empty() {
        out.push(line(t).child(r.summary.clone()));
    }
    if r.kind == RowKind::Lead {
        out.push(note(
            t,
            "One lead turn serves every order it woke for; its time is split equally across them, so this lane shows this order's share.",
        ));
    }
    out.push(div().pt_1().text_color(t.quiet).child("Click to zoom to this lane."));
    out
}

pub fn path_card(t: &Theme, m: &Model, seg: usize) -> Vec<Div> {
    let s = &m.path[seg];
    let row = s.row.map(|r| m.rows[r].task.clone().unwrap_or_else(|| m.rows[r].name.clone())).unwrap_or_default();
    if s.span.is_none() {
        return vec![
            div().font_weight(STRONG).text_color(t.danger).child("Nothing running"),
            line(t).child(format!("{} · {} to {}", fmt_dur(s.end - s.start), clock_ms(s.start), clock_ms(s.end))),
            note(t, "No span covers this stretch of the path, which usually means missing data rather than a real pause."),
        ];
    }
    vec![
        div()
            .flex()
            .gap_2()
            .child(div().font_weight(STRONG).child(s.label.clone().unwrap_or_else(|| kind_word(s.kind).to_string())))
            .child(div().text_color(t.quiet).child(cat_label(s.cat))),
        line(t).child(format!("{row} · {} · {} to {}", fmt_dur(s.end - s.start), clock_ms(s.start), clock_ms(s.end))),
        div().pt_1().text_color(t.quiet).child("On the critical path: the order's wall time is these segments end to end."),
    ]
}

/// Linked spans of one category, for a breakdown row clicked on an order.
pub fn category_link(cat: Category) -> Linked {
    Linked {
        title: format!("{} time", cat_label(cat)),
        rule: None,
        kinds: SpanKind::ALL.iter().copied().filter(|k| k.category() == cat && !k.is_envelope()).collect(),
        label: None,
        check: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(start: i64, end: i64, cat: Category) -> Item {
        Item { span: 0, start, end, cat, on_path: false, failed: false }
    }

    #[test]
    fn spans_narrower_than_a_pixel_merge_into_one_bar_per_column() {
        // 1000 ms across 100 px: 10 ms per px.
        let items = vec![
            item(0, 3, Category::Model),
            item(3, 9, Category::Tools),
            item(9, 10, Category::Model),
            item(10, 500, Category::Tools),
            item(500, 1000, Category::Human),
        ];
        let b = bars(&items, 0, 0, 1000, 100., &|_| false);
        assert_eq!(b.len(), 3, "{b:?}");
        assert_eq!((b[0].n, b[0].cat, b[0].x0, b[0].x1), (3, Category::Tools, 0., 1.), "tools has 6 of the 10 ms in the column");
        assert_eq!((b[1].n, b[1].cat, b[1].x0, b[1].x1), (1, Category::Tools, 1., 50.));
        assert_eq!((b[2].first, b[2].cat), (4, Category::Human));
    }

    #[test]
    fn only_what_is_in_view_is_drawn_and_bars_stay_bounded_by_width() {
        let items: Vec<Item> =
            (0..10_000).map(|i| item(i * 100, i * 100 + 100, if i % 3 == 0 { Category::Model } else { Category::Tools })).collect();
        let all = bars(&items, 0, 0, 1_000_000, 400., &|_| false);
        assert!(all.len() <= 400, "10k spans on 400 px draw at most a bar per px, got {}", all.len());
        assert!(all.iter().all(|b| b.cat == Category::Tools), "tools dominate every column");
        let zoomed = bars(&items, 0, 50_000, 51_000, 1000., &|_| false);
        assert_eq!(zoomed.len(), 10, "zoomed in, each span is its own bar");
        assert_eq!(zoomed[0].first, 500);
    }

    #[test]
    fn a_merged_bar_keeps_path_failure_and_highlight() {
        let mut items = vec![item(0, 2, Category::Model), item(2, 4, Category::Tools)];
        items[1].failed = true;
        items[1].on_path = true;
        let b = bars(&items, 0, 0, 1000, 100., &|it| it.start == 2);
        assert_eq!(b.len(), 1);
        assert!(b[0].failed && b[0].on_path && b[0].lit);
    }

    #[test]
    fn ticks_land_on_round_times() {
        let v0 = 10 * 3_600_000 + 7 * 60_000;
        let t = ticks(v0, v0 + 102 * 60_000);
        assert!(t.len() <= 8 && t.len() >= 4, "{t:?}");
        assert!(t.iter().all(|x| x % 900_000 == 0), "every 15 minutes");
        assert_eq!(clock_ms(t[0]), "10:15:00");
    }

    #[test]
    fn the_nearest_bar_is_hit_within_a_little_slack() {
        let b = bars(&[item(0, 100, Category::Model), item(500, 510, Category::Tools)], 0, 0, 1000, 100., &|_| false);
        assert_eq!(hit(&b, 5.).map(|b| b.first), Some(0));
        assert_eq!(hit(&b, 51.5).map(|b| b.first), Some(1), "a 1 px bar is hit from beside it");
        assert_eq!(hit(&b, 30.), None);
    }
}
