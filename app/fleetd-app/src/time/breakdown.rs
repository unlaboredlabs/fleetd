//! The breakdown: agent time per category with what is inside each, the critical path's share on an order, the
//! slowest and most repeated commands, the CI checks and the time spent waiting on you. With compare on, each
//! category shows the previous period beside this one. Every row opens the spans behind it.

use fleetd_contracts::mcp::TimeBreakdownOutput;
use fleetd_contracts::time::{Category, CategoryTotal, Gap, GapWhy, InsightRule, SpanKind};
use gpui::{AnyElement, Context, Div, SharedString, div, prelude::*, px};

use super::{SHOWN, TimeView, cat_label, fmt_bytes, fmt_dur, kind_word, swatch};
use crate::state::Linked;
use crate::theme::{STRONG, Theme, metric, size};
use crate::ui;

const CAT_W: f32 = 132.;
const NUM_W: f32 = 64.;
const PCT_W: f32 = 40.;
const BAR_W: f32 = 140.;

/// "39%", or "<1%" for a sliver that is still there.
pub fn pct(part: i64, whole: i64) -> String {
    if whole <= 0 || part <= 0 {
        return "0%".into();
    }
    let p = part as f64 * 100. / whole as f64;
    if p < 1. { "<1%".into() } else { format!("{}%", p.round() as i64) }
}

/// "▲ 12%", "▼ 31%", "same"; "new" when the earlier period had none.
pub fn delta(before: i64, now: i64) -> String {
    if before == 0 {
        return if now == 0 { "same".into() } else { "new".into() };
    }
    let p = ((now - before) as f64 * 100. / before as f64).round() as i64;
    match p {
        0 => "same".into(),
        p if p > 0 => format!("▲ {p}%"),
        p => format!("▼ {}%", -p),
    }
}

