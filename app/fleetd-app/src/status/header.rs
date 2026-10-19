//! The top of the view: the number with its bar and scope markers, the headline (marked generated or template),
//! what has gone stale, what it is waiting on, and since-you-last-looked.

use gpui::{AnyElement, Context, Div, SharedString, div, prelude::*, px};

use super::number;
use fleetd_contracts::status::{HeadlineSource, Marker, StatusDoc};

use super::{stale_words, when};
use crate::shell::{Shell, clock};
use crate::theme::{STRONG, Theme, radius, size, theme};
use crate::ui;

impl Shell {
    pub(super) fn status_hero(&mut self, doc: &StatusDoc, session: u64, live: bool, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let p = &doc.progress;
        let (done, total, polish_done, polish_total) = (p.done.get(), p.total.get(), p.polish_done.get(), p.polish_total.get());
        // The hub sends the polish figure as `pct` when the scope has no must items.
        let pct = (total > 0 || polish_total > 0).then(|| p.pct.get());
        let tween = pct.filter(|_| live).and_then(|pct| self.status_ui.number.update(session, pct));
        let stale = p.stale.as_ref();
        let figure_row = match pct {
            Some(pct) => div()
                .flex()
                .items_center()
                .gap_4()
                .child(number::figure(t, pct, tween))
                .when(!live, |d| {
                    // Not live: said in words at full contrast, beside the last figure, never by fading it.
                    d.child(
                        div()
                            .flex_none()
                            .px_1p5()
                            .rounded(px(radius::SM))
                            .border_1()
                            .border_color(t.warning)
                            .text_size(px(size::XS))
                            .text_color(t.warning)
                            .child(format!("not live · from {}", clock(doc.now.as_str()))),
                    )
                })
                .child(div().flex_1().child(number::bar(t, pct, tween, 6.)))
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .gap_3()
                        .text_size(px(size::XS))
                        .text_color(t.quiet)
                        .child(if total > 0 { format!("{done} of {total} must items verified") } else { "polish only".into() })
                        .when(total > 0 && polish_total > 0, |d| d.child(format!("polish {polish_done}/{polish_total}"))),
                ),
            None => div().py_1().text_color(t.quiet).child(match &doc.virtual_tier {
                Some(tier) => format!("No plan items: this order counts as one {} item until it is verified.", crate::shell::wire_label(tier)),
                None => "No plan items yet: nothing to count. The lead adds them with fleetd plan add.".into(),
            }),
        };
        let figure_block = div().flex().flex_col().gap_1().child(figure_row).when_some(stale, |d, s| {
            d.p_2().rounded(px(radius::MD)).border_1().border_color(t.warning).child(
                div().text_size(px(size::XS)).text_color(t.warning).whitespace_normal().child(format!(
                    "{} · progress as of {}",
                    stale_words(s, now),
                    clock(p.as_of.as_str())
                )),
            )
        });
        let mut markers: Vec<&Marker> = doc.markers.iter().take(3).collect();
        if markers.is_empty()
            && let Some(m) = &p.marker
        {
            markers.push(m);
        }
        let marker_lines = markers.into_iter().map(|m| marker_line(t, m, now));
        div()
            .pt_6()
            .pb_4()
            .flex()
            .flex_col()
            .gap_2()
            .child(figure_block)
            .children(marker_lines)
            .child(self.status_headline(doc, now, cx))
            .children(stale_block(t, doc, now))
            .children(waiting_on(t, doc))
            .child(since_line(t, doc))
            .into_any_element()
    }

    fn status_headline(&mut self, doc: &StatusDoc, now: i64, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let h = &doc.headline;
        let (tag, detail) = match h.source {
            HeadlineSource::Generated => ("generated".to_string(), format!("written {}", when(h.at.as_str(), now))),
            HeadlineSource::Template => ("template".to_string(), h.reason.as_deref().map_or("no generated line yet".into(), str::to_string)),
        };
        let prompt = ui::clickable(t, div().id("status-headline-prompt"))
            .flex_none()
            .flex()
            .items_center()
            .gap_1p5()
            .px_1()
            .rounded(px(radius::SM))
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .hover(|s| s.underline())
            .child(div().text_color(t.text).child(tag))
            .child(detail)
            .child(div().text_color(t.accent).child("prompt"))
            .on_click(cx.listener(|this, _, _, cx| {
                this.go(crate::shell::Screen::Settings);
                this.settings_section = crate::settings::Section::Prompts;
                this.open_prompts(None, cx);
                this.select_prompt(fleetd_contracts::prompts::PromptId::unchecked("status.headline"), cx);
                cx.notify();
            }));
        div()
            .pt_1()
            .flex()
            .items_baseline()
            .gap_4()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_normal()
                    .text_size(px(size::MD))
                    .font_weight(STRONG)
                    .child(SharedString::from(h.text.to_string())),
            )
            .child(prompt)
    }
}

