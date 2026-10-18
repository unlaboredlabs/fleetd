//! Settings (⌘, / Ctrl+,, or the app menu): appearance, motion, the hub this app is paired with, and the version.
//! Appearance and motion apply at once and are saved; the connection is in the OS keychain, never in a file.

use gpui::{Context, EventEmitter, SharedString, Window, div, prelude::*, px};

use crate::prefs::{self, MotionPref as Motion};
use crate::theme::{self, Mode, STRONG, Theme, metric, radius, size, theme};
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

pub struct Settings {
    pub hub: Hub,
    motion: Motion,
}

impl Default for Settings {
    fn default() -> Self {
        Self { hub: Hub::default(), motion: prefs::load().motion }
    }
}

/// A segmented control: one option per button, the current one raised.
fn segmented<T: Copy + PartialEq + 'static>(
    t: &Theme,
    id: &'static str,
    options: &[(T, &'static str)],
    current: T,
    on_pick: impl Fn(T, &mut gpui::Window, &mut gpui::App) + Clone + 'static,
) -> gpui::Div {
    let mut row = div().flex().p_0p5().gap_0p5().rounded(px(radius::MD)).bg(t.selected);
    for (ix, (value, label)) in options.iter().copied().enumerate() {
        let on = value == current;
        let on_pick = on_pick.clone();
        row = row.child(
            ui::clickable(t, div().id((id, ix)))
                .h(px(metric::CONTROL))
                .px_3()
                .flex()
                .items_center()
                .rounded(px(radius::SM))
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
                .on_click(move |_, window, cx| on_pick(value, window, cx))
                .child(label),
        );
    }
    row
}

impl EventEmitter<SettingsEvent> for Settings {}

impl Render for Settings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let modes: Vec<(Mode, &'static str)> = Mode::ALL.iter().map(|m| (*m, m.label())).collect();
        let modes = segmented(t, "mode", &modes, t.mode, theme::set_mode);
        let motions: Vec<(Motion, &'static str)> = Motion::ALL.iter().map(|m| (*m, m.label())).collect();
        let this = cx.entity().downgrade();
        let motion = segmented(t, "motion", &motions, self.motion, move |motion, _, cx| {
            crate::live::motion::set_pref(motion, cx);
            this.update(cx, |s, cx| {
                s.motion = motion;
                cx.notify();
            })
            .ok();
            cx.background_executor()
                .spawn(async move {
                    let mut p = prefs::load();
                    p.motion = motion;
                    // Not saved only if the config directory is unwritable; the choice still holds for this run.
                    let _ = prefs::save(&p);
                })
                .detach();
        });
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
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap_6()
                            .child(setting("Motion", "Cards, lanes and the inbox panel move briefly when they change. Reduced turns that off."))
                            .child(motion),
                    )
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
