//! The lane sparkline: the last minute of real work in 30 two-second buckets (tool calls started and model
//! output streamed, as the hub counts them). An idle lane is a flat baseline. When a bucket arrives the bars
//! shift left one slot over 180 ms; under reduce-motion they jump.

use std::time::{SystemTime, UNIX_EPOCH};

use fleetd_contracts::live::{SPARK_BUCKETS, Spark};
use gpui::{Animation, AnimationExt, AnyElement, Bounds, ElementId, Hsla, Pixels, canvas, div, fill, point, prelude::*, px, size};

use super::motion::dur;
use super::state::parse_ms;
use crate::theme::Theme;

/// Below this the scale stays put, so one tool call reads as a small bar, not a full one.
const PEAK_FLOOR: u8 = 48;

/// Bar heights in pixels, oldest first, always `SPARK_BUCKETS` of them: short sparks are padded on the left
/// with idle buckets. Every bar is at least 1 px, which draws the baseline.
pub fn bar_heights(samples: &[u8], height: f32) -> Vec<f32> {
    let pad = SPARK_BUCKETS.saturating_sub(samples.len());
    let tail = &samples[samples.len().saturating_sub(SPARK_BUCKETS)..];
    let peak = tail.iter().copied().max().unwrap_or(0).max(PEAK_FLOOR) as f32;
    std::iter::repeat_n(0u8, pad).chain(tail.iter().copied()).map(|s| (height * s as f32 / peak).round().clamp(1., height)).collect()
}

/// The sparkline, `width` × `height`. Render it inside an element with a unique id (the lane row): the shift
/// animation is keyed by the bucket it shows.
pub fn sparkline(t: &Theme, spark: Option<&Spark>, width: Pixels, height: Pixels) -> AnyElement {
    let samples: &[u8] = spark.map_or(&[], |s| &s.samples);
    let bars = bar_heights(samples, f32::from(height));
    let (faint, newest) = (t.faint, t.quiet);
    let slot = width / SPARK_BUCKETS as f32;
    let paint = canvas(|_, _, _| (), move |bounds, _, window, _| paint_bars(bounds, &bars, faint, newest, window)).w(width).h(height);
    let plot = div().absolute().top_0().left_0().w(width).h(height).child(paint);
    let fresh = spark.and_then(|s| parse_ms(s.end_at.as_str())).is_some_and(|end| now_ms() - end < 2_200);
    let plot: AnyElement = match spark {
        // Only a bucket that just closed slides in; a sparkline mounting with old data sits still.
        Some(s) if fresh => plot
            .with_animation(ElementId::from(format!("spark-{}", s.end_at)), Animation::new(dur::SPARK), move |d, p| d.left(slot * (1. - p)))
            .into_any_element(),
        _ => plot.into_any_element(),
    };
    div().relative().flex_none().overflow_hidden().w(width).h(height).child(plot).into_any_element()
}

fn paint_bars(bounds: Bounds<Pixels>, bars: &[f32], faint: Hsla, newest: Hsla, window: &mut gpui::Window) {
    let scale = window.scale_factor();
    let slot = f32::from(bounds.size.width) / bars.len().max(1) as f32;
    // A 1-device-pixel gap between bars once they are wide enough to keep one; on a 1x display they touch.
    let gap = if slot * scale >= 3. { 1. / scale } else { 0. };
    let snap = |v: f32| (v * scale).round() / scale;
    let bottom = f32::from(bounds.origin.y + bounds.size.height);
    for (i, &h) in bars.iter().enumerate() {
        let x0 = snap(f32::from(bounds.origin.x) + slot * i as f32);
        let x1 = snap(f32::from(bounds.origin.x) + slot * (i + 1) as f32) - gap;
        let color = if i + 1 == bars.len() { newest } else { faint };
        window.paint_quad(fill(Bounds::new(point(px(x0), px(bottom - h)), size(px((x1 - x0).max(1. / scale)), px(h))), color));
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_is_a_baseline_and_short_sparks_pad_on_the_left() {
        assert_eq!(bar_heights(&[], 12.), vec![1.; 30]);
        let bars = bar_heights(&[48, 24], 12.);
        assert_eq!(bars.len(), 30);
        assert_eq!(&bars[28..], &[12., 6.]);
        assert!(bars[..28].iter().all(|&h| h == 1.));
    }

    #[test]
    fn scale_follows_the_busiest_bucket_above_a_floor() {
        // One tool call (16) against the floor: a third of the height, not all of it.
        assert_eq!(bar_heights(&[16], 12.)[29], 4.);
        // A busy minute scales to its own peak.
        let bars = bar_heights(&[255, 128, 0], 12.);
        assert_eq!(&bars[27..], &[12., 6., 1.]);
        // More than 30 samples: the newest 30.
        assert_eq!(bar_heights(&[255; 40], 12.).len(), 30);
    }
}
