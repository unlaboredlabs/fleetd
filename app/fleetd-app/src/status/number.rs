//! The progress number and its bar. They move together, once, when the figure really changes within one live
//! session: never on the first paint, after a skeleton, or on a scope switch. Under reduce-motion gpui draws the
//! end state at once. Nothing here runs between changes.

use std::time::Duration;

use gpui::{Animation, AnimationExt, AnyElement, SharedString, div, ease_out_quint, prelude::*, px, relative};

use crate::theme::{STRONG, Theme, size};

pub const TWEEN: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tween {
    pub from: i64,
    pub to: i64,
    /// Identifies this change, so each one plays once.
    pub key: u64,
}

#[derive(Default)]
pub struct Number {
    shown: Option<(u64, i64)>,
    tween: Option<Tween>,
    next_key: u64,
}

impl Number {
    /// The figure about to be drawn, in `session`; returns the tween to draw it with, if it changed under the
    /// reader's eyes.
    pub fn update(&mut self, session: u64, pct: i64) -> Option<Tween> {
        match self.shown {
            Some((s, p)) if s == session && p != pct => {
                self.next_key += 1;
                self.tween = Some(Tween { from: p, to: pct, key: self.next_key });
            }
            Some((s, _)) if s == session => {}
            _ => self.tween = None,
        }
        self.shown = Some((session, pct));
        self.tween
    }
}

fn lerp(tw: Tween, p: f32) -> f32 {
    tw.from as f32 + (tw.to - tw.from) as f32 * p
}

/// "72%", at display size.
pub fn figure(t: &Theme, pct: i64, tween: Option<Tween>) -> AnyElement {
    let base = div().flex_none().text_size(px(size::DISPLAY)).line_height(px(size::DISPLAY + 4.)).font_weight(STRONG).text_color(t.text);
    match tween {
        Some(tw) => base
            .with_animation(SharedString::from(format!("status-pct-{}", tw.key)), Animation::new(TWEEN).with_easing(ease_out_quint()), move |d, p| {
                d.child(format!("{}%", lerp(tw, p).round() as i64))
            })
            .into_any_element(),
        None => base.child(format!("{pct}%")).into_any_element(),
    }
}

/// The bar beside the figure: the verified share filled, the rest a hairline track.
pub fn bar(t: &Theme, pct: i64, tween: Option<Tween>, height: f32) -> AnyElement {
    let fill = div().h_full().rounded_full().bg(t.quiet);
    let fill = match tween {
        Some(tw) => fill
            .with_animation(SharedString::from(format!("status-bar-{}", tw.key)), Animation::new(TWEEN).with_easing(ease_out_quint()), move |d, p| {
                d.w(relative((lerp(tw, p) / 100.).clamp(0., 1.)))
            })
            .into_any_element(),
        None => fill.w(relative((pct as f32 / 100.).clamp(0., 1.))).into_any_element(),
    };
    div().w_full().h(px(height)).rounded_full().bg(t.hairline).overflow_hidden().child(fill).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tweens_only_on_a_real_change_within_one_session() {
        let mut n = Number::default();
        assert_eq!(n.update(1, 72), None, "first paint");
        assert_eq!(n.update(1, 72), None, "a redraw with the same figure");
        let tw = n.update(1, 75).expect("a real change");
        assert_eq!((tw.from, tw.to), (72, 75));
        assert_eq!(n.update(1, 75), Some(tw), "the same change, so the same animation: it does not replay");
        assert_eq!(n.update(2, 80), None, "after a skeleton or a scope switch");
        let again = n.update(2, 78).unwrap();
        assert_ne!(again.key, tw.key);
    }
}
