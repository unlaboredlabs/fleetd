//! Small building blocks every screen shares, styled only from the [`Theme`]. Screens compose these; they do
//! not restyle them.

use gpui::{App, ClipboardItem, Div, ElementId, Hsla, SharedString, Stateful, Window, div, prelude::*, px};

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
    let base = match variant {
        Variant::Primary => base.bg(t.accent_fill).text_color(t.on_accent).font_weight(STRONG),
        Variant::Secondary => base.border_1().border_color(t.border).text_color(t.text),
        Variant::Ghost => base.text_color(t.quiet),
        Variant::Danger => base.border_1().border_color(t.danger).text_color(t.danger),
    };
    if !enabled {
        return base.opacity(0.45);
    }
    let hover = t.hover;
    let text = t.text;
    base.cursor_pointer().hover(move |s| match variant {
        Variant::Primary => s.opacity(0.88),
        Variant::Ghost => s.bg(hover).text_color(text),
        _ => s.bg(hover),
    })
}

/// A 7 px status dot. A drawn circle, not a "●" glyph, so it centres the same in every font.
pub fn dot(color: Hsla) -> Div {
    div().size(px(7.)).flex_none().rounded_full().bg(color)
}

/// A count after a row label. Loud counts (open asks: something needs you) are a filled pill in the text
/// colour; quiet counts are faint numerals.
pub fn count(t: &Theme, n: usize, loud: bool) -> Div {
    let base = div().flex_none().text_size(px(size::XS)).child(n.to_string());
    if loud {
        base.min_w(px(18.)).h(px(16.)).px_1p5().flex().items_center().justify_center().rounded_full().bg(t.text).text_color(t.bg).font_weight(STRONG)
    } else {
        base.text_color(t.faint)
    }
}

/// The unread mark: a small accent dot before a row's label.
pub fn unread(t: &Theme) -> Div {
    div().size(px(6.)).flex_none().rounded_full().bg(t.accent)
}

/// A keyboard shortcut hint, e.g. "⌘K".
pub fn kbd(t: &Theme, keys: impl Into<SharedString>) -> Div {
    div().flex_none().text_size(px(size::XS)).text_color(t.faint).child(keys.into())
}

/// Shortcut text for this platform: `"K"` -> "⌘K" on macOS, "Ctrl+K" elsewhere.
pub fn shortcut(key: &str) -> String {
    if cfg!(target_os = "macos") { format!("⌘{key}") } else { format!("Ctrl+{key}") }
}

/// A group label inside a list or a form: small, semibold, quiet. Sentence case, no tracking.
pub fn section(t: &Theme, label: impl Into<SharedString>) -> Div {
    div().pt_4().pb_1().text_size(px(size::XS)).font_weight(STRONG).text_color(t.quiet).child(label.into())
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

/// An error: what went wrong in text colour, the fix below it (a command when there is one, with Copy).
pub fn error(t: &Theme, id: impl Into<SharedString>, message: impl Into<SharedString>, fix: Option<SharedString>, copied: bool) -> Div {
    let id = id.into();
    let message = message.into();
    div()
        .max_w(px(metric::MEASURE))
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .items_start()
                .gap_2()
                .child(div().pt(px(5.)).child(dot(t.danger)))
                .child(div().flex_1().min_w_0().whitespace_normal().child(message.clone()))
                .child(copy_button(t, SharedString::from(format!("{id}-copy")), message, copied)),
        )
        .when_some(fix, |d, fix| d.child(div().pl(px(15.)).text_color(t.quiet).whitespace_normal().child(fix)))
}

/// "Copy" that writes `text` to the clipboard. The caller tracks what was copied last and passes `copied` so
/// the label can say "Copied".
pub fn copy_button(t: &Theme, id: impl Into<ElementId>, text: impl Into<SharedString>, copied: bool) -> Stateful<Div> {
    let text = text.into();
    button(t, id, if copied { "Copied" } else { "Copy" }, Variant::Ghost, true)
        .on_click(move |_, _: &mut Window, cx: &mut App| cx.write_to_clipboard(ClipboardItem::new_string(text.to_string())))
}

/// A command to run by hand: mono, on a one-step tone, with its Copy button.
pub fn command(t: &Theme, id: impl Into<SharedString>, cmd: impl Into<SharedString>, copied: bool) -> Div {
    let id = id.into();
    let cmd = cmd.into();
    div()
        .flex()
        .items_center()
        .gap_2()
        .pl_2()
        .pr_1()
        .py_0p5()
        .rounded(px(radius::SM))
        .bg(t.selected)
        .child(div().flex_1().min_w_0().whitespace_normal().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(cmd.clone()))
        .child(copy_button(t, SharedString::from(format!("{id}-copy")), cmd, copied))
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
pub fn row(t: &Theme, id: impl Into<ElementId>, selected: bool) -> Stateful<Div> {
    let hover = t.hover;
    div()
        .id(id)
        .w_full()
        .h(px(metric::ROW))
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(radius::SM))
        .whitespace_nowrap()
        .overflow_hidden()
        .cursor_pointer()
        .when(selected, |d| d.bg(t.selected))
        .when(!selected, |d| d.hover(move |s| s.bg(hover)))
}

/// A floating surface (palette, composer): raised tone, hairline, one soft shadow.
pub fn floating(t: &Theme) -> Div {
    div().bg(t.raised).border_1().border_color(t.hairline).rounded(px(radius::LG)).shadow(t.float_shadow()).overflow_hidden()
}
