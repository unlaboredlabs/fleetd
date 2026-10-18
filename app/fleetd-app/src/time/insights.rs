//! Insights: the hub's deterministic findings (spec §6), strongest first, each with its numbers and a way to the
//! spans behind it. The app adds nothing to the message but layout: commands and numbers set in mono.

use fleetd_contracts::time::{FiredIn, Insight, InsightNumber};
use gpui::{AnyElement, Context, Div, SharedString, div, prelude::*, px};

use super::{TimeView, fmt_dur};
use crate::state::Linked;
use crate::theme::{Theme, metric, size};
use crate::ui::{self, Variant};

/// A message split into words for display, each `(text, mono, joined)`: machine text (a backticked command, or a
/// word with a number in it) is mono; `joined` words follow the previous one with no space (": 17×" after a
/// command).
pub fn segments(message: &str) -> Vec<(String, bool, bool)> {
    let mut out = Vec::new();
    for (ix, part) in message.split('`').enumerate() {
        if ix % 2 == 1 {
            out.push((part.to_string(), true, false));
            continue;
        }
        let glued = ix > 0 && !part.starts_with(char::is_whitespace);
        for (n, word) in part.split_whitespace().enumerate() {
            out.push((word.to_string(), word.chars().any(|c| c.is_ascii_digit()), glued && n == 0));
        }
    }
    out
}

/// "noEdit" → "no edit", "totalMs" → "total": the hub's number names as words.
fn words(name: &str) -> String {
    let name = name.strip_suffix("Ms").or_else(|| name.strip_suffix("_ms")).unwrap_or(name);
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push(' ');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(if c == '_' { ' ' } else { c });
        }
    }
    out
}

/// The hub writes messages in lower case so they read inside a sentence; the list starts each with a capital.
fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

fn is_duration(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with("ms") || ["total", "p50", "p90", "max", "excess", "dur", "wait", "longest"].iter().any(|k| n == *k)
}

fn value(n: &InsightNumber) -> String {
    let v = n.value.get();
    if v != 0 && is_duration(n.name.as_str()) { fmt_dur(v) } else { format!("{v}") }
}