/// "↓ from 80% · +3 items: time inspector added · 10:00". A drop is said in the warning tone.
fn marker_line(t: &Theme, m: &Marker, now: i64) -> Div {
    let (arrow, color) = match (m.pct_before.map(|p| p.get()), m.pct_after.map(|p| p.get())) {
        (Some(b), Some(a)) if a < b => (format!("↓ from {b}%"), t.warning),
        (Some(b), Some(a)) if a > b => (format!("↑ from {b}%"), t.quiet),
        _ => (String::new(), t.quiet),
    };
    div()
        .flex()
        .gap_2()
        .text_size(px(size::XS))
        .text_color(t.quiet)
        .when(!arrow.is_empty(), |d| d.child(div().text_color(color).font_weight(STRONG).child(arrow)))
        .child(SharedString::from(format!("{} · {}", &*m.text, when(m.at.as_str(), now))))
}

/// Every source the hub says went quiet, with its reason and age: the parts that depend on it are outlined too.
fn stale_block(t: &Theme, doc: &StatusDoc, now: i64) -> Option<Div> {
    if doc.stale.is_empty() {
        return None;
    }
    let lines = doc.stale.iter().map(|s| {
        let since = super::ms(s.since.as_str())
            .map(|at| format!("stale {} · since {}", super::age(now - at), clock(s.since.as_str())))
            .unwrap_or_else(|| "stale".into());
        div()
            .flex()
            .items_baseline()
            .gap_2()
            .child(ui::dot(t.warning))
            .child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(SharedString::from(s.source.to_string())))
            .child(div().flex_1().min_w_0().whitespace_normal().child(SharedString::from(s.reason.to_string())))
            .child(div().flex_none().text_color(t.warning).child(since))
    });
    Some(
        div()
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .rounded(px(radius::MD))
            .border_1()
            .border_color(t.warning)
            .text_size(px(size::XS))
            .text_color(t.text)
            .children(lines),
    )
}

/// What the scope is waiting on, in order. Never a time estimate: fleetd shows state, not finish times.
fn waiting_on(t: &Theme, doc: &StatusDoc) -> Option<Div> {
    (!doc.gates.is_empty()).then(|| {
        div().flex().gap_2().text_size(px(size::XS)).child(div().flex_none().text_color(t.quiet).child("waiting on")).child(
            div().flex_1().min_w_0().whitespace_normal().text_color(t.text).child(
                doc.gates
                    .iter()
                    .map(|g| if g.serial { format!("{} (serial)", &*g.label) } else { g.label.to_string() })
                    .collect::<Vec<_>>()
                    .join(" → "),
            ),
        )
    })
}

/// "Since you looked (09:12): 7 merged · 3 verified · 2 started · 1 failed · +3 items". Zero counts are left out.
fn since_line(t: &Theme, doc: &StatusDoc) -> Div {
    let s = &doc.since;
    let counts: Vec<(i64, &str, bool)> = vec![
        (s.merged.get(), "merged", false),
        (s.verified.get(), "verified", false),
        (s.started.get(), "started", false),
        (s.failed.get(), "failed", true),
        (s.asked.get(), "asked", false),
    ];
    let mut parts: Vec<(String, bool)> = counts.into_iter().filter(|(n, _, _)| *n != 0).map(|(n, w, bad)| (format!("{n} {w}"), bad)).collect();
    let items = s.scope_items.get();
    if items != 0 {
        parts.push((format!("{items:+} item{}", if items.abs() == 1 { "" } else { "s" }), false));
    }
    let lead = match (&s.seen_at, s.pruned.unwrap_or(false)) {
        (_, true) => "Since more than 30 days ago:".to_string(),
        (Some(at), false) => format!("Since you looked ({}):", at.as_str().get(11..16).unwrap_or(at.as_str())),
        (None, false) => "Since you first opened this:".to_string(),
    };
    let body = if parts.is_empty() {
        div().text_color(t.quiet).child("nothing new").into_any_element()
    } else {
        div()
            .flex()
            .gap_2()
            .children(parts.into_iter().enumerate().map(|(i, (p, bad))| {
                div()
                    .flex()
                    .gap_2()
                    .when(i > 0, |d| d.child(div().text_color(t.quiet).child("·")))
                    .text_color(if bad { t.danger } else { t.text })
                    .child(p)
            }))
            .into_any_element()
    };
    div().pt_1().flex().gap_2().text_size(px(size::XS)).child(div().text_color(t.quiet).child(lead)).child(body)
}
