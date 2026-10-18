//! The steer box on every agent: clicking a lane in the order view (or the lead's activity line) opens this sheet
//! with the agent's role, what it is doing now, its last items, your steers to it with their receipts, and a
//! composer aimed at it with the same two keys. Esc or a click outside closes it.

use fleetd_contracts::live::{AgentLane, AgentRole};
use fleetd_contracts::mcp::{TailItem, TailRole};
use gpui::{AnyElement, Context, Entity, Focusable, Subscription, Window, div, prelude::*, px};

use super::receipts::{self, Act};
use super::{Agent, SteerTarget};
use crate::composer::{Composer, ComposerEvent, Placement};
use crate::order::{OnSteer, receipt_line};
use crate::shell::{Shell, clip, clock};
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};

const WIDTH: f32 = 720.;

pub struct SteerSheet {
    pub agent: Agent,
    pub composer: Entity<Composer>,
    _sub: Subscription,
}

pub fn role_label(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Lead => "lead",
        AgentRole::Implementer => "implementer",
        AgentRole::Reader => "reader",
        AgentRole::Reviewer => "reviewer",
        AgentRole::Verifier => "verifier",
        AgentRole::Qa => "qa",
    }
}

/// The agent a lane is, as a steer target. A lane with no task (the lead's) steers the order's lead.
pub fn agent_of(lane: &AgentLane, workstream_id: &str) -> Agent {
    let target = match &lane.task_id {
        Some(t) if lane.role != AgentRole::Lead => SteerTarget::Task { task_id: t.clone() },
        _ => SteerTarget::Lead { workstream_id: fleetd_contracts::ledger::WorkstreamId::unchecked(workstream_id) },
    };
    let name = match &target {
        SteerTarget::Task { task_id } => task_id.to_string(),
        SteerTarget::Lead { .. } => "the lead".to_string(),
    };
    Agent { target, name, role: role_label(lane.role).into(), lane_id: lane.lane_id.to_string(), thread: lane.thread_ref.clone() }
}

impl Shell {
    /// The open order's lead as a steer target.
    pub(crate) fn lead_agent(&self) -> Option<Agent> {
        let order = self.state.order.as_ref()?;
        let w = order.workstream_id.clone();
        let lane = self.state.live.lead(&fleetd_contracts::ledger::WorkstreamId::unchecked(&w));
        let thread = lane.as_ref().and_then(|l| l.thread_ref.clone()).or_else(|| {
            let key = order.key.as_ref()?;
            let lead = self.state.project(key)?.lead()?;
            Some(fleetd_contracts::ids::ThreadRef {
                machine_id: fleetd_contracts::ids::MachineId::unchecked(key.0.as_str()),
                thread_id: lead.thread_id.clone(),
            })
        });
        Some(Agent {
            target: SteerTarget::Lead { workstream_id: fleetd_contracts::ledger::WorkstreamId::unchecked(&w) },
            name: "the lead".into(),
            role: "lead".into(),
            lane_id: lane.map(|l| l.lane_id.to_string()).unwrap_or_default(),
            thread,
        })
    }

    /// A lane of the open order was clicked.
    pub(crate) fn open_lane_sheet(&mut self, lane_id: &str, cx: &mut Context<Self>) {
        let Some(w) = self.state.order.as_ref().map(|o| o.workstream_id.clone()) else { return };
        let lanes = self.state.live.lanes(&fleetd_contracts::ledger::WorkstreamId::unchecked(&w));
        let agent = match lanes.iter().find(|l| l.lane_id == lane_id) {
            Some(lane) if lane.role != AgentRole::Lead => agent_of(lane, &w),
            _ => match self.lead_agent() {
                Some(a) => a,
                None => return,
            },
        };
        self.open_steer_sheet(agent, cx);
    }

    pub(crate) fn open_steer_sheet(&mut self, agent: Agent, cx: &mut Context<Self>) {
        self.palette = None;
        self.floating = None;
        self.state.prompts.told = None;
        let composer = cx.new(|cx| Composer::new(Placement::Agent, cx));
        let who = if agent.is_lead() { "the lead".to_string() } else { agent.name.clone() };
        composer.update(cx, |c, cx| c.set_agent(&who, cx));
        let sub = cx.subscribe(&composer, |this, composer, event: &ComposerEvent, cx| this.on_sheet_composer(&composer, event, cx));
        let out = self.state.open_agent_tail(agent.thread.clone());
        self.send_steer(out, cx);
        self.pending_focus = Some(composer.focus_handle(cx));
        self.steer_sheet = Some(SteerSheet { agent, composer, _sub: sub });
        self.sync_composers(cx);
        cx.notify();
    }

