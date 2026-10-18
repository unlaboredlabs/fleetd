//! Settings (⌘, / Ctrl+,, or the app menu): appearance, the hub this app is paired with, and the version.
//! Appearance applies at once and is saved; the connection is in the OS keychain, never in a file.

use gpui::{Context, EventEmitter, SharedString, Window, div, prelude::*, px};

use crate::theme::{self, Mode, STRONG, metric, radius, size, theme};
use crate::ui::{self, Variant};

pub enum SettingsEvent {
    /// Forget the saved key and go back to the connect screen.
    Disconnect,
    Close,
}

/// What the shell knows about the connection, shown as-is.
#[derive(Clone, Default)]
pub struct Hub {
    pub url: Option<SharedString>,
    pub status: SharedString,
    pub live: bool,
}

#[derive(Default)]
pub struct Settings {
    pub hub: Hub,
}

impl EventEmitter<SettingsEvent> for Settings {}

impl Render for Settings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx);
        let current = t.mode;
        let mut modes = div().flex().p_0p5().gap_0p5().rounded(px(radius::MD)).bg(t.selected);
        for mode in Mode::ALL {
            let on = mode == current;
            modes = modes.child(
                div()
                    .id(mode.label())
                    .h(px(metric::CONTROL))
                    .px_3()
                    .flex()
                    .items_center()
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .when(on, |d| {
                        d.bg(t.bg).font_weight(STRONG).shadow(vec![gpui::BoxShadow {
                            color: t.hairline,
                            offset: gpui::point(px(0.), px(1.)),
                            blur_radius: px(1.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                    })
                    .when(!on, |d| d.text_color(t.quiet).hover(|s| s.opacity(0.8)))
                    .on_click(move |_, window, cx| theme::set_mode(mode, window, cx))
                    .child(mode.label()),
            );
        }
        let setting = |label: &'static str, help: &'static str| {
            div()
                .w(px(200.))
                .flex_none()
                .flex()
                .flex_col()
                .gap_0p5()
                .child(div().font_weight(STRONG).child(label))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).whitespace_normal().child(help))
        };
        let hub = &self.hub;
        let connection = div()
            .flex_1()
            .flex()
            .flex_col()
            .gap_2()
            .child(match &hub.url {
                Some(url) => ui::mono(t, url.clone()).into_any_element(),
                None => div().text_color(t.quiet).child("Not paired with a hub.").into_any_element(),
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(ui::dot(if hub.live { t.success } else { t.faint }))
                    .child(ui::quiet(t, hub.status.clone())),
            )
            .when(hub.url.is_some(), |d| {
                d.child(
                    div().pt_1().child(
                        ui::button(t, "disconnect", "Disconnect and forget key", Variant::Danger, true)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Disconnect))),
                    ),
                )
            });
        div()
            .size_full()
            .flex()
            .flex_col()
            .text_size(px(size::MD))
            .text_color(t.text)
            .child(ui::header(
                t,
                "Settings",
                ui::button(t, "settings-close", "Done", Variant::Secondary, true).on_click(cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Close))),
            ))
            .child(
                div()
                    .id("settings-body")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_6()
                    .py_4()
                    .flex()
                    .flex_col()
                    .gap_6()
                    .max_w(px(metric::MEASURE))
                    .child(div().flex().items_start().gap_6().child(setting("Appearance", "Match system follows the OS as it changes.")).child(modes))
                    .child(ui::hairline(t))
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap_6()
                            .child(setting("Hub", "This app acts as you on this hub, with a key kept in the OS keychain."))
                            .child(connection),
                    )
                    .child(ui::hairline(t))
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap_6()
                            .child(setting("Version", "Run fleetd update to update the CLI and this app together."))
                            .child(ui::mono(t, format!("fleetd-app {}", crate::update::VERSION))),
                    ),
            )
    }
}
