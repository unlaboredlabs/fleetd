//! Status words with their dot: the order phase chip, the role tag and the PR stage chip. One vocabulary (spec
//! §4): amber is "needs you", danger only on failure words, everything that is just working stays quiet.

use fleetd_contracts::live::{AgentRole, OrderPhase, PrRef};
use fleetd_contracts::train::ChangeState;
use gpui::{Div, Hsla, SharedString, div, prelude::*, px};

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

pub fn role_tag(t: &Theme, role: AgentRole) -> Div {
    div().w(px(ROLE_W)).flex_none().overflow_hidden().whitespace_nowrap().text_size(px(size::XS)).text_color(t.quiet).child(role_word(role))
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
}
