//! The window's own chrome, after Zed's `platform_title_bar` and `client_side_decorations` at our gpui tag.
//!
//! macOS: the native title bar is transparent and the traffic lights sit inside our top bar. Linux: when the
//! window has client-side decorations (Wayland compositors without server decorations, such as GNOME, and
//! X11 with a compositor), we draw the frame: resize edges, a shadow, rounded corners, and the window buttons
//! in the desktop's configured order. With server decorations the window manager draws all of that, and the
//! bar only carries the menu button and the title.

use std::borrow::Cow;

use gpui::{
    Action, AnyElement, App, AssetSource, Bounds, Context, CursorStyle, Decorations, Entity, HitboxBehavior, Hsla, MouseButton, OwnedMenuItem,
    Pixels, Point, ResizeEdge, SharedString, Size, Tiling, Window, WindowButton, WindowButtonLayout, WindowControlArea, anchored, canvas, deferred,
    div, point, prelude::*, px, svg, transparent_black,
};

use crate::actions::{About, BringAllToFront, Minimize, ToggleFullScreen, Zoom};
use crate::crash;
use crate::shell::Shell;
use crate::theme::{self, size, theme};

/// Where AppKit draws the traffic lights, and the room the bar leaves for them. Zed's numbers: 78 px fits
/// the wider lights of macOS 26 and leaves a few spare pixels on older systems.
pub const TRAFFIC_LIGHTS: Point<Pixels> = point(px(9.), px(9.));
const TRAFFIC_LIGHT_PADDING: Pixels = px(78.);
const BAR_HEIGHT: Pixels = px(34.);
/// Client-side decorations: the transparent margin that holds the shadow and the resize grips.
const SHADOW: Pixels = px(10.);
const ROUNDING: Pixels = px(10.);

/// The window's root view: the frame (when we draw it) around the shell, plus the window-level actions
/// the app menu dispatches.
pub struct Frame {
    shell: Entity<Shell>,
    edge: Option<ResizeEdge>,
}

impl Frame {
    pub fn new(shell: Entity<Shell>) -> Self {
        Self { shell, edge: None }
    }
}

impl Render for Frame {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = div()
            .size_full()
            // A menu item runs inside AppKit's menu callback, which can't unwind.
            .on_action(|_: &Minimize, window, _| crash::guard("Minimize", || window.minimize_window()))
            .on_action(|_: &Zoom, window, _| crash::guard("Zoom", || window.zoom_window()))
            .on_action(|_: &ToggleFullScreen, window, _| crash::guard("ToggleFullScreen", || window.toggle_fullscreen()))
            .on_action(|_: &BringAllToFront, window, cx| {
                crash::guard("BringAllToFront", || {
                    cx.activate(true);
                    window.activate_window();
                })
            })
            .on_action(|_: &About, window, cx| crash::guard("About", || about(window, cx)))
            .child(self.shell.clone());
        let Decorations::Client { tiling } = window.window_decorations() else {
            window.set_client_inset(px(0.));
            return content.into_any_element();
        };
        window.set_client_inset(SHADOW);
        let resizable = window.is_resizable();
        div()
            .id("window-backdrop")
            .size_full()
            .bg(transparent_black())
            .map(|d| client_corners(d, tiling))
            .when(!tiling.top, |d| d.pt(SHADOW))
            .when(!tiling.bottom, |d| d.pb(SHADOW))
            .when(!tiling.left, |d| d.pl(SHADOW))
            .when(!tiling.right, |d| d.pr(SHADOW))
            .when(resizable, |d| {
                d.on_mouse_move(cx.listener(move |this, e: &gpui::MouseMoveEvent, window, cx| {
                    let edge = resize_edge(e.position, window.window_bounds().get_bounds().size, tiling);
                    if edge != this.edge {
                        this.edge = edge;
                        cx.notify();
                    }
                }))
                .on_mouse_down(MouseButton::Left, move |e, window, _| {
                    if let Some(edge) = resize_edge(e.position, window.window_bounds().get_bounds().size, tiling) {
                        window.start_window_resize(edge);
                    }
                })
            })
            .child(
                div()
                    .size_full()
                    .cursor(CursorStyle::Arrow)
                    .border_color(theme(cx).hairline)
                    .map(|d| client_corners(d, tiling))
                    .when(!tiling.top, |d| d.border_t_1())
                    .when(!tiling.bottom, |d| d.border_b_1())
                    .when(!tiling.left, |d| d.border_l_1())
                    .when(!tiling.right, |d| d.border_r_1())
                    .when(!tiling.is_tiled(), |d| {
                        d.shadow(vec![gpui::BoxShadow::new(px(0.), px(0.), Hsla { h: 0., s: 0., l: 0., a: 0.4 }).blur_radius(SHADOW / 2.)])
                    })
                    .overflow_hidden()
                    .on_mouse_move(|_, _, cx| cx.stop_propagation())
                    .child(content),
            )
            .when(resizable, |d| {
                // The resize cursor over the margin, which the content's hitboxes don't cover.
                d.child(
                    canvas(
                        |_, window, _| {
                            window.insert_hitbox(Bounds::new(point(px(0.), px(0.)), window.window_bounds().get_bounds().size), HitboxBehavior::Normal)
                        },
                        move |_, hitbox, window, _| {
                            let size = window.window_bounds().get_bounds().size;
                            if let Some(edge) = resize_edge(window.mouse_position(), size, tiling) {
                                window.set_cursor_style(resize_cursor(edge), &hitbox);
                            }
                        },
                    )
                    .size_full()
                    .absolute(),
                )
            })
            .into_any_element()
    }
}

