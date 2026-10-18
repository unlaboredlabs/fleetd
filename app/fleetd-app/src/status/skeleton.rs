//! What the view shows until the hub answers after opening or reconnecting: the shape of the page in `faint`,
//! with no digits, so nothing old or guessed reads as a number.

use gpui::{Div, div, prelude::*, px};

use crate::theme::{STRONG, Theme, metric, radius, size};

pub fn render(t: &Theme) -> Div {
    let bar = |w: f32| div().w(px(w)).h(px(8.)).rounded_full().border_1().border_color(t.faint);
    let head = |label: &'static str| div().pt_6().pb_1().px_2().text_size(px(size::XS)).font_weight(STRONG).text_color(t.faint).child(label);
    let row = || div().px_2().h(px(metric::ROW)).flex().items_center().gap_3().child(bar(44.)).child(bar(220.)).child(bar(160.));
    div()
        .pt_6()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_center()
                .gap_4()
                .child(div().w(px(72.)).h(px(size::DISPLAY + 4.)).rounded(px(radius::MD)).border_1().border_color(t.faint))
                .child(div().flex_1().h(px(6.)).rounded_full().border_1().border_color(t.faint)),
        )
        .child(div().pt_4().flex().flex_col().gap_2().child(bar(520.)).child(bar(360.)).child(bar(300.)))
        .child(div().mt_4().h(px(44.)).border_t_1().border_b_1().border_color(t.hairline))
        .child(head("Needs you"))
        .child(row())
        .child(head("Risks"))
        .child(row())
        .child(head("In progress"))
        .child(row())
        .child(row())
        .child(head("Next up"))
        .child(row())
        .child(head("Done"))
        .child(row())
}