fn kinds_text(c: &CategoryTotal) -> String {
    let mut kinds: Vec<_> = c.kinds.iter().filter(|k| k.ms.get() > 0).collect();
    kinds.sort_by_key(|c| std::cmp::Reverse(c.ms.get()));
    kinds
        .iter()
        .take(4)
        .map(|k| {
            let mark = if k.kind == SpanKind::ModelFirstToken { "≈ " } else { "" };
            let n = if c.cat == Category::Tools { format!(" ({})", k.n.get()) } else { String::new() };
            format!("{} {mark}{}{n}", kind_word(k.kind), fmt_dur(k.ms.get()))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

fn section(t: &Theme, title: &'static str, detail: impl Into<SharedString>) -> Div {
    div()
        .pt_6()
        .pb_1()
        .flex()
        .items_baseline()
        .gap_2()
        .child(div().font_weight(STRONG).child(title))
        .child(div().text_size(px(size::XS)).text_color(t.quiet).child(detail.into()))
}

fn num(t: &Theme, text: impl Into<SharedString>, w: f32) -> Div {
    div().w(px(w)).flex_none().flex().justify_end().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(text.into())
}

fn head(t: &Theme, cols: &[(&'static str, f32)]) -> Div {
    let mut d = div().h(px(metric::LINE + 4.)).px_2().flex().items_center().gap_3().text_size(px(size::XS)).text_color(t.quiet);
    for (ix, (label, w)) in cols.iter().enumerate() {
        d = d.child(if ix == 0 { div().flex_1().min_w_0().child(*label) } else { div().w(px(*w)).flex_none().flex().justify_end().child(*label) });
    }
    d
}

pub fn render(v: &mut TimeView, t: &Theme, cx: &mut Context<TimeView>) -> AnyElement {
    let b = match &v.breakdown {
        None => return ui::loading(t, "Asking the hub where the time went…").into_any_element(),
        Some(Err(e)) => return div().p_4().max_w(px(metric::MEASURE)).child(ui::empty(t, "The hub couldn't answer", e.clone())).into_any_element(),
        Some(Ok(b)) => b.clone(),
    };
    let order = v.order.is_some();
    let agent = b.agent_ms.get();
    let mut body = div().id("time-breakdown").flex_1().min_h_0().overflow_y_scroll().px_6().pb_6().flex().flex_col();
    body = body.child(summary_line(v, t, &b));
    if agent == 0 {
        return body
            .child(ui::empty(t, "No agent time in this period", "Nothing ran here in the range picked. Try a longer range or another project."))
            .into_any_element();
    }
    body = body.child(categories(v, t, &b, cx));
    if let Some(p) = b.critical_path.as_ref().filter(|_| order) {
        let total = p.end_ms.get() - p.start_ms.get();
        let mut totals: Vec<_> = p.totals.iter().filter(|c| c.ms.get() > 0).collect();
        totals.sort_by_key(|c| std::cmp::Reverse(c.ms.get()));
        let mut rows = div().flex().flex_col();
        for c in totals {
            let cat = c.cat;
            let ids: Vec<i64> = v
                .model
                .as_ref()
                .map(|m| m.path.iter().filter(|s| s.cat == cat).filter_map(|s| s.span.map(|i| m.spans[i].id.get())).collect())
                .unwrap_or_default();
            let linked =
                Linked { title: format!("{} on the critical path", cat_label(cat)), rule: None, kinds: Vec::new(), label: None, check: None };
            rows = rows.child(
                ui::row(t, SharedString::from(format!("path-{}", cat.code())), false)
                    .gap_3()
                    .child(div().w(px(CAT_W)).flex_none().flex().items_center().gap_2().child(swatch(t, cat)).child(cat_label(cat)))
                    .child(num(t, fmt_dur(c.ms.get()), NUM_W))
                    .child(num(t, pct(c.ms.get(), total), PCT_W).text_color(t.quiet))
                    .child(div().flex_1())
                    .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), Some(ids.clone()), cx))),
            );
        }
        let mut detail = format!("{} end to end; {} of agent time ran off it", fmt_dur(total), fmt_dur(p.off_path_ms.get()));
        if p.nothing_running_ms.get() > 0 {
            detail.push_str(&format!("; {} with nothing running (missing data)", fmt_dur(p.nothing_running_ms.get())));
        }
        body = body.child(section(t, "Critical path", detail)).child(rows);
    }
    body = body.child(commands(t, &b, cx));
    if !b.repeated.is_empty() {
        let mut rows =
            div().flex().flex_col().child(head(t, &[("Ran again with no edit between", 0.), ("in", 96.), ("runs", NUM_W), ("total", NUM_W)]));
        for (ix, r) in b.repeated.iter().enumerate() {
            let label = r.label.to_string();
            let linked = Linked {
                title: format!("`{label}` repeated with no edit"),
                rule: Some(InsightRule::RepeatNoChange),
                kinds: Vec::new(),
                label: Some(label.clone()),
                check: None,
            };
            rows = rows.child(
                ui::row(t, ("rep", ix), false)
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .font_family(t.mono_font.clone())
                            .text_size(px(size::SM))
                            .child(label),
                    )
                    .child(
                        div()
                            .w(px(96.))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .text_size(px(size::XS))
                            .text_color(t.quiet)
                            .child(r.task_id.as_ref().map_or_else(|| r.thread_id.to_string(), |task| task.to_string())),
                    )
                    .child(num(t, format!("{}×", r.n.get()), NUM_W))
                    .child(num(t, fmt_dur(r.total_ms.get()), NUM_W))
                    .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), None, cx))),
            );
        }
        body = body.child(section(t, "Repeated commands", "the same command in one session with nothing edited between runs")).child(rows);
    }
    if !b.ci_checks.is_empty() {
        let mut rows = div()
            .flex()
            .flex_col()
            .child(head(t, &[("Check", 0.), ("runs", NUM_W), ("total", NUM_W), ("median", NUM_W), ("longest", NUM_W), ("on path", NUM_W)]));
        for (ix, c) in b.ci_checks.iter().enumerate() {
            let name = c.name.to_string();
            let linked =
                Linked { title: format!("CI check {name}"), rule: None, kinds: vec![SpanKind::CiCheck], label: None, check: Some(name.clone()) };
            let excess = c.critical_excess_ms.get();
            rows = rows.child(
                ui::row(t, ("ci", ix), false)
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .font_family(t.mono_font.clone())
                            .text_size(px(size::SM))
                            .child(name),
                    )
                    .child(num(t, c.n.get().to_string(), NUM_W))
                    .child(num(t, fmt_dur(c.total_ms.get()), NUM_W))
                    .child(num(t, fmt_dur(c.p50_ms.get()), NUM_W))
                    .child(num(t, fmt_dur(c.max_ms.get()), NUM_W))
                    .child(
                        num(t, if excess > 0 { format!("+{}", fmt_dur(excess)) } else { "–".into() }, NUM_W)
                            .when(excess > 0, |d| d.text_color(t.text))
                            .when(excess == 0, |d| d.text_color(t.quiet)),
                    )
                    .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), None, cx))),
            );
        }
        body = body
            .child(section(
                t,
                "Longest CI checks",
                "GitHub's own start and end for each run; \"on path\" is what a check added past the second-slowest",
            ))
            .child(rows);
    }
    let hw = &b.human_wait;
    if hw.n.get() > 0 {
        let longest = hw
            .longest
            .as_ref()
            .map(|l| format!("; longest {} {}", l.label.as_ref().map_or(String::new(), |k| format!("`{k}`")), fmt_dur(l.ms.get())))
            .unwrap_or_default();
        let linked = Linked {
            title: "Time waiting on you".into(),
            rule: Some(InsightRule::HumanWait),
            kinds: vec![SpanKind::WaitAsk, SpanKind::WaitPermission],
            label: None,
            check: None,
        };
        body = body.child(section(t, "Waiting on you", "blocking asks and approvals, from publish to your answer")).child(
            ui::row(t, "human-wait", false)
                .gap_3()
                .child(swatch(t, Category::Human))
                .child(div().flex_1().child(format!(
                    "{} over {} wait{}{longest}",
                    fmt_dur(hw.total_ms.get()),
                    hw.n.get(),
                    if hw.n.get() == 1 { "" } else { "s" }
                )))
                .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), None, cx))),
        );
    }
    body.child(notes(t, &b)).into_any_element()
}

