//! In-app speed instrumentation, driven by `FLEETD_BENCH=<mode>` (see app/bench/run.sh).
//!
//! Present timestamps come from gpui's profiler journal (the `profiler` feature Zed ships with): each
//! newly drawn frame records a Draw event followed by its Present, with exact `Instant`s, so how late we
//! poll the journal never biases a measurement. Results go to stdout as `FLEETD_BENCH key=value ...`.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{FrameEvent, FrameTimingCollector};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Report the first presented frame, then quit.
    Cold,
    /// Report the first presented frame, then sit idle until killed.
    Idle,
    /// Dispatch 200 keystrokes through gpui's own keystroke dispatch; report key -> present.
    KeysInternal,
    /// The driver types through XTEST; report key -> present for each key received.
    KeysExternal,
    /// Scroll the log programmatically for 5 s; report presented fps and the worst frame interval.
    Scroll,
}

impl Mode {
    pub fn from_env() -> Option<Self> {
        Some(match std::env::var("FLEETD_BENCH").ok()?.as_str() {
            "cold" => Mode::Cold,
            "idle" => Mode::Idle,
            "keys-internal" => Mode::KeysInternal,
            "keys-external" => Mode::KeysExternal,
            "scroll" => Mode::Scroll,
            other => panic!("unknown FLEETD_BENCH mode {other:?}"),
        })
    }
}

pub const KEYSTROKES: usize = 200;
pub const SCROLL_FOR: Duration = Duration::from_secs(5);

/// Simplified frame journal entry, so the matching logic is testable without a window.
#[derive(Clone, Copy, Debug)]
pub enum Frame {
    Draw { start: Instant },
    Present { end: Instant },
}

pub struct Probe {
    clock: (Instant, SystemTime),
    collector: FrameTimingCollector,
    pub first_draw: Option<Instant>,
    /// Frames drawn up to and including the first presented one (gpui drops presents of frames drawn
    /// before the window was visible).
    pub draws_to_first_present: usize,
    pub first_present: Option<Instant>,
    pending_keys: Vec<(Instant, String)>,
    last_draw: Option<Instant>,
    pub presents: Vec<Instant>,
    pub keys_received: usize,
    pub scroll_started: Option<Instant>,
}

impl Probe {
    pub fn new() -> Self {
        gpui::set_trace_enabled(true);
        Self {
            clock: (Instant::now(), SystemTime::now()),
            collector: FrameTimingCollector::new(),
            first_draw: None,
            draws_to_first_present: 0,
            first_present: None,
            pending_keys: Vec::new(),
            last_draw: None,
            presents: Vec::new(),
            keys_received: 0,
            scroll_started: None,
        }
    }

    pub fn unix_ns(&self, at: Instant) -> u128 {
        let since_epoch = self.clock.1.duration_since(UNIX_EPOCH).unwrap();
        (since_epoch + at.duration_since(self.clock.0)).as_nanos()
    }

    pub fn key_received(&mut self, at: Instant, key: &str) {
        self.keys_received += 1;
        self.pending_keys.push((at, key.to_string()));
    }

    /// Drains the journal. Returns (key, key -> present latency) resolved by this poll.
    pub fn poll(&mut self) -> Vec<(String, Duration)> {
        let frames: Vec<Frame> = self
            .collector
            .collect_unseen()
            .into_iter()
            .map(|event| match event {
                FrameEvent::Draw(t) => Frame::Draw { start: t.draw_start },
                FrameEvent::Present(t) => Frame::Present { end: t.present_end },
            })
            .collect();
        for frame in &frames {
            match *frame {
                Frame::Draw { start } => {
                    self.first_draw.get_or_insert(start);
                    if self.first_present.is_none() {
                        self.draws_to_first_present += 1;
                    }
                }
                Frame::Present { end } => {
                    self.first_present.get_or_insert(end);
                    self.presents.push(end);
                }
            }
        }
        match_keys(&mut self.pending_keys, &mut self.last_draw, &frames)
    }

    pub fn emit(&self, fields: &str) {
        println!("FLEETD_BENCH {fields}");
    }
}

/// A key's echo is in the first frame whose draw started after the key handler ran (single-threaded:
/// the draw cannot start until the handler returns). Its latency ends when that frame's Present ends.
pub fn match_keys<K>(pending: &mut Vec<(Instant, K)>, last_draw: &mut Option<Instant>, frames: &[Frame]) -> Vec<(K, Duration)> {
    let mut out = Vec::new();
    for frame in frames {
        match *frame {
            Frame::Draw { start } => *last_draw = Some(start),
            Frame::Present { end } => {
                let Some(draw_start) = last_draw.take() else { continue };
                let (done, waiting): (Vec<_>, Vec<_>) = pending.drain(..).partition(|(at, _)| *at <= draw_start);
                *pending = waiting;
                out.extend(done.into_iter().map(|(at, key)| (key, end.duration_since(at))));
            }
        }
    }
    out
}

/// Presented frames per second and the longest gap between presents over `[start, end]`.
pub fn scroll_stats(presents: &[Instant], start: Instant, end: Instant) -> (f64, Duration) {
    let inside: Vec<Instant> = presents.iter().copied().filter(|&p| p >= start && p <= end).collect();
    let mut worst = Duration::ZERO;
    let mut prev = start;
    for &p in inside.iter().chain(std::iter::once(&end)) {
        worst = worst.max(p.duration_since(prev));
        prev = p;
    }
    (inside.len() as f64 / end.duration_since(start).as_secs_f64(), worst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    #[test]
    fn key_resolves_at_first_frame_drawn_after_it() {
        let t = Instant::now();
        let mut pending = vec![(ms(t, 5), 'a')];
        let mut last = None;
        let frames = [
            // Frame drawn before the key arrived: does not contain the echo.
            Frame::Draw { start: ms(t, 0) },
            Frame::Present { end: ms(t, 8) },
            Frame::Draw { start: ms(t, 16) },
            Frame::Present { end: ms(t, 20) },
        ];
        assert_eq!(match_keys(&mut pending, &mut last, &frames), vec![('a', Duration::from_millis(15))]);
        assert!(pending.is_empty());
    }

    #[test]
    fn unpresented_key_stays_pending_across_polls() {
        let t = Instant::now();
        let mut pending = vec![(ms(t, 5), 'a')];
        let mut last = None;
        // Draw recorded in one poll, its Present in the next.
        assert!(match_keys(&mut pending, &mut last, &[Frame::Draw { start: ms(t, 6) }]).is_empty());
        assert_eq!(pending.len(), 1);
        let got = match_keys(&mut pending, &mut last, &[Frame::Present { end: ms(t, 9) }]);
        assert_eq!(got, vec![('a', Duration::from_millis(4))]);
    }

    #[test]
    fn scroll_worst_frame_includes_edges() {
        let t = Instant::now();
        let presents = [ms(t, 10), ms(t, 20), ms(t, 60), ms(t, 70)];
        let (fps, worst) = scroll_stats(&presents, t, ms(t, 100));
        assert_eq!(fps, 40.0);
        assert_eq!(worst, Duration::from_millis(40));
    }
}