    fn on_sheet_composer(&mut self, composer: &Entity<Composer>, event: &ComposerEvent, cx: &mut Context<Self>) {
        match event {
            ComposerEvent::Steer { draft, mode } => {
                let Some(target) = self.steer_sheet.as_ref().filter(|s| &s.composer == composer).map(|s| s.agent.target.clone()) else { return };
                let id = format!("steer-{}", crate::shell::now_ms());
                let out = self.state.steer(target, &draft.text, *mode, draft.attachments.clone(), draft.refs.clone(), &id);
                self.send_steer(out, cx);
                self.sync_conversation(cx);
            }
            ComposerEvent::Dismiss => self.close_steer_sheet(cx),
            ComposerEvent::Upload { local, name, mime, data_b64 } => {
                let out = self.state.attach(*local, name, mime, data_b64.clone());
                self.send(out);
            }
            ComposerEvent::Files { key, query } => {
                let out = self.state.list_files(key, query);
                self.send(out);
            }
            ComposerEvent::Send(_) | ComposerEvent::Preview(_) | ComposerEvent::AddProject(_) => {}
        }
        self.sync_composers(cx);
        cx.notify();
    }

    /// Sends steer calls; the bench, which has no hub, answers them from the fixture.
    pub(crate) fn send_steer(&mut self, out: crate::state::Out, cx: &mut Context<Self>) {
        if self.bench.is_none() {
            return self.send(out);
        }
        let mut queue: std::collections::VecDeque<_> = out.into();
        while let Some(message) = queue.pop_front() {
            let Some(reply) = super::fixture::answer(&message, &self.state) else { continue };
            queue.extend(self.state.apply(crate::client::Incoming::Message(reply)));
        }
        cx.notify();
    }

    pub(crate) fn close_steer_sheet(&mut self, cx: &mut Context<Self>) {
        if self.steer_sheet.take().is_some() {
            self.state.agent_tail = None;
            self.pending_focus = Some(self.follow.focus_handle(cx));
            cx.notify();
        }
    }

    /// A receipt's withdraw or "interrupt and redirect" again.
    pub(crate) fn steer_act(&mut self, act: Act, cx: &mut Context<Self>) {
        let out = match act {
            Act::Withdraw(id) => self.state.withdraw_steer(&id),
            Act::Redirect(id) => self.state.redirect_steer(&id, &format!("steer-{}", crate::shell::now_ms())),
        };
        self.send_steer(out, cx);
        self.sync_conversation(cx);
        cx.notify();
    }