fn client_corners<E: Styled>(mut e: E, tiling: Tiling) -> E {
    if !(tiling.top || tiling.left) {
        e = e.rounded_tl(ROUNDING);
    }
    if !(tiling.top || tiling.right) {
        e = e.rounded_tr(ROUNDING);
    }
    if !(tiling.bottom || tiling.left) {
        e = e.rounded_bl(ROUNDING);
    }
    if !(tiling.bottom || tiling.right) {
        e = e.rounded_br(ROUNDING);
    }
    e
}

fn resize_cursor(edge: ResizeEdge) -> CursorStyle {
    match edge {
        ResizeEdge::Top | ResizeEdge::Bottom => CursorStyle::ResizeUpDown,
        ResizeEdge::Left | ResizeEdge::Right => CursorStyle::ResizeLeftRight,
        ResizeEdge::TopLeft | ResizeEdge::BottomRight => CursorStyle::ResizeUpLeftDownRight,
        ResizeEdge::TopRight | ResizeEdge::BottomLeft => CursorStyle::ResizeUpRightDownLeft,
    }
}

/// Which edge a pointer at `pos` grabs: within 1.5 shadow widths of an untiled edge, corners first.
fn resize_edge(pos: Point<Pixels>, window: Size<Pixels>, tiling: Tiling) -> Option<ResizeEdge> {
    let grip = SHADOW * 1.5;
    if Bounds::new(Point::default(), window).inset(grip).contains(&pos) {
        return None;
    }
    let (top, bottom) = (pos.y < grip && !tiling.top, pos.y >= window.height - grip && !tiling.bottom);
    let (left, right) = (pos.x < grip && !tiling.left, pos.x >= window.width - grip && !tiling.right);
    Some(match (top, bottom, left, right) {
        (true, _, true, _) => ResizeEdge::TopLeft,
        (true, _, _, true) => ResizeEdge::TopRight,
        (_, true, true, _) => ResizeEdge::BottomLeft,
        (_, true, _, true) => ResizeEdge::BottomRight,
        (true, ..) => ResizeEdge::Top,
        (_, true, ..) => ResizeEdge::Bottom,
        (_, _, true, _) => ResizeEdge::Left,
        (_, _, _, true) => ResizeEdge::Right,
        _ => return None,
    })
}

fn about(window: &mut Window, cx: &mut App) {
    let version = crate::update::VERSION;
    let answer = window.prompt(gpui::PromptLevel::Info, "fleetd", Some(&format!("Version {version}")), &["Copy Version", "OK"], cx);
    cx.spawn(async move |cx| {
        if answer.await == Ok(0) {
            cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(version.to_string())));
        }
    })
    .detach();
}

/// The top bar. The shell renders it as its first child; children go in the middle.
#[derive(IntoElement, Default)]
pub struct TitleBar {
    children: Vec<AnyElement>,
}

