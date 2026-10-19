//! Small building blocks every screen shares, styled only from the [`Theme`]. Screens compose these; they do
//! not restyle them.

use gpui::{Div, ElementId, Hsla, MouseButton, SharedString, Stateful, div, prelude::*, px};

use crate::theme::{STRONG, Theme, metric, radius, size};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// The one action a screen is for (Send, Connect). At most one per view.
    Primary,
    /// Everything else that is a button.
    Secondary,
    /// Low-weight actions inside rows: Copy, Open, Re-run.
    Ghost,
    /// Irreversible actions, outlined, never filled.
    Danger,
}

/// Anything you click: pointer cursor, the focus ring when reached with Tab (Enter or Space then clicks it),
/// and a click that leaves keyboard focus where it was, so typing in a field carries on.
pub fn clickable(t: &Theme, el: Stateful<Div>) -> Stateful<Div> {
    let ring = t.focus_ring();
    el.tab_index(0)
        .cursor_pointer()
        .focus_visible(move |s| s.shadow(ring.clone()))
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
}

/// A button. Attach `.on_click` at the call site; leave it off (and pass `enabled: false`) while it can't run.
pub fn button(t: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, variant: Variant, enabled: bool) -> Stateful<Div> {
    let base = div()
        .id(id)
        .h(px(metric::CONTROL))
        .px_2p5()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(radius::SM))
        .text_size(px(size::MD))
        .whitespace_nowrap()
        .child(label.into());
    // A disabled button drops its variant's colour: a faded accent fill still reads as the action to press.
    if !enabled {
        return match variant {
            Variant::Ghost => base,
            _ => base.border_1().border_color(t.hairline),
        }
        .text_color(t.faint);
    }
    let base = match variant {
        Variant::Primary => base.bg(t.accent_fill).text_color(t.on_accent).font_weight(STRONG),
        Variant::Secondary => base.border_1().border_color(t.border).text_color(t.text),
        Variant::Ghost => base.text_color(t.quiet),
        Variant::Danger => base.border_1().border_color(t.danger).text_color(t.danger),
    };
    let hover = t.hover;
    let text = t.text;
    clickable(t, base).hover(move |s| match variant {
        Variant::Primary => s.opacity(0.88),
        Variant::Ghost => s.bg(hover).text_color(text),
        _ => s.bg(hover),
    })
}

/// A 7 px status dot, for before or after a label in a flex row.
pub fn dot(color: Hsla) -> Div {
    mark(div().size(px(7.)).bg(color))
}

/// An open item: a 7 px hollow circle, the dot's outline.
pub fn ring(color: Hsla) -> Div {
    mark(div().size(px(7.)).border_1().border_color(color))
}

/// The unread mark: a small accent dot before a row's label.
pub fn unread(t: &Theme) -> Div {
    mark(div().size(px(6.)).bg(t.accent))
}

/// A drawn circle (a "●" glyph sits differently in every font) in a box exactly one line of the inherited
/// text tall, so it lines up with the label's first line in any row, at any text size, and when the label
/// wraps. The zero-width strut is what makes the box one line tall. The line box's centre sits about 1.5 px
/// above the x-height's centre in IBM Plex Sans; 1 px down splits the difference between lowercase and capitals.
fn mark(circle: Div) -> Div {
    div().flex_none().flex().items_center().child(div().w_0().overflow_hidden().child("\u{200B}")).child(circle.relative().top(px(1.)).rounded_full())
}

/// A keyboard shortcut hint, e.g. "⌘K".
pub fn kbd(t: &Theme, keys: impl Into<SharedString>) -> Div {
    div().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(keys.into())
}

/// Shortcut text for this platform: `"K"` -> "⌘K" on macOS, "Ctrl+K" elsewhere.
pub fn shortcut(key: &str) -> String {
    if cfg!(target_os = "macos") { format!("⌘{key}") } else { format!("Ctrl+{key}") }
}

pub fn hairline(t: &Theme) -> Div {
    div().h(px(1.)).w_full().flex_none().bg(t.hairline)
}

/// A screen or pane header: title at body size and semibold, detail quiet on the right, a hairline below.
pub fn header(t: &Theme, title: impl IntoElement, detail: impl IntoElement) -> Div {
    div()
        .h(px(metric::BAR))
        .flex_none()
        .px_4()
        .flex()
        .items_center()
        .justify_between()
        .gap_3()
        .border_b_1()
        .border_color(t.hairline)
        .child(div().flex().items_center().gap_2().min_w_0().text_size(px(size::MD)).font_weight(STRONG).child(title))
        .child(div().flex().items_center().gap_3().flex_none().text_size(px(size::XS)).text_color(t.quiet).child(detail))
}

