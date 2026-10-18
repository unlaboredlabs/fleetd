//! The inbox (spec 2.5): a 360 px panel over the right of the window (⌘I, the title-bar badge, or "⌘I all"),
//! holding every open ask with one-tap answers and the terse reply field ("1 go 2 nvm"). The board's needs-you
//! strip and the order view show slices of the same asks with the same blocks; answering anywhere clears all.
//! Keys while the panel is open and its reply field isn't focused: 1..9 pick an ask, Enter takes the
//! recommendation, n answers No, Tab moves into the reply field.

use fleetd_contracts::ledger::{Ask, AskClass, AskKind, BatchId};
use gpui::{AnyElement, Context, Div, Focusable, KeyDownEvent, SharedString, Window, div, prelude::*, px};

use crate::input::InputEvent;
use crate::links;
use crate::shell::{Shell, clip, wire_label};
use crate::state::InboxItem;
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};

pub const PANEL_WIDTH: f32 = 360.;

/// How much of an ask block to show: the panel and order view show everything, the board's strip the
/// question and its buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    Full,
    Strip,
}

/// The raw reply that answers ask `number` with its recommendation (`go`), or No.
fn quick(number: i64, accept: bool) -> String {
    format!("{number} {}", if accept { "go" } else { "no" })
}