    pub(crate) fn steer_sheet_view(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sheet = self.steer_sheet.as_ref()?;
        let agent = &sheet.agent;
        let t = &theme(cx).clone();
        let w = self.state.order.as_ref().map(|o| o.workstream_id.clone()).unwrap_or_default();
        let height = (window.viewport_size().height - px(140.)).min(px(760.));
        let lanes = self.state.live.lanes(&fleetd_contracts::ledger::WorkstreamId::unchecked(&w));
        let lane = lanes.iter().find(|l| !agent.lane_id.is_empty() && l.lane_id == agent.lane_id.as_str()).cloned();
        let title = if agent.is_lead() { format!("Steer the lead of {w}") } else { format!("Steer {}", agent.name) };
        let close = ui::button(t, "steer-close", "Close", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| this.close_steer_sheet(cx)));
        let head = div()
            .flex_none()
            .px_4()
            .h(px(metric::BAR))
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.hairline)
            .child(div().min_w_0().font_weight(STRONG).child(title))
            .child(
                div()
                    .px_1p5()
                    .rounded(px(crate::theme::radius::SM))
                    .bg(t.selected)
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(agent.role.clone()),
            )
            .child(div().flex_1())
            .child(close);
        let caption = |text: &'static str| div().pt_3().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(text);
        // What it is doing now, and the line for a steer still waiting on its step.
        let mut now = div().pt_3().flex().flex_col().gap_1();
        if let Some(lane) = &lane {
            now = now.child(crate::live::activity::activity_line(t, lane));
            let mine: Vec<_> = self.state.steers.iter().filter(|s| s.target == agent.target).collect();
            if let Some(line) = receipts::waiting_line(mine, lane, &agent.possessive(), self.state.live.hub_now_ms(crate::shell::now_ms())) {
                now = now.child(div().text_size(px(size::XS)).text_color(t.quiet).child(line));
            }
        }
        if !agent.is_lead() {
            now = now.child(div().text_size(px(size::XS)).text_color(t.quiet).whitespace_normal().child(format!(
                "The lead is told when you steer {} directly, so its plan and its own messages to {} stay in line.",
                agent.name, agent.name
            )));
        }
        // Its last items.
        let mut recent = div().id("steer-recent").flex_1().min_h(px(80.)).overflow_y_scroll().flex().flex_col().gap_1();
        match &self.state.agent_tail {
            None => recent = recent.child(ui::quiet(t, "This agent has no session yet.")),
            Some(tail) if !tail.loaded => recent = recent.child(ui::loading(t, "Loading its recent items…")),
            Some(tail) if tail.error.is_some() => {
                recent = recent.child(div().text_color(t.danger).child(tail.error.clone().unwrap_or_default()));
            }
            Some(tail) if tail.items.is_empty() => recent = recent.child(ui::quiet(t, "Nothing yet.")),
            Some(tail) => {
                for item in &tail.items {
                    recent = recent.child(match item {
                        TailItem::Message(m) => {
                            let who = match m.role {
                                TailRole::User => "To it",
                                TailRole::Assistant => "It said",
                                TailRole::System => "System",
                            };
                            div()
                                .flex()
                                .gap_3()
                                .text_size(px(size::XS))
                                .child(div().w(px(52.)).flex_none().text_color(t.quiet).child(clock(m.at.as_str()).to_string()))
                                .child(div().w(px(44.)).flex_none().text_color(t.quiet).child(who))
                                .child(div().flex_1().min_w_0().whitespace_normal().child(clip(m.text.as_str(), 280)))
                        }
                        TailItem::Action(a) => div()
                            .flex()
                            .gap_3()
                            .text_size(px(size::XS))
                            .child(div().w(px(52.)).flex_none().text_color(t.quiet).child(clock(a.at.as_str()).to_string()))
                            .child(div().w(px(44.)).flex_none())
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .font_family(t.mono_font.clone())
                                    .text_size(px(size::SM))
                                    .text_color(if a.action.failed { t.danger } else { t.quiet })
                                    .child(a.action.summary.to_string()),
                            ),
                    });
                }
            }
        }
        // Your steers to it, newest last, with their receipts.
        let shell = cx.entity().downgrade();
        let on_steer: OnSteer = std::rc::Rc::new(move |act, cx| {
            shell.update(cx, |this, cx| this.steer_act(act, cx)).ok();
        });
        let mut steers = div().flex().flex_col().gap_2();
        let mut any = false;
        for (i, s) in self.state.steers.iter().filter(|s| s.target == agent.target).enumerate() {
            any = true;
            steers = steers.child(div().flex().flex_col().child(div().whitespace_normal().child(s.text.to_string())).child(receipt_line(
                t,
                ("sheet-receipt", i),
                &receipts::receipt(s),
                &on_steer,
            )));
        }
        for (i, s) in self.state.steer_sends.iter().filter(|s| s.target == agent.target).enumerate() {
            any = true;
            steers = steers.child(div().flex().flex_col().child(div().whitespace_normal().child(s.text.clone())).child(receipt_line(
                t,
                ("sheet-sending", i),
                &receipts::sending(s),
                &on_steer,
            )));
        }
        let mut body = div().flex_1().min_h_0().px_4().pb_4().flex().flex_col().gap_1().child(now).child(caption("RECENT")).child(recent);
        if any {
            body = body.child(caption("YOUR STEERS")).child(steers);
        }
        body = body.child(div().pt_3().border_t_1().border_color(t.hairline).child(sheet.composer.clone()));
        Some(
            ui::floating(t)
                .w(px(WIDTH))
                .h(height)
                .flex()
                .flex_col()
                .text_size(px(size::MD))
                .text_color(t.text)
                .child(head)
                .child(body)
                .into_any_element(),
        )
    }
}