/// Quiet secondary text.
pub fn quiet(t: &Theme, text: impl Into<SharedString>) -> Div {
    div().text_color(t.quiet).child(text.into())
}

/// Machine text: mono at the mono size.
pub fn mono(t: &Theme, text: impl Into<SharedString>) -> Div {
    div().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(text.into())
}

/// Nothing to show yet, said plainly, with what to do about it. Left-aligned at the reading measure.
pub fn empty(t: &Theme, title: impl Into<SharedString>, detail: impl Into<SharedString>) -> Div {
    div()
        .max_w(px(metric::MEASURE))
        .px_4()
        .py_6()
        .flex()
        .flex_col()
        .gap_1()
        .child(div().font_weight(STRONG).child(title.into()))
        .child(div().text_color(t.quiet).whitespace_normal().child(detail.into()))
}

/// Waiting on the hub. Static text: nothing animates while the app waits.
pub fn loading(t: &Theme, what: impl Into<SharedString>) -> Div {
    div().px_4().py_6().text_color(t.quiet).child(what.into())
}

/// An error: a red dot, what went wrong in body text, the fix below it in grey, and a Copy button (made by
/// the caller, which tracks what was copied) so it can be pasted into an issue or a search.
pub fn error(t: &Theme, message: impl Into<SharedString>, fix: Option<SharedString>, copy: Stateful<Div>) -> Div {
    let message = message.into();
    div()
        .max_w(px(metric::MEASURE))
        .flex()
        .flex_col()
        .gap_1()
        .child(div().flex().items_start().gap_2().child(dot(t.danger)).child(div().flex_1().min_w_0().whitespace_normal().child(message)).child(copy))
        .when_some(fix, |d, fix| d.child(div().pl(px(15.)).text_color(t.quiet).whitespace_normal().child(fix)))
}

/// "Copy", or "Copied" once it was. The caller attaches the click (it tracks what was copied last).
pub fn copy_button(t: &Theme, id: impl Into<ElementId>, copied: bool) -> Stateful<Div> {
    button(t, id, if copied { "Copied" } else { "Copy" }, Variant::Ghost, true)
}

/// A command to run by hand: mono, on a one-step tone, with its Copy button.
pub fn command(t: &Theme, cmd: impl Into<SharedString>, copy: Stateful<Div>) -> Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .pl_2()
        .pr_1()
        .py_0p5()
        .rounded(px(radius::SM))
        .bg(t.selected)
        .child(div().flex_1().min_w_0().whitespace_normal().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(cmd.into()))
        .child(copy)
}

/// The frame around a text field: hairline border, focus ring when focused. The field itself is the
/// `TextInput` entity, created `.borderless()` and rendered as this frame's child.
pub fn field(t: &Theme, focused: bool) -> Div {
    div()
        .min_h(px(metric::FIELD))
        .flex()
        .items_center()
        .rounded(px(radius::SM))
        .border_1()
        .border_color(if focused { t.accent } else { t.border })
        .bg(t.bg)
        .when(focused, |d| d.shadow(t.focus_ring()))
}

/// A clickable list row: full width, fixed height, hover and selected overlays. Inset it by giving its list
/// horizontal padding.
///
/// `flex_none`: a list is a flex column, and a flex item shrinks when the column overflows. `overflow_hidden` sets
/// its automatic min height to 0, so in a list longer than its scroll area every row shrank to nothing and the
/// labels painted over each other (Settings → Prompts with the hub's 60 prompts; the bench's 9 fit).
pub fn row(t: &Theme, id: impl Into<ElementId>, selected: bool) -> Stateful<Div> {
    let hover = t.hover;
    clickable(t, div().id(id))
        .w_full()
        .h(px(metric::ROW))
        .flex_none()
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(radius::SM))
        .whitespace_nowrap()
        .overflow_hidden()
        .when(selected, |d| d.bg(t.selected))
        .when(!selected, |d| d.hover(move |s| s.bg(hover)))
}

/// A table: `cols` columns, each as wide as its widest cell, every row as tall as its tallest cell. Add the cells
/// row by row as direct children. Use it instead of fixed-height rows of fixed-width cells: a cell that does not fit
/// (a longer id, a wider platform font) wraps and pushes its row down instead of painting over the next one.
pub fn table(cols: u16) -> Div {
    div().grid().grid_cols_max_content(cols).gap_x_3().gap_y_0p5()
}

/// A floating surface (palette, composer): raised tone, hairline, one soft shadow.
pub fn floating(t: &Theme) -> Div {
    div().bg(t.raised).border_1().border_color(t.border).rounded(px(radius::LG)).shadow(t.float_shadow()).overflow_hidden()
}
