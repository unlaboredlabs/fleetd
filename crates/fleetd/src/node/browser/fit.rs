//! A watched screen's live frames, fitted to what its slowest watcher's link takes ([`FrameSlot::budget`], the hub's
//! estimate in kbit/s), for every kind of screen alike. Without a budget each frame goes as its kind made it, as soon
//! as it comes. With one, frames aim at [`AIM`] of it: each waits until the one before has had its time on the link,
//! and when even [`MIN_FPS`] frames a second at the kind's own quality wouldn't fit, a frame is encoded again at a
//! lower one first. Only the live view's copy: the session's video keeps every frame as it was.
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::BrowserFrame;
use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::prim::NonEmpty;

use super::FrameSlot;
use crate::node::wire::to_json;

/// The share of the budget frames aim at, for the estimate's error and the rest of the link's traffic.
const AIM: f64 = 0.8;
/// Below this many frames a second at a quality, a lower one goes instead.
const MIN_FPS: f64 = 3.0;
/// The longest a frame waits for the link: a slower one only drops more of them (its slot keeps the newest).
const MAX_WAIT: Duration = Duration::from_secs(2);
/// The qualities a tight budget steps down through (4:2:0), after the kind's own (tier 0), and each one's size
/// against a kind's own frame ([`SIZES`], a page of text from Chrome's quality 70 and Android's): an encode again
/// loses more than the quality says, so the steps are few and far apart. Under 25, text rings.
const QUALITIES: [u8; 3] = [0, 40, 25];
const SIZES: [f64; 3] = [1.0, 0.64, 0.5];

/// The frames that went to one watcher: how big the last was, when, and at which tier.
#[derive(Default)]
pub struct Pacer {
    last: Option<(Instant, usize, usize)>,
}

/// Bytes a second the frames aim at.
fn rate(kbps: u32) -> f64 {
    f64::from(kbps.max(1)) * 1000.0 / 8.0 * AIM
}

/// The best tier whose frames fit [`MIN_FPS`] a second into `rate`, for frames of `full` bytes at the kind's own
/// quality; the lowest when none does.
fn tier(rate: f64, full: f64) -> usize {
    (0..SIZES.len())
        .find(|t| full * SIZES[*t] * MIN_FPS <= rate)
        .unwrap_or(SIZES.len() - 1)
}

impl Pacer {
    /// How long the next frame waits for the link: none without a budget.
    pub fn wait(&self, kbps: Option<u32>) -> Duration {
        let (Some(kbps), Some((at, bytes, _))) = (kbps, self.last) else {
            return Duration::ZERO;
        };
        let due = at + Duration::from_secs_f64(bytes as f64 / rate(kbps)).min(MAX_WAIT);
        due.saturating_duration_since(Instant::now())
    }

    /// The frame as it goes to the watcher: itself, or under a tight budget the same screen at a lower quality.
    pub fn fit(&mut self, kbps: Option<u32>, frame: BrowserFrame) -> BrowserFrame {
        let bytes = |f: &BrowserFrame| f.jpeg_b64.as_str().len() / 4 * 3;
        let tier = match (kbps, self.last) {
            (Some(kbps), Some((_, bytes, was))) => tier(rate(kbps), bytes as f64 / SIZES[was]),
            _ => 0,
        };
        let smaller = (tier > 0)
            .then(|| B64.decode(frame.jpeg_b64.as_str()).ok())
            .flatten()
            .and_then(|jpeg| Some((reencode(&jpeg, QUALITIES[tier]).ok()?, jpeg.len())))
            .filter(|(smaller, was)| smaller.len() < *was);
        let (frame, tier) = match smaller {
            Some((jpeg, _)) => (
                BrowserFrame {
                    jpeg_b64: NonEmpty::unchecked(B64.encode(&jpeg)),
                    ..frame
                },
                tier,
            ),
            None => (frame, 0),
        };
        self.last = Some((Instant::now(), bytes(&frame), tier));
        frame
    }
}