/// "runs 22 → 9 · total 51m → 19m": each number for the earlier period, then this one.
pub fn compare_line(now: &[InsightNumber], before: &[InsightNumber]) -> String {
    now.iter()
        .take(3)
        .map(|n| {
            let b = before.iter().find(|b| b.name == n.name).map_or("0".to_string(), value);
            format!("{} {b} → {}", words(n.name.as_str()), value(n))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

fn message(t: &Theme, text: &str) -> Div {
    let piece =
        |seg: String, mono: bool| if mono { div().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(seg) } else { div().child(seg) };
    let mut words: Vec<Div> = Vec::new();
    for (seg, mono, joined) in segments(&capitalized(text)) {
        match words.pop() {
            Some(prev) if joined => words.push(prev.child(piece(seg, mono))),
            prev => {
                words.extend(prev);
                words.push(div().flex().items_baseline().child(piece(seg, mono)));
            }
        }
    }
    div().flex().flex_wrap().items_baseline().gap_x(px(4.)).gap_y(px(2.)).children(words)
}

pub fn render(v: &mut TimeView, t: &Theme, cx: &mut Context<TimeView>) -> AnyElement {
    let list = match &v.insights {
        None => return ui::loading(t, "Running the hub's rules over this period…").into_any_element(),
        Some(Err(e)) => return div().p_4().child(ui::empty(t, "The hub couldn't answer", e.clone())).into_any_element(),
        Some(Ok(out)) => out.insights.clone(),
    };
    if list.is_empty() {
        return ui::empty(
            t,
            "Nothing stands out",
            "None of the hub's rules fired for this period: no repeated test runs, slow checks on the critical path, long waits on you or full slots.",
        )
        .into_any_element();
    }
    let mut col = div().id("time-insights").flex_1().min_h_0().overflow_y_scroll().px_6().py_4().flex().flex_col().gap_1();
    col = col.child(
        div()
            .pb_2()
            .max_w(px(metric::MEASURE + 200.))
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .whitespace_normal()
            .child("Found by fixed rules over the spans, never a model. Each one shows the numbers it fired on."),
    );
    for (ix, ins) in list.into_iter().enumerate() {
        col = col.child(row(t, ix, ins, cx));
    }
    col.into_any_element()
}

fn row(t: &Theme, ix: usize, ins: Insight, cx: &mut Context<TimeView>) -> impl IntoElement {
    let ids: Vec<i64> = ins.span_ids.iter().map(|i| i.get()).collect();
    let n = ids.len();
    let linked = Linked { title: capitalized(ins.message.as_str()), rule: Some(ins.rule), kinds: Vec::new(), label: None, check: None };
    let before = ins.compare.as_ref().map(|c| compare_line(&ins.numbers, c));
    let fired = match ins.fired_in {
        Some(FiredIn::Current) => Some("new this period"),
        Some(FiredIn::Compare) => Some("only before"),
        _ => None,
    };
    let (l1, l2) = (linked.clone(), ids.clone());
    let hover = t.hover;
    ui::clickable(t, div().id(SharedString::from(format!("insight-{ix}"))))
        .px_2()
        .py_2()
        .rounded(px(crate::theme::radius::SM))
        .hover(move |s| s.bg(hover))
        .flex()
        .items_start()
        .gap_3()
        .child(div().w(px(20.)).flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(format!("{}", ix + 1)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .max_w(px(metric::MEASURE + 160.))
                .flex()
                .flex_col()
                .gap_1()
                .child(message(t, ins.message.as_str()))
                .when_some(before, |d, line| d.child(div().text_size(px(size::XS)).text_color(t.quiet).font_family(t.mono_font.clone()).child(line)))
                .when_some(fired, |d, f| d.child(div().text_size(px(size::XS)).text_color(t.quiet).child(f))),
        )
        .child(
            ui::button(
                t,
                ("insight-spans", ix),
                if n == 0 { "Show spans".to_string() } else { format!("Show {n} span{}", if n == 1 { "" } else { "s" }) },
                Variant::Ghost,
                true,
            )
            .on_click(cx.listener(move |v, _, _, cx| v.show_linked(l1.clone(), Some(l2.clone()), cx))),
        )
        .on_click(cx.listener(move |v, _, _, cx| v.show_linked(linked.clone(), Some(ids.clone()), cx)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::prim::{AnyInt, Line};

    fn num(name: &str, v: i64) -> InsightNumber {
        InsightNumber { name: Line::unchecked(name), value: AnyInt::unchecked(v) }
    }

    #[test]
    fn commands_and_numbers_are_machine_text() {
        let s = segments("agents ran the full test suite `npm test` 22× (51m); 14 runs followed no edit");
        assert!(s.contains(&("npm test".to_string(), true, false)));
        assert!(s.contains(&("22×".to_string(), true, false)));
        assert!(s.contains(&("agents".to_string(), false, false)));
        let s = segments("`npm test`: 22×");
        assert_eq!(s[1], (":".to_string(), false, true), "punctuation stays on the command");
        assert_eq!(capitalized("waited 34m on you"), "Waited 34m on you");
    }

    #[test]
    fn a_comparison_shows_each_number_before_and_now() {
        let now = [num("runs", 9), num("totalMs", 19 * 60_000)];
        let before = [num("runs", 22), num("totalMs", 51 * 60_000)];
        assert_eq!(compare_line(&now, &before), "runs 22 → 9 · total 51m → 19m");
        assert_eq!(compare_line(&now[..1], &[]), "runs 0 → 9", "a rule that didn't fire before still shows its number");
        assert_eq!(compare_line(&[num("noEdit", 5), num("peakQueued", 3)], &[]), "no edit 0 → 5 · peak queued 0 → 3");
    }
}
