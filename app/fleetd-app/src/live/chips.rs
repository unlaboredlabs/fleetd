//! Status words with their dot: the order phase chip, the role tag and the PR stage chip. One vocabulary (spec
//! §4): amber is "needs you", danger only on failure words, everything that is just working stays quiet.

use fleetd_contracts::live::{AgentRole, OrderPhase, PrRef};
use fleetd_contracts::train::ChangeState;
use gpui::{Animation, AnimationExt, AnyElement, Div, Hsla, PathBuilder, SharedString, canvas, div, ease_out_quint, point, prelude::*, px};

use super::motion::dur;

use crate::theme::{REGULAR, STRONG, Theme, size};
use crate::ui;

/// The role column's width, so lanes line up down a card.
pub const ROLE_W: f32 = 80.;

pub fn phase_word(phase: OrderPhase) -> &'static str {
    match phase {
        OrderPhase::WaitingOnYou => "needs you",
        OrderPhase::Failed => "failed",
        OrderPhase::Stopped => "stopped",
        OrderPhase::Working => "working",
        OrderPhase::Reviewing => "reviewing",
        OrderPhase::Merging => "merging",
        OrderPhase::Verifying => "checking",
        OrderPhase::Queued => "queued",
        OrderPhase::Planning => "planning",
        OrderPhase::Idle => "waiting for the lead",
        OrderPhase::Done => "done",
    }
}

/// The chip's text: the hub's detail where it reads on its own ("3 working", "#212 in CI"), else the phase word
/// with the detail after it ("needs you · 1 question", "failed: tests").
pub fn phase_label(phase: OrderPhase, detail: Option<&str>) -> String {
    let detail = detail.filter(|d| !d.is_empty());
    match (phase, detail) {
        (_, None) => phase_word(phase).into(),
        (OrderPhase::WaitingOnYou, Some(d)) => format!("needs you · {d}"),
        (OrderPhase::Failed, Some(d)) => format!("failed: {d}"),
        (OrderPhase::Stopped, Some(d)) => format!("stopped: {d}"),
        (_, Some(d)) => d.into(),
    }
}

fn phase_colors(t: &Theme, phase: OrderPhase) -> (Hsla, Hsla) {
    match phase {
        OrderPhase::WaitingOnYou => (t.warning, t.text),
        OrderPhase::Failed => (t.danger, t.danger),
        OrderPhase::Working | OrderPhase::Reviewing | OrderPhase::Merging => (t.text, t.quiet),
        OrderPhase::Stopped | OrderPhase::Verifying | OrderPhase::Queued | OrderPhase::Planning => (t.quiet, t.quiet),
        OrderPhase::Idle => (t.faint, t.quiet),
        OrderPhase::Done => (t.success, t.quiet),
    }
}

pub fn phase_chip(t: &Theme, phase: OrderPhase, detail: Option<&str>) -> Div {
    let (dot, text) = phase_colors(t, phase);
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap_1p5()
        .text_size(px(size::XS))
        .text_color(text)
        .font_weight(if phase == OrderPhase::WaitingOnYou { STRONG } else { REGULAR })
        .whitespace_nowrap()
        .child(ui::dot(dot))
        .child(SharedString::from(phase_label(phase, detail)))
}

pub fn role_word(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Lead => "lead",
        AgentRole::Implementer => "implementer",
        AgentRole::Reader => "reader",
        AgentRole::Reviewer => "reviewer",
        AgentRole::Verifier => "verifier",
        AgentRole::Qa => "qa",
    }
}

/// The role's tint: workers (implementers, readers), reviewers, verifiers (and QA), the lead.
pub fn role_tint(t: &Theme, role: AgentRole) -> Hsla {
    match role {
        AgentRole::Implementer | AgentRole::Reader => t.role_implementer,
        AgentRole::Reviewer => t.role_reviewer,
        AgentRole::Verifier | AgentRole::Qa => t.role_verifier,
        AgentRole::Lead => t.role_lead,
    }
}

/// The role in its tint, the same width down a card so the activity column lines up.
pub fn role_tag(t: &Theme, role: AgentRole, text_size: f32) -> Div {
    div()
        .w(px(ROLE_W))
        .flex_none()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(text_size))
        .text_color(role_tint(t, role))
        .child(role_word(role))
}

/// A finished lane's mark: a check drawn as a path, so it is the same on every font. Sized like a status dot's
/// slot (`size` px square).
pub fn check(color: Hsla, size: f32) -> Div {
    let paint = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let (x, y, s) = (bounds.origin.x, bounds.origin.y, bounds.size.width);
            let mut path = PathBuilder::stroke(px(1.6));
            path.move_to(point(x + s * 0.12, y + s * 0.52));
            path.line_to(point(x + s * 0.40, y + s * 0.80));
            path.line_to(point(x + s * 0.90, y + s * 0.20));
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        },
    );
    div().flex_none().size(px(size)).child(paint.size_full())
}

/// How far along the train a PR is, as three steps: review, CI, merged. `None` for states off the main line
/// (a failure, a refusal), which say so in words instead.
pub fn track_steps(state: ChangeState) -> Option<usize> {
    Some(match state {
        ChangeState::Queued => 0,
        ChangeState::Reviewing | ChangeState::Ready => 1,
        ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging => 2,
        ChangeState::Merged => 3,
        ChangeState::NeedsRebase | ChangeState::CiFailed | ChangeState::Refused | ChangeState::Abandoned => return None,
    })
}