/// `frame` into the watcher's slot, fitted to its budget.
pub fn offer(slot: &FrameSlot, pacer: &mut Pacer, frame: BrowserFrame) {
    let session = frame.session_id.clone();
    let frame = pacer.fit(slot.budget(session.as_str()), frame);
    slot.replace(session.as_str(), to_json(&NodeToHub::BrowserFrame(frame)));
}

/// A JPEG again at `quality`, 4:2:0.
pub fn reencode(jpeg: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let pixels = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?
        .into_rgb8();
    let (width, height) = pixels.dimensions();
    let mut out = Vec::with_capacity(jpeg.len());
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder.set_optimized_huffman_tables(true);
    encoder
        .encode(
            &pixels,
            u16::try_from(width).map_err(|e| e.to_string())?,
            u16::try_from(height).map_err(|e| e.to_string())?,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_budget_picks_the_best_quality_that_still_moves() {
        // 100 KB frames: 3 a second need 3 Mbit/s at 80%.
        assert_eq!(tier(rate(10_000), 100_000.0), 0);
        assert_eq!(tier(rate(3_000), 100_000.0), 0);
        assert_eq!(tier(rate(2_500), 100_000.0), 1);
        assert_eq!(tier(rate(1_920), 100_000.0), 1);
        assert_eq!(tier(rate(1_700), 100_000.0), 2);
        assert_eq!(tier(rate(100), 100_000.0), 2);
    }

    #[test]
    fn frames_wait_their_time_on_the_link_and_none_without_a_budget() {
        let mut pacer = Pacer::default();
        assert_eq!(
            pacer.wait(Some(100)),
            Duration::ZERO,
            "the first goes at once"
        );
        pacer.last = Some((Instant::now(), 50_000, 0));
        assert_eq!(pacer.wait(None), Duration::ZERO);
        // 50 KB at 80% of 1 Mbit/s: half a second.
        let wait = pacer.wait(Some(1_000));
        assert!(
            wait > Duration::from_millis(450) && wait <= Duration::from_millis(500),
            "{wait:?}"
        );
        assert!(pacer.wait(Some(1)) <= MAX_WAIT);
    }

    fn frame(jpeg: &[u8]) -> BrowserFrame {
        BrowserFrame {
            session_id: fleetd_contracts::browser::BrowserSessionId::unchecked("s1"),
            seq: 1,
            jpeg_b64: NonEmpty::unchecked(B64.encode(jpeg)),
            width: fleetd_contracts::prim::Int::unchecked(320),
            height: fleetd_contracts::prim::Int::unchecked(200),
            url: None,
            control: Default::default(),
        }
    }

    #[test]
    fn a_tight_budget_sends_the_screen_smaller_and_none_leaves_it_be() {
        // Busy pixels at quality 90: what a lower tier has room to shrink.
        let pixels: Vec<u8> = (0..320 * 200 * 3)
            .map(|i: u32| (i * 7919 % 251) as u8)
            .collect();
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 90)
            .encode(&pixels, 320, 200, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        let mut pacer = Pacer::default();
        let same = pacer.fit(None, frame(&jpeg));
        assert_eq!(same.jpeg_b64.as_str(), B64.encode(&jpeg));
        let same = pacer.fit(Some(100_000), frame(&jpeg));
        assert_eq!(
            same.jpeg_b64.as_str(),
            B64.encode(&jpeg),
            "a fast link takes it as it is"
        );
        let small = pacer.fit(Some(50), frame(&jpeg));
        let small = B64.decode(small.jpeg_b64.as_str()).unwrap();
        assert!(
            small.len() < jpeg.len() * 3 / 4,
            "{} of {}",
            small.len(),
            jpeg.len()
        );
        let shown = image::load_from_memory(&small).unwrap();
        assert_eq!((shown.width(), shown.height()), (320, 200));
    }
}
