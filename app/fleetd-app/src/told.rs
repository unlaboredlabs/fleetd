//! "What this agent was told": the exact first message a session was sent (from `session_prompt_get`), which
//! prompt texts it pinned and at which level, and the tools it never gets. Opened from a lane in the order view
//! or the lead's header; Esc or a click outside closes it.

use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::prompts::{PromptScope, SessionPrompt};
use gpui::{AnyElement, Context, Window, div, prelude::*, px};

use crate::prompts::{INSTRUCTIONS, Load};
use crate::shell::Shell;
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};

const WIDTH: f32 = 820.;

/// How a pinned text's level reads in the sheet.
pub fn level(id: &str, scope: PromptScope) -> &'static str {
    match (id == INSTRUCTIONS, scope) {
        (true, PromptScope::Project) => "your instructions for this project",
        (true, _) => "your instructions for every project",
        (false, PromptScope::Default) => "fleetd's default",
        (false, PromptScope::Global) => "your hub-wide edit",
        (false, PromptScope::Project) => "your edit for this project",
    }
}

impl Shell {
    pub(crate) fn open_told(&mut self, thread: ThreadRef, who: String, cx: &mut Context<Self>) {
        self.palette = None;
        self.floating = None;
        let out = self.state.session_prompt(thread, who);
        self.send_prompts(out, cx);
    }

    pub(crate) fn told_sheet(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let told = self.state.prompts.told.as_ref()?;
        let t = &theme(cx).clone();
        let height = (window.viewport_size().height - px(140.)).min(px(760.));
        let close = ui::button(t, "told-close", "Close", Variant::Ghost, true).on_click(cx.listener(|this, _, _, cx| {
            this.state.prompts.told = None;
            cx.notify();
        }));
        let copy = told.prompt.ready().map(|sp| self.copy_button("told-copy", sp.text.clone(), cx));
        let head = div()
            .flex_none()
            .px_4()
            .h(px(metric::BAR))
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(t.hairline)
            .child(div().flex_1().min_w_0().font_weight(STRONG).child(format!("What {} was told", told.who)))
            .children(copy)
            .child(close);
        let body = match &told.prompt {
            Load::Idle | Load::Loading => ui::loading(t, "Loading what it was sent…").into_any_element(),
            Load::Failed(e) => div().p_4().child(self.error_line("copy-told-error", e.clone(), None, cx)).into_any_element(),
            Load::Ready(sp) => self.told_body(sp, cx),
        };
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

    fn told_body(&self, sp: &SessionPrompt, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let started = sp.started_at.as_str().get(..16).unwrap_or_default().replace('T', " ");
        let sha = sp.text_sha.get(..10).unwrap_or(&sp.text_sha);
        let caption = |text: &'static str| div().pt_2().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(text);
        let mut refs = ui::table(3).text_size(px(size::XS));
        for r in &sp.refs {
            refs = refs
                .child(div().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(r.id.to_string()))
                .child(div().child(level(r.id.as_str(), r.scope)))
                .child(div().text_color(t.quiet).font_family(t.mono_font.clone()).text_size(px(size::SM)).child(r.r#ref.to_string()));
        }
        div()
            .flex_1()
            .min_h_0()
            .px_4()
            .pb_4()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .pt_3()
                    .text_size(px(size::XS))
                    .text_color(t.quiet)
                    .child(format!("Started {started} UTC on {} · thread {} · text {sha}", sp.machine_id, sp.thread_id)),
            )
            .child(caption("PINNED AT ITS START"))
            .child(refs)
            .child(div().text_size(px(size::XS)).text_color(t.quiet).whitespace_normal().child(
                "Its later messages (wakes, review findings, nudges) render from these same texts. Edits reach it only \
                 when it starts again: a lead at its next restart, a task at its next attempt.",
            ))
            .child(caption("TOOLS IT NEVER GETS"))
            .child(
                div()
                    .font_family(t.mono_font.clone())
                    .text_size(px(size::SM))
                    .text_color(t.quiet)
                    .whitespace_normal()
                    .child(sp.disallowed_tools.join(", ")),
            )
            .child(caption("FIRST MESSAGE, EXACTLY AS SENT"))
            .child(
                div()
                    .id("told-text")
                    .flex_1()
                    .min_h(px(120.))
                    .overflow_y_scroll()
                    .border_t_1()
                    .border_color(t.hairline)
                    .pt_2()
                    .font_family(t.mono_font.clone())
                    .text_size(px(size::SM))
                    .whitespace_normal()
                    .child(sp.text.clone()),
            )
            .into_any_element()
    }
}