/// The PR's progress as three short segments; the segment it just reached fills in once, keyed by `id` and its
/// state, so a stage change reads as movement. A state off the main line draws nothing.
pub fn pr_track(t: &Theme, id: &str, state: ChangeState) -> AnyElement {
    const SEG: f32 = 10.;
    let Some(done) = track_steps(state) else { return div().into_any_element() };
    let tone = match state {
        ChangeState::Merged => t.success,
        _ => t.quiet,
    };
    let empty = t.hairline;
    let mut row = div().flex().flex_none().items_center().gap(px(2.));
    for i in 0..3 {
        let seg = div().w(px(SEG)).h(px(3.)).rounded(px(1.5)).bg(empty);
        row = row.child(if i + 1 == done {
            // The newest step grows across its slot.
            seg.child(div().h_full().rounded(px(1.5)).bg(tone).with_animation(
                SharedString::from(format!("track-{id}-{state:?}")),
                Animation::new(dur::TRAIN).with_easing(ease_out_quint()),
                |d, p| d.w(px(SEG * p)),
            ))
            .into_any_element()
        } else if i < done {
            seg.bg(tone).into_any_element()
        } else {
            seg.into_any_element()
        });
    }
    row.into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageTone {
    Quiet,
    Warning,
    Danger,
    Success,
}

/// A PR's stage in two words or fewer: "review", "CI", "merged".
pub fn stage_word(state: ChangeState) -> &'static str {
    match state {
        ChangeState::Queued => "queued",
        ChangeState::Reviewing => "review",
        ChangeState::Ready => "ready",
        ChangeState::Rebasing => "rebasing",
        ChangeState::Ci => "CI",
        ChangeState::Merging => "merging",
        ChangeState::Merged => "merged",
        ChangeState::NeedsRebase => "needs rebase",
        ChangeState::CiFailed => "CI failed",
        ChangeState::Refused => "refused",
        ChangeState::Abandoned => "abandoned",
    }
}

pub fn stage_tone(state: ChangeState) -> StageTone {
    match state {
        ChangeState::NeedsRebase => StageTone::Warning,
        ChangeState::CiFailed | ChangeState::Refused => StageTone::Danger,
        ChangeState::Merged => StageTone::Success,
        _ => StageTone::Quiet,
    }
}

pub fn tone_color(t: &Theme, tone: StageTone) -> Hsla {
    match tone {
        StageTone::Quiet => t.quiet,
        StageTone::Warning => t.warning,
        StageTone::Danger => t.danger,
        StageTone::Success => t.success,
    }
}

/// "reviewing 1/2", "in CI", "merged", "queued, position 2".
pub fn pr_label(pr: &PrRef) -> String {
    match pr.state {
        ChangeState::Reviewing => format!("reviewing {}/{}", pr.reviews_done, pr.reviews_needed),
        ChangeState::Ci => "in CI".into(),
        ChangeState::Queued => match pr.position {
            Some(p) => format!("queued, position {}", p.get() + 1),
            None => "queued".into(),
        },
        s => stage_word(s).into(),
    }
}

/// `#212 · reviewing 1/2`: the number in mono, the stage in the UI voice. The caller attaches the click.
pub fn pr_chip(t: &Theme, pr: &PrRef) -> Div {
    let tone = stage_tone(pr.state);
    div()
        .flex()
        .flex_none()
        .items_baseline()
        .gap_1()
        .whitespace_nowrap()
        .text_size(px(size::XS))
        .text_color(t.quiet)
        .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(SharedString::from(format!("#{}", pr.number))))
        .child("·")
        .child(div().text_color(tone_color(t, tone)).child(SharedString::from(pr_label(pr))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_labels_read_like_the_spec() {
        assert_eq!(phase_label(OrderPhase::WaitingOnYou, Some("1 question")), "needs you · 1 question");
        assert_eq!(phase_label(OrderPhase::WaitingOnYou, None), "needs you");
        assert_eq!(phase_label(OrderPhase::Working, Some("3 working")), "3 working");
        assert_eq!(phase_label(OrderPhase::Merging, Some("#212 in CI")), "#212 in CI");
        assert_eq!(phase_label(OrderPhase::Failed, Some("tests failed")), "failed: tests failed");
        assert_eq!(phase_label(OrderPhase::Idle, Some("")), "waiting for the lead");
    }

    #[test]
    fn pr_labels() {
        let pr = |state: &str, pos: Option<i64>| -> PrRef {
            serde_json::from_value(serde_json::json!({
                "changeId": "X12", "repo": "acme/storefront", "number": 212, "url": "https://github.com/acme/storefront/pull/212",
                "state": state, "position": pos, "reviewsDone": 1, "reviewsNeeded": 2
            }))
            .unwrap()
        };
        assert_eq!(pr_label(&pr("reviewing", None)), "reviewing 1/2");
        assert_eq!(pr_label(&pr("ci", None)), "in CI");
        assert_eq!(pr_label(&pr("queued", Some(1))), "queued, position 2");
        assert_eq!(pr_label(&pr("ci_failed", None)), "CI failed");
    }

    #[test]
    fn the_track_follows_the_train_and_steps_off_it_on_failure() {
        assert_eq!(track_steps(ChangeState::Queued), Some(0));
        assert_eq!(track_steps(ChangeState::Ready), Some(1));
        assert_eq!(track_steps(ChangeState::Ci), Some(2));
        assert_eq!(track_steps(ChangeState::Merged), Some(3));
        assert_eq!(track_steps(ChangeState::CiFailed), None);
    }
}