fn summary_line(v: &TimeView, t: &Theme, b: &TimeBreakdownOutput) -> Div {
    let order = v.order.is_some();
    let (wall, agent) = (b.wall_ms.get(), b.agent_ms.get());
    let mut parts = vec![format!("{} {}", if order { "wall" } else { "wall of orders" }, fmt_dur(wall)), format!("agent time {}", fmt_dur(agent))];
    if wall > 0 {
        parts.push(format!("parallelism {:.1}×", agent as f64 / wall as f64));
    }
    let coverage = if b.coverage.complete {
        "coverage complete".to_string()
    } else {
        let n = b.coverage.gaps.len();
        format!("coverage: {n} gap{}", if n == 1 { "" } else { "s" })
    };
    div()
        .pt_4()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .gap_3()
                .text_color(t.text)
                .child(parts.join(" · "))
                .child(div().text_color(if b.coverage.complete { t.quiet } else { t.warning }).child(coverage)),
        )
        .child(
            div()
                .text_size(px(size::XS))
                .text_color(t.quiet)
                .child("Agent time is each lane's own time added up, so parallel agents count twice; wall time is the clock from start to end."),
        )
}

fn categories(v: &TimeView, t: &Theme, b: &TimeBreakdownOutput, cx: &mut Context<TimeView>) -> Div {
    let agent = b.agent_ms.get();
    let prev = b.compare.as_ref();
    let mut cats: Vec<&CategoryTotal> = b.by_category.iter().filter(|c| SHOWN.contains(&c.cat) && c.ms.get() > 0).collect();
    cats.sort_by_key(|c| std::cmp::Reverse(c.ms.get()));
    let max = cats.first().map_or(1, |c| c.ms.get()).max(1);
    let mut cols = vec![("Agent time", 0.), ("", NUM_W), ("", PCT_W)];
    if prev.is_some() {
        cols.push(("before", NUM_W + 8.));
        cols.push(("change", NUM_W));
    }
    let mut rows = div().flex().flex_col().child(head(t, &cols));
    for c in cats {
        let cat = c.cat;
        let before = prev.and_then(|p| p.by_category.iter().find(|x| x.cat == cat)).map_or(0, |x| x.ms.get());
        let w = (c.ms.get() as f32 / max as f32 * BAR_W).max(2.);
        let order = v.order.is_some();
        rows = rows.child(
            ui::row(t, SharedString::from(format!("cat-{}", cat.code())), false)
                .gap_3()
                .child(div().w(px(CAT_W)).flex_none().flex().items_center().gap_2().child(swatch(t, cat)).child(cat_label(cat)))
                .child(num(t, fmt_dur(c.ms.get()), NUM_W))
                .child(num(t, pct(c.ms.get(), agent), PCT_W).text_color(t.quiet))
                .child(div().w(px(BAR_W)).flex_none().child(div().w(px(w)).h(px(6.)).rounded(px(1.)).bg(t.quiet)))
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().text_size(px(size::XS)).text_color(t.quiet).child(kinds_text(c)))
                .when(prev.is_some(), |d| {
                    d.child(num(t, fmt_dur(before), NUM_W + 8.).text_color(t.quiet))
                        .child(num(t, delta(before, c.ms.get()), NUM_W).text_color(t.quiet))
                })
                .on_click(cx.listener(move |v, _, _, cx| {
                    let _ = order;
                    v.show_linked(super::timeline::category_link(cat), None, cx)
                })),
        );
    }
    if let Some(p) = prev {
        rows = rows.child(div().px_2().pt_1().text_size(px(size::XS)).text_color(t.quiet).child(format!(
            "Before: {} to {} · agent time {} → {} ({})",
            p.since.as_str().get(..10).unwrap_or(""),
            p.until.as_str().get(..10).unwrap_or(""),
            fmt_dur(p.agent_ms.get()),
            fmt_dur(agent),
            delta(p.agent_ms.get(), agent)
        )));
    }
    rows
}

