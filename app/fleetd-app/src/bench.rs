//! In-app speed instrumentation, driven by `FLEETD_BENCH=<mode>` (see app/bench/run.sh).
//!
//! Present timestamps come from gpui's profiler journal (the `profiler` feature Zed ships with): each
//! newly drawn frame records a Draw event followed by its Present, with exact `Instant`s, so how late we
//! poll the journal never biases a measurement. Results go to stdout as `FLEETD_BENCH key=value ...`.
//!
//! Startup progress goes to stderr as `FLEETD_BENCH stage=<name> t_ms=<since main> ...`, and a watchdog
//! thread ends a run that hasn't presented a frame in time, naming the last stage reached. That is what
//! tells an unattended run on a machine nobody can see (a Mac reached over chat) where startup stopped.

use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{App, Bounds, Context, FrameEvent, FrameTimingCollector, Pixels, Window};

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
    /// The live lanes board (live/fixture.rs) under the scripted feed: frame times while it animates, then
    /// presented frames with the feed paused.
    Live,
}

impl Mode {
    const NAMES: &str = "cold, idle, keys-internal, keys-external, scroll or live";

    /// `FLEETD_BENCH`, unset or empty meaning no bench. Read before gpui starts, so a bad value is an error
    /// message instead of a panic inside AppKit's launch callback.
    pub fn from_env() -> Result<Option<Self>, String> {
        match std::env::var("FLEETD_BENCH") {
            Ok(v) if !v.is_empty() => Self::parse(&v).map(Some),
            _ => Ok(None),
        }
    }

    fn parse(name: &str) -> Result<Self, String> {
        Ok(match name {
            "cold" => Mode::Cold,
            "idle" => Mode::Idle,
            "keys-internal" => Mode::KeysInternal,
            "keys-external" => Mode::KeysExternal,
            "scroll" => Mode::Scroll,
            "live" => Mode::Live,
            other => {
                return Err(format!(
                    "FLEETD_BENCH={other:?} is not a bench mode; use {}. The fleetd-bench driver sets it for you (app/bench/MAC-RUN.md).",
                    Self::NAMES
                ));
            }
        })
    }
}

/// Set first thing in `main`; stage times count from it.
static START: OnceLock<Instant> = OnceLock::new();
/// (last stage reached, whether a frame has been presented).
static PROGRESS: Mutex<(&str, bool)> = Mutex::new(("none", false));
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

pub fn mark_start() {
    START.get_or_init(Instant::now);
}

/// One startup milestone on stderr (stdout carries only results, for the driver).
pub fn stage(name: &'static str, detail: &str) {
    let t_ms = START.get().map_or(0., |s| s.elapsed().as_secs_f64() * 1000.);
    let mut progress = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    progress.0 = name;
    progress.1 |= name == "first_present";
    let sep = if detail.is_empty() { "" } else { " " };
    let _ = writeln!(std::io::stderr(), "FLEETD_BENCH stage={name} t_ms={t_ms:.1}{sep}{detail}");
}

fn presented() -> bool {
    PROGRESS.lock().unwrap_or_else(|e| e.into_inner()).1
}

/// `FLEETD_BENCH_TIMEOUT_MS`: how long a run may go without presenting a frame. 0 turns the watchdog off.
pub fn timeout_from(value: Option<&str>) -> Option<Duration> {
    match value.map(str::trim).filter(|v| !v.is_empty()).map(str::parse::<u64>) {
        Some(Ok(0)) => None,
        Some(Ok(ms)) => Some(Duration::from_millis(ms)),
        _ => Some(DEFAULT_TIMEOUT),
    }
}

/// A plain thread, so it fires even when the main thread is stuck inside AppKit or never reaches our code.
pub fn start_watchdog() {
    let Some(timeout) = timeout_from(std::env::var("FLEETD_BENCH_TIMEOUT_MS").ok().as_deref()) else { return };
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        let (last, presented) = *PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        if !presented {
            let t_ms = START.get().map_or(0., |s| s.elapsed().as_secs_f64() * 1000.);
            let _ = writeln!(std::io::stderr(), "FLEETD_BENCH stage=timeout t_ms={t_ms:.1} last={last} timeout_ms={}", timeout.as_millis());
            std::process::exit(3);
        }
    });
}