impl TitleBar {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for TitleBar {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for TitleBar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // Zed's pattern: start the move on the first drag after a press, so a double-click still arrives.
        let should_move = window.use_keyed_state("titlebar-should-move", cx, |_, _| false);
        let decorations = window.window_decorations();
        let csd = matches!(decorations, Decorations::Client { .. });
        let controls = window.window_controls();
        let fullscreen = window.is_fullscreen();
        let layout = if csd { cx.button_layout().or_else(default_button_layout) } else { None };
        let left_buttons = layout.map(|l| l.left).filter(|b| b[0].is_some() && !fullscreen);
        let right_buttons = layout.map(|l| l.right).filter(|b| b[0].is_some() && !fullscreen);
        let t = theme(cx).clone();
        let (left_pad, right_pad) = match (cfg!(target_os = "macos"), fullscreen) {
            (true, false) => (TRAFFIC_LIGHT_PADDING, TRAFFIC_LIGHT_PADDING),
            // Room for the menu button on the left, mirrored on the right so the title stays centred.
            (false, _) => (px(8.), px(38.)),
            (true, true) => (px(8.), px(8.)),
        };
        div()
            .id("titlebar")
            .window_control_area(WindowControlArea::Drag)
            .flex_none()
            .h(BAR_HEIGHT)
            .w_full()
            .flex()
            .items_center()
            // One tone with the sidebar below it, so bar and sidebar read as the window's frame.
            .bg(t.sidebar)
            .border_b_1()
            .border_color(t.hairline)
            .text_size(px(size::MD))
            .text_color(t.quiet)
            .on_mouse_down(MouseButton::Left, set_flag(&should_move, true))
            .on_mouse_up(MouseButton::Left, set_flag(&should_move, false))
            .on_mouse_down_out(set_flag(&should_move, false))
            .on_mouse_move({
                let should_move = should_move.clone();
                move |_, window, cx| {
                    if *should_move.read(cx) {
                        should_move.update(cx, |m, _| *m = false);
                        window.start_window_move();
                    }
                }
            })
            .on_click(move |e, window, _| {
                if e.click_count() != 2 {
                    return;
                }
                if cfg!(target_os = "macos") {
                    // Zoom, minimize or nothing, per System Settings > Desktop & Dock.
                    window.titlebar_double_click();
                } else if controls.maximize && window.is_resizable() {
                    window.zoom_window();
                }
            })
            .when(csd && controls.window_menu, |d| d.on_mouse_down(MouseButton::Right, |e, window, _| window.show_window_menu(e.position)))
            .map(|d| match left_buttons {
                Some(buttons) => d.child(window_buttons("left-window-buttons", buttons, window, &t)),
                None => d.pl(left_pad),
            })
            .when(!cfg!(target_os = "macos"), |d| d.child(menu_button(window, cx)))
            .child(div().flex_1().min_w_0().flex().items_center().justify_center().gap_2().child("fleetd").children(self.children))
            .map(|d| match right_buttons {
                Some(buttons) => d.child(window_buttons("right-window-buttons", buttons, window, &t)),
                None => d.pr(right_pad),
            })
    }
}

fn set_flag<E>(flag: &Entity<bool>, value: bool) -> impl Fn(&E, &mut Window, &mut App) + 'static {
    let flag = flag.clone();
    move |_, _, cx| flag.update(cx, |f, _| *f = value)
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn default_button_layout() -> Option<WindowButtonLayout> {
    Some(WindowButtonLayout::linux_default())
}

#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
fn default_button_layout() -> Option<WindowButtonLayout> {
    None
}

fn window_buttons(id: &'static str, buttons: [Option<WindowButton>; 3], window: &Window, t: &theme::Theme) -> impl IntoElement {
    let controls = window.window_controls();
    let maximized = window.is_maximized();
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        // Pressing a button mustn't start a window drag.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .children(
            buttons
                .into_iter()
                .flatten()
                .filter(|b| match b {
                    WindowButton::Minimize => controls.minimize,
                    WindowButton::Maximize => controls.maximize,
                    WindowButton::Close => true,
                })
                .map(move |button| {
                    let (name, icon) = match button {
                        WindowButton::Minimize => ("minimize", "icons/minimize.svg"),
                        WindowButton::Maximize if maximized => ("restore", "icons/restore.svg"),
                        WindowButton::Maximize => ("maximize", "icons/maximize.svg"),
                        WindowButton::Close => ("close", "icons/close.svg"),
                    };
                    icon_button(name, icon, t).on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        match button {
                            WindowButton::Minimize => window.minimize_window(),
                            WindowButton::Maximize => window.zoom_window(),
                            WindowButton::Close => window.remove_window(),
                        }
                    })
                }),
        )
}