impl Shell {
    pub(crate) fn inbox_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let items = self.state.inbox();
        let n = items.len();
        let mut body = div().id("inbox-panel-body").flex_1().min_h_0().overflow_y_scroll().px_4().pb_4().flex().flex_col();
        if let Some(e) = self.state.asks_error.clone() {
            body = body.child(div().pt_3().child(self.error_line("copy-asks-error", e, None, cx)));
        }
        if items.is_empty() && self.state.asks_error.is_none() {
            body = body.child(div().py_4().text_color(t.quiet).child("Nothing needs you."));
        }
        let focus = self.inbox_pick;
        let blocks: Vec<(BatchId, i64, Ask)> = items.iter().map(|i| (i.batch_id.clone(), i.number, i.ask.clone())).collect();
        for (ix, (batch, number, ask)) in blocks.iter().enumerate() {
            let marked = focus == Some(ix) || self.focus_ask.as_deref() == Some(ask.ask_id.as_str());
            body = body.child(self.ask_block(batch, *number, ask, Fit::Full, marked, cx));
        }
        let reply_focused = self.reply.focus_handle(cx).is_focused(window);
        let has_text = !self.reply.read(cx).is_empty();
        let close = ui::button(t, "inbox-close", "×", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(false, cx)));
        div()
            .id("inbox-panel")
            .track_focus(&self.inbox_focus)
            .occlude()
            .w(px(PANEL_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .bg(t.raised)
            .border_l_1()
            .border_color(t.border)
            .shadow(t.float_shadow())
            .on_key_down(cx.listener(Self::on_inbox_key))
            .child(
                div()
                    .h(px(metric::BAR))
                    .flex_none()
                    .px_4()
                    .flex()
                    .items_center()
                    .gap_2()
                    .border_b_1()
                    .border_color(t.hairline)
                    .child(div().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(format!("NEEDS YOU {n}")))
                    .child(div().flex_1())
                    .child(ui::kbd(t, ui::shortcut("I")))
                    .child(close),
            )
            .child(body)
            .child(
                div()
                    .flex_none()
                    .p_3()
                    .flex()
                    .items_end()
                    .gap_2()
                    .border_t_1()
                    .border_color(t.hairline)
                    .child(ui::field(t, reply_focused).flex_1().min_w_0().px_1().child(self.reply.clone()))
                    .when(has_text, |d| {
                        d.child(
                            ui::button(t, "send-reply", "Send", Variant::Primary, true)
                                .mb(px(2.))
                                .on_click(cx.listener(|this, _, _, cx| this.send_reply(cx))),
                        )
                    }),
            )
            .into_any_element()
    }

    /// 1..9 pick, Enter takes the recommendation, n answers No, Esc closes. Typing in the reply field is left alone.
    fn on_inbox_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.reply.focus_handle(cx).is_focused(window) {
            return;
        }
        let ks = &event.keystroke;
        if ks.modifiers.control || ks.modifiers.platform || ks.modifiers.alt {
            return;
        }
        let items: Vec<(BatchId, i64, bool)> =
            self.state.inbox().iter().map(|i| (i.batch_id.clone(), i.number, i.ask.recommendation.is_some())).collect();
        match ks.key.as_str() {
            k @ ("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9") => {
                let ix = k.parse::<usize>().unwrap_or(1) - 1;
                if ix < items.len() {
                    self.inbox_pick = Some(ix);
                }
            }
            "enter" | "n" => {
                let Some((batch, number, has_rec)) = self.inbox_pick.and_then(|ix| items.get(ix).cloned()) else { return };
                let accept = ks.key == "enter";
                if accept && !has_rec {
                    return;
                }
                self.quick_reply(batch, quick(number, accept), cx);
            }
            "escape" => self.toggle_inbox(false, cx),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    pub(crate) fn toggle_inbox(&mut self, open: bool, cx: &mut Context<Self>) {
        self.inbox_open = open;
        self.inbox_pick = open.then_some(0).filter(|_| !self.state.inbox().is_empty());
        if open {
            // Its own focus, so 1..9, Enter and n reach it while nothing in it is being typed in.
            self.pending_focus = Some(self.inbox_focus.clone());
        } else {
            self.focus_composer(cx);
        }
        cx.notify();
    }

    /// The board's needs-you strip: at most two asks in full, then "+N more".
    pub(crate) fn needs_you_strip(&self, cx: &mut Context<Self>) -> Option<Div> {
        let t = &theme(cx).clone();
        let items = self.state.inbox();
        if items.is_empty() {
            return None;
        }
        let n = items.len();
        let shown: Vec<(BatchId, i64, Ask)> = items.iter().take(2).map(|i| (i.batch_id.clone(), i.number, i.ask.clone())).collect();
        let mut strip = div().pt_6().flex().flex_col().child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .text_size(px(size::XS))
                .font_weight(STRONG)
                .text_color(t.quiet)
                .child(format!("NEEDS YOU {n}"))
                .child(div().flex_1())
                .child(
                    ui::button(
                        t,
                        "strip-all",
                        if n > 2 { format!("+{} more {}", n - 2, ui::shortcut("I")) } else { format!("{} all", ui::shortcut("I")) },
                        Variant::Ghost,
                        true,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(true, cx))),
                ),
        );
        for (batch, number, ask) in &shown {
            strip = strip.child(self.ask_block(batch, *number, ask, Fit::Strip, false, cx));
        }
        Some(strip)
    }

    /// One order's asks, above its follow-up composer.
    pub(crate) fn order_asks(&self, workstream_id: &str, cx: &mut Context<Self>) -> Option<Div> {
        let t = &theme(cx).clone();
        let items: Vec<(BatchId, i64, Ask)> =
            self.state.order_asks(workstream_id).iter().map(|i: &InboxItem| (i.batch_id.clone(), i.number, i.ask.clone())).collect();
        if items.is_empty() {
            return None;
        }
        let n = items.len();
        let mut col = div().flex().flex_col().child(
            div().pt_2().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(format!("NEEDS YOU {n}/{}", self.state.inbox().len())),
        );
        for (batch, number, ask) in &items {
            col = col.child(self.ask_block(batch, *number, ask, Fit::Strip, false, cx));
        }
        Some(col)
    }

    /// One ask, set loud: the question at full weight, its context quiet, the recommended answer as the one
    /// filled button (outlined red when the call is irreversible).
    pub(crate) fn ask_block(&self, batch_id: &BatchId, number: i64, ask: &Ask, fit: Fit, marked: bool, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let mut context = Vec::new();
        if let Some(p) = &ask.project_ref {
            context.push(p.project_id.to_string());
        }
        if let Some(w) = &ask.workstream_id {
            context.push(w.to_string());
        }
        if ask.project_ref.is_none() {
            context.push("no project yet".into());
        }
        let class_color = match ask.class {
            AskClass::Money | AskClass::Irreversible => t.danger,
            AskClass::Credential => t.warning,
            _ => t.quiet,
        };
        let reply = |label: String, raw: String, variant: Variant, cx: &mut Context<Self>| {
            let batch_id = batch_id.clone();
            ui::button(t, SharedString::from(format!("{}-{number}-{raw}-{fit:?}", ask.ask_id)), label, variant, true)
                .on_click(cx.listener(move |this, _, _, cx| this.quick_reply(batch_id.clone(), raw.clone(), cx)))
        };
        let mut buttons = div().flex().flex_wrap().items_center().gap_2().pt_1();
        match ask.kind {
            AskKind::Approve => {
                buttons = buttons.child(reply("Approve".into(), format!("{number} go"), Variant::Primary, cx)).child(reply(
                    "Reject".into(),
                    format!("{number} no"),
                    Variant::Secondary,
                    cx,
                ));
            }
            AskKind::Secret => buttons = buttons.child(reply("Decline".into(), format!("{number} no"), Variant::Ghost, cx)),
            _ => {
                if ask.kind == AskKind::Do {
                    buttons = buttons.child(reply("Done".into(), format!("{number} done"), Variant::Primary, cx));
                } else if let Some(rec) = &ask.recommendation {
                    // An irreversible call is never the filled, easy button.
                    let variant = if ask.class == AskClass::Irreversible { Variant::Danger } else { Variant::Primary };
                    buttons = buttons
                        .child(reply(clip(rec, 48), format!("{number} go"), variant, cx))
                        .child(div().text_size(px(size::XS)).text_color(t.quiet).child("recommended"));
                }
                for (i, option) in ask.options.iter().flatten().enumerate().take(6) {
                    if ask.recommendation.as_deref() == Some(option.as_str()) {
                        continue;
                    }
                    let letter = (b'a' + i as u8) as char;
                    buttons = buttons.child(reply(clip(option, 48), format!("{number} {letter}"), Variant::Secondary, cx));
                }
                buttons = buttons.child(reply("No".into(), format!("{number} no"), Variant::Ghost, cx));
            }
        }
        let workspace = ask
            .project_ref
            .as_ref()
            .and_then(|p| self.state.project(&(p.machine_id.to_string(), p.project_id.to_string())))
            .map(|r| r.summary.workspace_root.clone());
        let on_open = self.link_opener(workspace, cx);
        let full = fit == Fit::Full;
        let mut block = div()
            .py_3()
            .flex()
            .flex_col()
            .gap_1()
            .when(full, |d| d.border_b_1().border_color(t.hairline))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .items_center()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .when(marked, |d| d.child(ui::unread(t)))
                    .child(div().font_family(t.mono_font.clone()).child(format!("{number}")))
                    .child(div().text_color(class_color).child(wire_label(&ask.class)))
                    .child(context.join(" · "))
                    .when(full && ask.proceeded_on_rec, |d| d.child("· went ahead on the recommendation"))
                    .when(ask.blocks != "nothing", |d| d.child(div().text_color(t.warning).child(format!("· blocks {}", ask.blocks)))),
            )
            .child(div().font_weight(STRONG).whitespace_normal().child(links::text(
                t,
                format!("{}-text-{fit:?}", ask.ask_id),
                ask.text.to_string(),
                true,
                on_open.clone(),
            )));
        if full {
            for (i, step) in ask.steps.iter().flatten().enumerate() {
                block = block.child(
                    div()
                        .pt_2()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().whitespace_normal().child(format!("{}. {}", i + 1, step.text)))
                        .child(ui::quiet(t, format!("on {}", wire_label(&step.r#where))))
                        .when_some(step.command.as_ref(), |d, command| {
                            d.child(self.command_line(format!("{}-copy-{i}", ask.ask_id), command.to_string(), cx))
                        })
                        .when_some(step.expect.as_ref(), |d, expect| d.child(ui::quiet(t, format!("Expect: {expect}")))),
                );
            }
            if let Some(gated) = &ask.gated {
                // The exact stored argv, as JSON so spaces and quotes stay visible.
                let argv = serde_json::to_string(&gated.argv).unwrap_or_default();
                block = block
                    .child(div().pt_2().child(self.command_line(format!("{}-copy-argv", ask.ask_id), argv, cx)))
                    .child(ui::quiet(t, format!("in {}", gated.cwd.as_deref().unwrap_or("the project workspace"))))
                    .child(ui::quiet(
                        t,
                        format!("{} · {} · up to {} min", wire_label(&gated.class), gated.reason, (gated.timeout_sec.get() + 59) / 60),
                    ));
                let env: Vec<String> = gated.secret_env.iter().flat_map(|e| e.0.iter()).map(|e| format!("{} ← {}", e.name, e.secret_key)).collect();
                if !env.is_empty() {
                    block = block.child(ui::quiet(t, format!("Secret env: {}", env.join(", "))));
                }
            }
            if ask.kind == AskKind::Secret {
                block = block.child(self.secret_entry(ask, cx));
            }
            if let Some(evidence) = &ask.evidence {
                block = block.child(div().text_color(t.quiet).whitespace_normal().child(links::text(
                    t,
                    format!("{}-evidence", ask.ask_id),
                    evidence.to_string(),
                    true,
                    on_open,
                )));
            }
        } else if ask.kind == AskKind::Secret || ask.gated.is_some() || ask.steps.is_some() {
            // Secrets, gated runs and checklists need the panel's room.
            return block.child(
                div().pt_1().child(
                    ui::button(
                        t,
                        SharedString::from(format!("{}-open-panel", ask.ask_id)),
                        format!("Open in the inbox {}", ui::shortcut("I")),
                        Variant::Secondary,
                        true,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inbox(true, cx))),
                ),
            );
        }
        block.child(buttons)
    }

    /// Masked entry: the value lives only in the field's self-wiping buffer, and is sealed to the sink machine's
    /// key here before anything is sent.
    fn secret_entry(&self, ask: &Ask, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let col = div().pt_2().flex().flex_col().gap_1().child(ui::quiet(t, format!("{} → {}", ask.key, ask.sink.as_deref().unwrap_or("?"))));
        let machine = match self.state.secret_target(ask) {
            Ok((machine, _)) => machine,
            Err(reason) => return col.child(div().text_color(t.warning).whitespace_normal().child(reason)),
        };
        let Some((input, _)) = self.secrets.get(ask.ask_id.as_str()) else { return col };
        let typed = !input.read(cx).is_empty();
        let sending = self.state.secret_submitting(&ask.ask_id);
        let id = ask.ask_id.to_string();
        let send = ui::button(
            t,
            SharedString::from(format!("{}-seal", ask.ask_id)),
            if sending { "Sending…" } else { "Seal and send" },
            Variant::Primary,
            !sending,
        )
        .on_click(cx.listener(move |this, _, _, cx| this.submit_secret(&id, cx)));
        col.child(div().flex().gap_2().items_center().child(div().flex_1().child(input.clone())).when(typed, |d| d.child(send))).child(
            div().text_size(px(size::XS)).text_color(t.quiet).child(format!("Encrypted here to {machine}'s key; the hub never sees the value.")),
        )
    }

    pub(crate) fn on_reply_event(&mut self, input: gpui::Entity<crate::input::TextInput>, event: &InputEvent, cx: &mut Context<Self>) {
        let raw = input.read(cx).text().to_string();
        match event {
            InputEvent::Submit if !raw.trim().is_empty() => {
                input.update(cx, |i, cx| {
                    i.remember(&raw);
                    i.clear(cx);
                });
                let out = self.state.reply(&raw, None);
                self.send(out);
            }
            InputEvent::Cancel if !raw.is_empty() => input.update(cx, |i, cx| i.clear(cx)),
            InputEvent::Cancel => self.toggle_inbox(false, cx),
            _ => return,
        }
        cx.notify();
    }

    pub(crate) fn send_reply(&mut self, cx: &mut Context<Self>) {
        let reply = self.reply.clone();
        self.on_reply_event(reply, &InputEvent::Submit, cx);
    }
}
