//! The lane sparkline: the last minute of real work in 30 two-second buckets (tool calls started and model
//! output streamed, as the hub counts them), in the lane's role tint. Only the lane's own life is drawn: a lane
//! that started 10 s ago has five slots, growing in from the right, not a minute of baseline it never lived. A
//! quiet bucket is a 1 px baseline. When a bucket arrives the bars shift left one slot over 180 ms; under
//! reduce-motion they jump.

use std::time::{SystemTime, UNIX_EPOCH};

use fleetd_contracts::live::{SPARK_BUCKET_SECS, SPARK_BUCKETS, Spark};
use gpui::{Animation, AnimationExt, AnyElement, Bounds, ElementId, Hsla, Pixels, canvas, div, fill, point, prelude::*, px, size};

use super::motion::dur;
use super::state::parse_ms;

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

/// How many of the `SPARK_BUCKETS` slots, counted from the left, end before the lane started: those are not
/// drawn. Unknown start: all slots are drawn.
pub fn unlived(end_ms: i64, started_ms: Option<i64>) -> usize {
    let Some(start) = started_ms else { return 0 };
    let bucket_ms = SPARK_BUCKET_SECS as i64 * 1000;
    // Slot i ends at end - (SPARK_BUCKETS - 1 - i) buckets; it was lived if it ends after the start.
    (0..SPARK_BUCKETS).take_while(|&i| end_ms - (SPARK_BUCKETS - 1 - i) as i64 * bucket_ms <= start).count()
}

/// The fewest slots the width is divided into: a young lane's few buckets draw as bars you can read, not as
/// slivers at the right edge of a minute it hasn't lived; as it ages the bars narrow to the full minute.
const MIN_SLOTS: usize = 15;

/// The sparkline, `width` × `height`, in `tint`. Render it inside an element with a unique id (the lane row): the
/// shift animation is keyed by the bucket it shows.
pub fn sparkline(spark: Option<&Spark>, started_ms: Option<i64>, tint: Hsla, width: Pixels, height: Pixels) -> AnyElement {
    // No spark yet (the feed hasn't sent one): nothing to draw, not a baseline that would claim the lane is idle.
    let Some(spark) = spark else { return div().flex_none().w(width).h(height).into_any_element() };
    let samples: &[u8] = &spark.samples;
    let all = bar_heights(samples, f32::from(height));
    let end = parse_ms(spark.end_at.as_str());
    let lived = SPARK_BUCKETS - end.map_or(0, |end| unlived(end, started_ms));
    let shown = lived.clamp(MIN_SLOTS, SPARK_BUCKETS);
    let mut bars = all[SPARK_BUCKETS - shown..].to_vec();
    // Slots in the window from before the lane started stay empty.
    for b in bars.iter_mut().take(shown - lived.min(shown)) {
        *b = 0.;
    }
    // Older buckets recede; the newest, the one that just moved, is the full tint.
    let (older, newest) = (tint.opacity(0.55), tint);
    let slot = width / shown as f32;
    let paint = canvas(|_, _, _| (), move |bounds, _, window, _| paint_bars(bounds, &bars, older, newest, window)).w(width).h(height);
    let plot = div().absolute().top_0().left_0().w(width).h(height).child(paint);
    // Only a bucket that just closed slides in; a sparkline mounting with old data sits still.
    let fresh = end.is_some_and(|end| now_ms() - end < 2_200);
    let plot: AnyElement = if fresh {
        plot.with_animation(ElementId::from(format!("spark-{}", spark.end_at)), Animation::new(dur::SPARK), move |d, p| d.left(slot * (1. - p)))
            .into_any_element()
    } else {
        plot.into_any_element()
    };
    div().relative().flex_none().overflow_hidden().w(width).h(height).child(plot).into_any_element()
}

/// A bar of height 0 is a slot outside the lane's life: nothing is drawn there.
fn paint_bars(bounds: Bounds<Pixels>, bars: &[f32], older: Hsla, newest: Hsla, window: &mut gpui::Window) {
    let scale = window.scale_factor();
    let slot = f32::from(bounds.size.width) / bars.len().max(1) as f32;
    // A 1-device-pixel gap between bars once they are wide enough to keep one; on a 1x display they touch.
    let gap = if slot * scale >= 3. { 1. / scale } else { 0. };
    let snap = |v: f32| (v * scale).round() / scale;
    let bottom = f32::from(bounds.origin.y + bounds.size.height);
    for (i, &h) in bars.iter().enumerate().filter(|(_, h)| **h > 0.) {
        let x0 = snap(f32::from(bounds.origin.x) + slot * i as f32);
        let x1 = snap(f32::from(bounds.origin.x) + slot * (i + 1) as f32) - gap;
        // A quiet bucket is a baseline: there, but not a bar.
        let color = if h <= 1. {
            older.opacity(0.5)
        } else if i + 1 == bars.len() {
            newest
        } else {
            older
        };
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
    fn only_the_lanes_own_life_is_drawn() {
        let end = 1_000_000;
        // Started 10 s before the newest bucket ended: that bucket and the four before it.
        assert_eq!(unlived(end, Some(end - 10_000)), SPARK_BUCKETS - 5);
        assert_eq!(unlived(end, Some(end - 1)), SPARK_BUCKETS - 1);
        assert_eq!(unlived(end, Some(end - 120_000)), 0);
        assert_eq!(unlived(end, None), 0);
        // Started after the newest bucket ended: nothing lived yet.
        assert_eq!(unlived(end, Some(end + 500)), SPARK_BUCKETS);
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