fn icon_button(id: &'static str, icon: &'static str, t: &theme::Theme) -> gpui::Stateful<gpui::Div> {
    let hover = t.hover;
    div()
        .id(id)
        .size(px(22.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
        .on_mouse_move(|_, _, cx| cx.stop_propagation())
        .child(svg().path(icon).size(px(16.)).text_color(t.text))
}

/// Linux has no global menu bar, so the app menu opens from here.
fn menu_button(window: &mut Window, cx: &mut App) -> impl IntoElement {
    let open = window.use_keyed_state("app-menu-open", cx, |_, _| false);
    let is_open = *open.read(cx);
    let toggle = open.clone();
    div()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(icon_button("app-menu", "icons/menu.svg", &theme(cx).clone()).on_click(move |_, _, cx| {
            toggle.update(cx, |o, cx| {
                *o = !*o;
                cx.notify();
            })
        }))
        .when(is_open, |d| d.child(deferred(anchored().child(menu_list(open, window, cx))).with_priority(1)))
}

fn menu_list(open: Entity<bool>, window: &mut Window, cx: &mut App) -> impl IntoElement {
    let t = theme(cx).clone();
    let close = open.clone();
    let mut list = div()
        .id("app-menu-list")
        // Clicks on the menu must not reach the rows under it.
        .occlude()
        .mt(px(28.))
        .min_w(px(240.))
        .py_1()
        .bg(t.raised)
        .border_1()
        .border_color(t.hairline)
        .rounded(px(theme::radius::MD))
        .shadow(t.float_shadow())
        .text_size(px(size::MD))
        .text_color(t.text)
        .on_mouse_down_out(move |_, _, cx| {
            close.update(cx, |o, cx| {
                *o = false;
                cx.notify();
            })
        });
    for (i, menu) in cx.get_menus().unwrap_or_default().into_iter().enumerate() {
        if i > 0 {
            list = list.child(div().my_1().h(px(1.)).bg(t.hairline));
        }
        list = list.child(div().px_3().py_0p5().text_size(px(size::XS)).font_weight(theme::STRONG).text_color(t.quiet).child(menu.name));
        for (j, item) in menu.items.into_iter().enumerate() {
            let OwnedMenuItem::Action { name, action, .. } = item else { continue };
            // The focused view's handlers, or an app-wide one (the window's own check misses those).
            let enabled = window.is_action_available(action.as_ref(), cx) || cx.is_action_available(action.as_ref());
            list = list.child(menu_row((i, j), name.into(), action, enabled, open.clone(), window, &t));
        }
    }
    list
}

fn menu_row(
    id: (usize, usize),
    name: SharedString,
    action: Box<dyn Action>,
    enabled: bool,
    open: Entity<bool>,
    window: &Window,
    t: &theme::Theme,
) -> impl IntoElement {
    let hover = t.hover;
    let keys = window
        .highest_precedence_binding_for_action(action.as_ref())
        .map(|b| b.keystrokes().iter().map(|k| k.to_string()).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    div()
        .id(SharedString::from(format!("menu-{}-{}", id.0, id.1)))
        .mx_1()
        .px_2()
        .h(px(26.))
        .flex()
        .items_center()
        .justify_between()
        .gap_4()
        .rounded_sm()
        .when(!enabled, |d| d.text_color(t.faint))
        .when(enabled, |d| {
            d.cursor_pointer().hover(move |d| d.bg(hover)).on_click(move |_, window, cx| {
                open.update(cx, |o, cx| {
                    *o = false;
                    cx.notify();
                });
                window.dispatch_action(action.boxed_clone(), cx);
            })
        })
        .child(name)
        .child(div().text_size(px(size::XS)).text_color(t.quiet).child(keys))
}

/// The title bar's icons, drawn here so the app needs no icon files (svg renders them in the text colour).
pub struct Icons;

impl AssetSource for Icons {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let body = match path {
            "icons/minimize.svg" => r#"<path d="M4 8.5h8"/>"#,
            "icons/maximize.svg" => r#"<rect x="4.5" y="4.5" width="7" height="7"/>"#,
            "icons/restore.svg" => r#"<rect x="4.5" y="6.5" width="5" height="5"/><path d="M6.5 4.5h5v5"/>"#,
            "icons/close.svg" => r#"<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>"#,
            "icons/menu.svg" => r#"<path d="M3 4.5h10M3 8h10M3 11.5h10"/>"#,
            _ => return Ok(None),
        };
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.2">{body}</svg>"#
        );
        Ok(Some(Cow::Owned(svg.into_bytes())))
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use gpui::size;

    use super::*;

    fn at(x: f32, y: f32) -> Option<ResizeEdge> {
        resize_edge(point(px(x), px(y)), size(px(800.), px(600.)), Tiling::default())
    }

    #[test]
    fn resize_edges_cover_the_margin_corners_first() {
        assert_eq!(at(400., 300.), None);
        assert_eq!(at(2., 2.), Some(ResizeEdge::TopLeft));
        assert_eq!(at(798., 2.), Some(ResizeEdge::TopRight));
        assert_eq!(at(2., 598.), Some(ResizeEdge::BottomLeft));
        assert_eq!(at(798., 598.), Some(ResizeEdge::BottomRight));
        assert_eq!(at(400., 3.), Some(ResizeEdge::Top));
        assert_eq!(at(400., 597.), Some(ResizeEdge::Bottom));
        assert_eq!(at(3., 300.), Some(ResizeEdge::Left));
        assert_eq!(at(797., 300.), Some(ResizeEdge::Right));
    }

    #[test]
    fn tiled_edges_dont_resize() {
        let tiled = Tiling { top: true, left: true, right: false, bottom: false };
        let edge = |x: f32, y: f32| resize_edge(point(px(x), px(y)), size(px(800.), px(600.)), tiled);
        assert_eq!(edge(2., 2.), None);
        assert_eq!(edge(400., 2.), None);
        assert_eq!(edge(798., 300.), Some(ResizeEdge::Right));
        assert_eq!(edge(798., 2.), Some(ResizeEdge::Right));
    }
}
