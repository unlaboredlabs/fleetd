//! Settings → Instructions: the human's own text, appended to every lead's and task's first message (workers,
//! reviewers and judges too) under "Custom instructions from the human": the hub-wide text, then the project's.
//! Saved with `prompt_set` on the registry id `instructions`, pinned per session like every prompt.

use fleetd_contracts::prompts::PromptScope;
use gpui::{AnyElement, Context, Entity, div, prelude::*, px};

use crate::input::TextInput;
use crate::prompts::Load;
use crate::shell::Shell;
use crate::state::ProjectKey;
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};

impl Shell {
    pub(crate) fn open_instructions(&mut self, project: Option<ProjectKey>, cx: &mut Context<Self>) {
        self.prompts_ui.picker = None;
        let out = self.state.instructions_open(project);
        self.send_prompts(out, cx);
    }

    /// Fills the two fields from what the hub sent, leaving a field you have typed in alone.
    fn sync_instruction_fields(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.state.prompts.instructions.ready() else { return };
        let project = self.state.prompts.instructions_for.clone();
        let global = d.global.as_ref().map(|o| o.text.clone()).unwrap_or_default();
        let own = d.project.as_ref().map(|o| o.text.clone()).unwrap_or_default();
        let now = (project, global, own);
        if self.prompts_ui.instr_loaded.as_ref() == Some(&now) {
            return;
        }
        let before = self.prompts_ui.instr_loaded.take();
        let untouched = |field: &Entity<TextInput>, was: Option<&String>, cx: &Context<Self>| was.is_none_or(|w| field.read(cx).text() == w);
        if untouched(&self.prompts_ui.instr_global, before.as_ref().map(|b| &b.1), cx) {
            let text = now.1.clone();
            self.prompts_ui.instr_global.update(cx, |i, cx| i.set_text(&text, cx));
        }
        // Another project's text is never kept.
        let same_project = before.as_ref().is_some_and(|b| b.0 == now.0);
        if !same_project || untouched(&self.prompts_ui.instr_project, before.as_ref().map(|b| &b.2), cx) {
            let text = now.2.clone();
            self.prompts_ui.instr_project.update(cx, |i, cx| i.set_text(&text, cx));
        }
        self.prompts_ui.instr_loaded = Some(now);
    }

    pub(crate) fn instructions_page(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        if !self.connected() {
            return ui::empty(t, "Not connected", "Connect to a hub to add instructions for its agents.").into_any_element();
        }
        self.sync_instruction_fields(cx);
        let loaded = match &self.state.prompts.instructions {
            Load::Idle | Load::Loading => None,
            Load::Failed(e) => {
                let e = e.clone();
                let retry = ui::button(t, "instr-retry", "Retry", Variant::Secondary, true)
                    .on_click(cx.listener(|this, _, _, cx| this.open_instructions(this.state.prompts.instructions_for.clone(), cx)));
                return div()
                    .p_6()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.error_line("copy-instr-error", e, None, cx))
                    .child(div().child(retry))
                    .into_any_element();
            }
            Load::Ready(d) => Some(d.clone()),
        };
        let Some(d) = loaded else { return ui::loading(t, "Loading instructions…").into_any_element() };
        let project = self.state.prompts.instructions_for.clone();
        let project_name = project.as_ref().map(|k| self.state.project(k).map_or(k.1.clone(), |r| r.summary.title.to_string()));
        let busy = self.state.prompts.instructions_busy;
        let saved_global = d.global.as_ref().map(|o| o.text.clone()).unwrap_or_default();
        let saved_own = d.project.as_ref().map(|o| o.text.clone()).unwrap_or_default();
        let global_text = self.prompts_ui.instr_global.read(cx).text().to_string();
        let own_text = self.prompts_ui.instr_project.read(cx).text().to_string();
        let save = |id: &'static str, scope: PromptScope, changed: bool, field: Entity<TextInput>, cx: &mut Context<Self>| {
            let on = changed && busy.is_none();
            ui::button(t, id, if busy == Some(scope) { "Saving…" } else { "Save" }, Variant::Secondary, on).when(on, |b| {
                b.on_click(cx.listener(move |this, _, _, cx| {
                    let text = field.read(cx).text().to_string();
                    let out = this.state.instructions_save(scope, &text);
                    this.send_prompts(out, cx);
                }))
            })
        };
        let label = |title: &'static str, help: String| {
            div()
                .flex()
                .flex_col()
                .gap_0p5()
                .child(div().font_weight(STRONG).child(title))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).whitespace_normal().child(help))
        };
        let global_save = save("instr-save-global", PromptScope::Global, global_text != saved_global, self.prompts_ui.instr_global.clone(), cx);
        let mut col = div()
            .id("instructions")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px_6()
            .py_4()
            .flex()
            .flex_col()
            .gap_4()
            .max_w(px(metric::MEASURE + 120.))
            .child(div().text_color(t.quiet).whitespace_normal().child(
                "Added to the first message of every lead and task, workers, reviewers and judges included, under \
                 \"Custom instructions from the human\": these first, then the project's own. A running session keeps \
                 the instructions it started with; a lead gets new ones at its next restart.",
            ))
            .child(label("Every project", "Sent to every agent on this hub.".into()))
            .child(self.prompts_ui.instr_global.clone())
            .child(div().flex().items_center().gap_2().child(global_save))
            .child(ui::hairline(t));
        let picker = self.project_picker("instr-for", project.as_ref(), None, |this, key, cx| this.open_instructions(key, cx), cx);
        col = col.child(
            div()
                .flex()
                .items_start()
                .gap_3()
                .child(div().flex_1().child(label(
                    "One project",
                    match &project_name {
                        Some(name) => format!("Sent to {name}'s agents only, after the ones above."),
                        None => "Pick a project to add instructions for it alone.".into(),
                    },
                )))
                .child(picker),
        );
        if project.is_some() {
            let own_save = save("instr-save-project", PromptScope::Project, own_text != saved_own, self.prompts_ui.instr_project.clone(), cx);
            col = col.child(self.prompts_ui.instr_project.clone()).child(div().flex().items_center().gap_2().child(own_save));
        }
        if let Some(e) = self.state.prompts.instructions_echo.clone() {
            col = col.child(div().text_size(px(size::XS)).text_color(if e.ok { t.quiet } else { t.danger }).whitespace_normal().child(e.text));
        }
        col.into_any_element()
    }
}