/// Logs the window's state now and as it changes, and its first drawn and first presented frames (from a
/// journal cursor of its own, so the shell's measurements are untouched). Call while building the root view,
/// before the window's first frame.
pub fn watch_window<T: 'static>(window: &mut Window, cx: &mut Context<T>) {
    stage("window_created", &window_state(window));
    window
        .observe_window_visibility(|visibility, window, _| {
            stage("visibility", &window_state(window));
            // gpui's profiler drops the present of a frame drawn before the window became visible. macOS
            // draws the first frame while the window is still occluded (Metal presents it to the layer all
            // the same), and an idle window with nothing streaming never draws again, so the run would
            // never see a present. A product window doesn't need this: what it drew is on the layer.
            if visibility.is_visible() && !presented() {
                window.refresh();
            }
        })
        .detach();
    cx.observe_window_activation(window, |_, window, _| stage("activation", &window_state(window))).detach();
    gpui::set_trace_enabled(true);
    let mut frames = FrameTimingCollector::new();
    cx.spawn_in(window, async move |_, cx| {
        let mut drawn = false;
        loop {
            for event in frames.collect_unseen() {
                match event {
                    FrameEvent::Draw(_) if !drawn => {
                        drawn = true;
                        stage("first_draw", "");
                    }
                    FrameEvent::Present(_) => {
                        let state = cx.update(|window, _| window_state(window)).unwrap_or_default();
                        return stage("first_present", &state);
                    }
                    FrameEvent::Draw(_) => {}
                }
            }
            cx.background_executor().timer(Duration::from_millis(5)).await;
        }
    })
    .detach();
}

fn window_state(window: &Window) -> String {
    format!("active={} visible={} bounds={} scale={}", window.is_window_active(), window.is_visible(), rect(window.bounds()), window.scale_factor())
}

/// The displays gpui sees and the bounds the window asks for: a window placed off every display never presents.
pub fn displays_and(bounds: Bounds<Pixels>, cx: &App) -> String {
    let displays: Vec<String> = cx.displays().iter().map(|d| rect(d.bounds())).collect();
    format!("displays={} bounds={}", displays.join(";"), rect(bounds))
}

fn rect(b: Bounds<Pixels>) -> String {
    format!("{}x{}@{},{}", f32::from(b.size.width), f32::from(b.size.height), f32::from(b.origin.x), f32::from(b.origin.y))
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
    /// Time inside `Window::draw` (layout, prepaint and paint) of each frame drawn.
    pub draw_times: Vec<Duration>,
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
            draw_times: Vec::new(),
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
                FrameEvent::Draw(t) => {
                    self.draw_times.push(t.draw_duration());
                    Frame::Draw { start: t.draw_start }
                }
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

    /// Ignores write errors: `println!` would panic once a reader closes the pipe (`| head`), aborting the app.
    pub fn emit(&self, fields: &str) {
        let _ = writeln!(std::io::stdout(), "FLEETD_BENCH {fields}");
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

/// Frames inside animations: for each start (an event that starts an animation of length `dur`), the presents from
/// the first one after it until `dur` (plus one 60 Hz frame) later. Returns the median of their presented frame
/// rates and the longest gap between two presents inside any of them, or `None` with no such window.
pub fn anim_stats(presents: &[Instant], starts: &[Instant], dur: Duration) -> Option<(f64, Duration)> {
    let mut rates = Vec::new();
    let mut worst = Duration::ZERO;
    for &s in starts {
        let Some(&first) = presents.iter().find(|&&p| p >= s) else { continue };
        let end = first + dur + Duration::from_micros(16_700);
        let inside: Vec<Instant> = presents.iter().copied().filter(|&p| p >= first && p <= end).collect();
        if inside.len() < 2 {
            continue;
        }
        for w in inside.windows(2) {
            worst = worst.max(w[1].duration_since(w[0]));
        }
        rates.push((inside.len() - 1) as f64 / inside[inside.len() - 1].duration_since(first).as_secs_f64());
    }
    rates.sort_by(f64::total_cmp);
    (!rates.is_empty()).then(|| (rates[rates.len() / 2], worst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_defaults_to_15_s_and_0_turns_it_off() {
        assert_eq!(timeout_from(None), Some(Duration::from_secs(15)));
        assert_eq!(timeout_from(Some("2500")), Some(Duration::from_millis(2500)));
        assert_eq!(timeout_from(Some("0")), None);
        assert_eq!(timeout_from(Some("soon")), Some(Duration::from_secs(15)));
    }

    #[test]
    fn bench_mode_names() {
        assert_eq!(Mode::parse("keys-internal"), Ok(Mode::KeysInternal));
        // What the first Mac run used: an error to print, not a panic.
        assert!(Mode::parse("1").unwrap_err().contains("cold, idle"));
    }

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
    fn animation_windows_start_at_the_first_frame_after_the_event() {
        let t = Instant::now();
        // An event at 100 ms; frames every 10 ms from 110 to 300, with one 30 ms gap; another before it.
        let mut presents = vec![ms(t, 50)];
        presents.extend((110..=200).step_by(10).map(|n| ms(t, n)));
        presents.extend((230..=300).step_by(10).map(|n| ms(t, n)));
        let (fps, worst) = anim_stats(&presents, &[ms(t, 100)], Duration::from_millis(180)).unwrap();
        assert_eq!(worst, Duration::from_millis(30));
        assert!((fps - 90.0).abs() < 1.0, "{fps}");
        assert!(anim_stats(&presents, &[ms(t, 400)], Duration::from_millis(180)).is_none());
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