fn commands(t: &Theme, b: &TimeBreakdownOutput, cx: &mut Context<TimeView>) -> Div {
    if b.top_commands.is_empty() {
        return div();
    }
    let mut rows = div()
        .flex()
        .flex_col()
        .child(head(t, &[("Command", 0.), ("runs", NUM_W), ("total", NUM_W), ("median", NUM_W), ("longest", NUM_W), ("failed", NUM_W)]));
    for (ix, c) in b.top_commands.iter().enumerate() {
        let label = c.label.to_string();
        let linked =
            Linked { title: format!("`{label}`"), rule: Some(InsightRule::SlowCommands), kinds: Vec::new(), label: Some(label.clone()), check: None };
        let failed = c.failed.get();
        rows = rows.child(
            ui::row(t, ("cmd", ix), false)
                .gap_3()
                .child(
                    div().flex_1().min_w_0().overflow_hidden().text_ellipsis().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(label),
                )
                .child(num(t, c.n.get().to_string(), NUM_W))
                .child(num(t, fmt_dur(c.total_ms.get()), NUM_W))
                .child(num(t, fmt_dur(c.p50_ms.get()), NUM_W))
                .child(num(t, fmt_dur(c.max_ms.get()), NUM_W))
                .child(num(t, failed.to_string(), NUM_W).text_color(if failed > 0 { t.danger } else { t.quiet }))
                .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), None, cx))),
        );
    }
    div().child(section(t, "Slowest commands", "per call: each call's own time, so calls that ran together can overlap")).child(rows)
}

/// One coverage gap in words: "a machine runs a fleetd too old to record tool time (buildbox), 16:20:00 to 18:02:00".
pub fn gap_text(g: &Gap) -> String {
    let count = g.count.map_or(String::new(), |c| format!("{} ", c.get()));
    let what = match g.why {
        GapWhy::NodeOlder => "a machine runs a fleetd too old to record tool time".to_string(),
        GapWhy::NodeDropped => format!("a machine dropped {count}spans it couldn't send in time"),
        GapWhy::HubDropped => format!("the hub was too busy to keep {count}spans"),
        GapWhy::NoNodeSpans => "a session has no tool timeline".to_string(),
        GapWhy::NothingRunning => "the critical path found time with nothing running".to_string(),
    };
    let on = g.machine_id.as_ref().map(|m| format!(" ({m})")).unwrap_or_default();
    format!("{what}{on}, {} to {}", super::clock_ms(g.from_ms.get()), super::clock_ms(g.to_ms.get()))
}

/// What these numbers can't say, in the reader's words (spec §2f), and any data the hub knows is missing.
fn notes(t: &Theme, b: &TimeBreakdownOutput) -> Div {
    let mut lines: Vec<String> = Vec::new();
    for g in b.coverage.gaps.iter() {
        lines.push(format!("Missing: {}.", gap_text(g)));
    }
    if let Some(since) = &b.coverage.detail_since {
        lines.push(format!(
            "Detail since {}: commands, CI checks and findings start there (retention); totals before that come from daily roll-ups.",
            since.as_str().get(..10).unwrap_or("")
        ));
    }
    if b.coverage.capped == Some(true) {
        lines.push("Capped at 200k spans: the hub read the newest ones.".into());
    }
    lines.extend(
        [
            "≈ First token includes claude's own work before the request, the network, API queueing and prefill; they can't be told apart. Thinking and output are split as streamed; each message's total is exact.",
            "≤ When several tools ran from one message, each call's own time is an upper bound; the group's time is exact.",
            "A lead turn serves every order it woke for, so its time is split equally across them: a rule, not a measurement.",
            "CI checks use GitHub's start and end, in whole seconds. Lanes on different machines line up to within the link's latency.",
            "Waiting on you runs from when an ask was published to your answer; when you first saw it isn't known.",
        ]
        .map(String::from),
    );
    let store = format!("Spans are kept {} days; they take {} on the hub.", b.retention_days.get(), fmt_bytes(b.stored_bytes.get()));
    div()
        .pt_6()
        .max_w(px(metric::MEASURE + 120.))
        .flex()
        .flex_col()
        .gap_1()
        .text_size(px(size::XS))
        .text_color(t.quiet)
        .child(div().font_weight(STRONG).text_color(t.text).child("What isn't exact"))
        .children(lines.into_iter().map(|l| div().whitespace_normal().child(l)))
        .child(div().pt_1().child(store))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_and_changes_read_plainly() {
        assert_eq!(pct(39, 100), "39%");
        assert_eq!(pct(1, 1000), "<1%");
        assert_eq!(pct(0, 100), "0%");
        assert_eq!(delta(100, 102), "▲ 2%");
        assert_eq!(delta(100, 69), "▼ 31%");
        assert_eq!(delta(0, 5), "new");
        assert_eq!(delta(7, 7), "same");
    }
}
