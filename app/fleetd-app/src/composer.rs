//! New order (⌘N / Ctrl+N): one line to a project's lead, sent through the hub's intake (the same path as
//! `intake_submit` over MCP). Aimed at a project, or left to the hub's router, which also honours an
//! `@project` prefix. Enter sends, Shift+Enter adds a line, Esc closes.

use gpui::{App, Context, Entity, EventEmitter, FocusHandle, Focusable, SharedString, Subscription, Window, div, prelude::*, px};

use crate::input::{InputEvent, TextInput};
use crate::state::ProjectKey;
use crate::theme::{STRONG, metric, size, theme};
use crate::ui::{self, Variant};

/// The hub's limit on an order's text (IntakeText).
pub const MAX_BYTES: usize = 4000;

pub enum ComposerEvent {
    Send { target: Option<ProjectKey>, text: String },
    Dismiss,
}

/// A project the order can go to: its key and how to show it.
#[derive(Clone, Debug)]
pub struct Target {
    pub key: ProjectKey,
    pub title: SharedString,
}

pub struct Composer {
    input: Entity<TextInput>,
    targets: Vec<Target>,
    target: Option<ProjectKey>,
    choosing: bool,
    error: Option<String>,
    _sub: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

/// Why an order can't be sent as typed, if it can't.
pub fn check(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write the order first.".into());
    }
    if text.len() > MAX_BYTES {
        return Err(format!("Orders are at most {MAX_BYTES} bytes; this one is {}. Put the detail in a file and point to it.", text.len()));
    }
    Ok(text)
}

impl Composer {
    pub fn new(targets: Vec<Target>, target: Option<ProjectKey>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextInput::new(cx).placeholder("What should get done?").multi_line(4).borderless());
        window.focus(&input.focus_handle(cx), cx);
        let sub = cx.subscribe(&input, |this, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => this.send(cx),
            InputEvent::Cancel if this.choosing => {
                this.choosing = false;
                cx.notify();
            }
            InputEvent::Cancel => cx.emit(ComposerEvent::Dismiss),
            InputEvent::Changed => {
                if this.error.take().is_some() {
                    cx.notify();
                }
            }
            InputEvent::TooLong => {}
        });
        Self { input, targets, target, choosing: false, error: None, _sub: sub }
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).text().to_string();
        match check(&text) {
            Ok(text) => {
                let text = text.to_string();
                self.input.update(cx, |i, _| i.remember(&text));
                cx.emit(ComposerEvent::Send { target: self.target.clone(), text });
            }
            Err(e) => {
                self.error = Some(e);
                cx.notify();
            }
        }
    }

    fn target_label(&self) -> SharedString {
        match &self.target {
            None => "Any project (the hub picks)".into(),
            Some(key) => self.targets.iter().find(|t| &t.key == key).map_or_else(|| key.1.clone().into(), |t| t.title.clone()),
        }
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx);
        let focused = self.input.focus_handle(cx).is_focused(window);
        let empty = self.input.read(cx).text().trim().is_empty();
        let chooser = self.choosing.then(|| {
            let mut list = div().id("targets").max_h(px(metric::ROW * 7.)).overflow_y_scroll().py_1().border_t_1().border_color(t.hairline);
            let options = std::iter::once((None, SharedString::from("Any project (the hub picks)")))
                .chain(self.targets.iter().map(|tg| (Some(tg.key.clone()), tg.title.clone())));
            for (ix, (key, title)) in options.enumerate() {
                let detail = key.as_ref().map(|k| k.0.clone()).unwrap_or_default();
                let selected = key == self.target;
                list = list.child(
                    ui::row(t, ("target", ix), selected)
                        .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(title))
                        .child(div().text_size(px(size::XS)).text_color(t.quiet).child(detail))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.target = key.clone();
                            this.choosing = false;
                            window.focus(&this.input.focus_handle(cx), cx);
                            cx.notify();
                        })),
                );
            }
            list
        });
        ui::floating(t)
            .w(px(600.))
            .flex()
            .flex_col()
            .text_size(px(size::MD))
            .text_color(t.text)
            .child(
                div()
                    .px_4()
                    .pt_3()
                    .pb_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().font_weight(STRONG).child("New order"))
                    .child(div().text_color(t.quiet).child("to"))
                    .child(ui::button(t, "target", format!("{} ▾", self.target_label()), Variant::Ghost, true).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.choosing = !this.choosing;
                            cx.notify();
                        },
                    ))),
            )
            .children(chooser)
            .child(div().px_4().child(ui::field(t, focused).px_1().py_0p5().child(self.input.clone())))
            .when_some(self.error.clone(), |d, e| d.child(div().px_4().pt_2().text_color(t.danger).whitespace_normal().child(e)))
            .child(
                div()
                    .px_4()
                    .py_3()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(size::XS))
                            .text_color(t.quiet)
                            .whitespace_normal()
                            .child("The lead turns this into a brief and runs it. It asks you only about product, money and irreversible calls."),
                    )
                    .child(ui::kbd(t, "Esc"))
                    .child({
                        let send = ui::button(t, "send", "Send", Variant::Primary, !empty);
                        if empty { send } else { send.on_click(cx.listener(|this, _, _, cx| this.send(cx))) }
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_are_trimmed_and_held_to_the_hub_limit() {
        assert_eq!(check("  ship dark mode for the docs site \n"), Ok("ship dark mode for the docs site"));
        assert!(check(" \n ").is_err());
        assert!(check(&"x".repeat(MAX_BYTES)).is_ok());
        assert!(check(&"x".repeat(MAX_BYTES + 1)).unwrap_err().contains("4001"));
    }
}
