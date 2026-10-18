//! The stage: when the board has one active order, that order takes the board instead of sitting as one card
//! above empty space. The title leads, the lead's line sits under it, then the fleet (`Density::Stage`: the line
//! that counts what it is doing and the order's clock, the writers, each PR with its checkers, and the finish).
//! Shared by the board and the fixture window, so screenshots show the real thing.

use fleetd_contracts::live::{AgentLane, AgentRole, LaneStatus, LiveLane, OrderCard, OrderPhase, PrRef};
use fleetd_contracts::prim::Text;
use gpui::{AnyElement, App, ClickEvent, Div, Entity, SharedString, Window, div, prelude::*, px};

use super::activity::{describe, render_at};
use super::chips::{phase_chip, pr_label, pr_review, pr_track, role_tag, stage_tone, tone_color};
use super::lanes::FleetLanes;
use crate::theme::{STRONG, Theme, size};

/// The widest the stage gets where nothing else sets its width: past this a lane's activity and its figures drift
/// too far apart to read as one row.
pub const STAGE_W: f32 = 980.;

/// What clicking the stage's title does.
pub type OnOpen = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

pub struct Stage<'a> {
    pub card: &'a OrderCard,
    /// The order's lanes with their live values (`LiveState::lanes`).
    pub agents: &'a [AgentLane],
    pub lanes: Entity<FleetLanes>,
    /// The project's lead, with its live values, when the feed has it.
    pub lead: Option<AgentLane>,
    /// The lead's state in words ("lead idle"), for when it has no live line.
    pub lead_state: Option<&'a str>,
    /// Clicking the title opens the order.
    pub on_open: Option<OnOpen>,
}

/// A project's lead as a lane, from its live values (the board feed carries the lead though no card lists it).
pub fn lead_lane(live: &LiveLane) -> AgentLane {
    AgentLane {
        lane_id: live.lane_id.clone(),
        role: AgentRole::Lead,
        task_id: None,
        thread_ref: None,
        title: Text::unchecked("lead"),
        model: None,
        effort: None,
        status: live.status,
        status_reason: None,
        started_at: None,
        ended_at: None,
        branch: None,
        pr: None,
        receipts: None,
        live: Some(live.clone()),
    }
}

/// An order whose agents are still at work: its fleet line speaks for it, so the hub's phase words and the lead's
/// "next" note (both of which lag the lanes) stay out of the way.
pub fn agents_at_work(lanes: &[AgentLane]) -> bool {
    lanes.iter().any(|l| l.role != AgentRole::Lead && !super::state::is_final(l.status))
}

/// The lead's "next" note, only while nothing else speaks for the order: no agent at work and no PR yet. Once
/// there are PRs, their groups and the finish say where the order is, and the note (written before them) lags.
pub fn lead_note<'a>(next: Option<&'a str>, lanes: &[AgentLane], prs: &[PrRef]) -> Option<&'a str> {
    next.filter(|_| !agents_at_work(lanes) && prs.is_empty())
}

pub fn stage(t: &Theme, s: Stage) -> Div {
    let card = s.card;
    let busy = agents_at_work(s.agents);
    // The fleet and its PR groups say where a working or merging order is; the chip speaks only for what they
    // can't: it needs you, it failed or stopped, or nothing has started.
    let quiet = matches!(card.phase, OrderPhase::Working | OrderPhase::Reviewing | OrderPhase::Merging | OrderPhase::Verifying | OrderPhase::Done)
        || (busy && card.phase == OrderPhase::Idle)
        || (!card.prs.is_empty() && card.phase == OrderPhase::Idle);
    let chip = (!quiet).then(|| phase_chip(t, card.phase, card.phase_detail.as_deref()));
    let title = div()
        .id(SharedString::from(format!("stage-title-{}", card.workstream_id)))
        .when(s.on_open.is_some(), |d| d.cursor_pointer())
        .flex()
        .items_baseline()
        .gap_3()
        .child(div().flex_none().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.quiet).child(card.workstream_id.to_string()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(size::LG))
                .font_weight(STRONG)
                .text_color(t.text)
                .child(card.title.to_string()),
        )
        .children(chip);
    let title = match s.on_open {
        Some(f) => title.on_click(f),
        None => title,
    };
    let lead = lead_line(t, s.lead.as_ref(), s.lead_state, lead_note(card.next.as_deref(), s.agents, &card.prs));
    // The fleet lays itself out at its own height: no fixed box that could clip a row the header counts.
    div()
        .w_full()
        .flex()
        .flex_col()
        .child(div().px_2().child(title))
        .child(div().px_2().pt_1().child(lead))
        .child(div().mt_3().border_t_1().border_color(t.hairline))
        .child(s.lanes)
}

/// "lead  running fleetd brief freeze …", or its state in words; with the lead's next step only when no agent is
/// at work, since while they are it lags behind them.
fn lead_line(t: &Theme, lead: Option<&AgentLane>, state: Option<&str>, next: Option<&str>) -> Div {
    let said = lead.map(|l| (describe(l), matches!(l.status, LaneStatus::Working | LaneStatus::Starting)));
    div()
        .h(px(24.))
        .w_full()
        .overflow_hidden()
        .flex()
        .items_center()
        .gap_2()
        .child(role_tag(t, AgentRole::Lead, size::SM).w(px(40.)))
        .child(match said {
            Some((line, working)) => render_at(t, &line, false, size::MD, working).flex_1(),
            None => div().text_color(t.quiet).child(SharedString::from(state.unwrap_or("no lead").trim_start_matches("lead ").to_string())),
        })
        .when_some(next, |d, n| {
            d.child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(t.quiet)
                    .child(SharedString::from(format!("· next: {n}"))),
            )
        })
}

/// `#212 ▬▬▭ in CI`: the number, how far along the train it is, and the stage in words.
pub fn pr_progress(t: &Theme, pr: &PrRef) -> AnyElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .whitespace_nowrap()
        .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).text_color(t.text).child(SharedString::from(format!("#{}", pr.number))))
        .child(pr_track(t, pr.change_id.as_str(), pr.state, pr_review(pr)))
        .child(div().text_size(px(size::XS)).text_color(tone_color(t, stage_tone(pr.state))).child(SharedString::from(pr_label(pr))))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fleet_speaks_while_any_agent_but_the_lead_is_at_work() {
        let mut lanes = crate::live::fixture::order_fixture().order.lanes.to_vec();
        assert!(agents_at_work(&lanes));
        for l in &mut lanes {
            l.status = LaneStatus::Done;
        }
        assert!(!agents_at_work(&lanes));
        lanes[0].status = LaneStatus::Working;
        lanes[0].role = AgentRole::Lead;
        assert!(!agents_at_work(&lanes), "the lead alone is not the fleet");
    }

    #[test]
    fn the_leads_note_waits_while_agents_or_prs_are_moving() {
        let order = crate::live::fixture::order_fixture().order;
        let mut lanes = order.lanes.to_vec();
        let mut prs = order.prs.to_vec();
        let note = Some("merge after one clean review");
        assert_eq!(lead_note(note, &lanes, &prs), None, "agents at work");
        lanes.iter_mut().for_each(|l| l.status = LaneStatus::Done);
        assert_eq!(lead_note(note, &lanes, &prs), None, "its PRs speak for it");
        prs.clear();
        assert_eq!(lead_note(note, &lanes, &prs), note, "nothing else to say");
    }
}
