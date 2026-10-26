//! What a person watching an iOS session sees, and what they do to it. `simctl io` records video files but can't
//! stream, so the live view is a loop of `simctl io screenshot` JPEGs, run only while someone watches (the video is
//! `recordVideo`'s, session.rs). They are the same [`Frame`]s an android session gives, in the screen's pixels.
//!
//! A person's input goes through agent-device on the session's own home, so through the agent's daemon and the
//! XCTest runner it already started: a tap is `press`, a drag `swipe`, a held tap `longpress`, the wheel a `swipe`,
//! typing `type`, and Enter, Home and Back their own commands. Inputs queue and run one at a time; scrolls and typing
//! that pile up behind a slow command go as one.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};

use super::simctl::Simctl;
use crate::node::device::scrcpy::{Frame, Input, TouchAction, jpeg_size};
use crate::node::util::AbortOnDrop;

/// The live view's frames come no closer together than this.
const MIN_GAP: Duration = Duration::from_millis(100);
/// A touch held this long without moving is a long press.
const LONG_PRESS: Duration = Duration::from_millis(500);
/// A touch that moved less than this many points is a tap.
const TAP_SLOP: f64 = 8.0;
/// One input command may take this long (the runner may be starting).
const COMMAND: Duration = Duration::from_secs(30);

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The screenshot loop for one simulator.
pub struct Screen {
    simctl: Simctl,
    udid: String,
    /// Where each screenshot lands before it is read.
    shot: PathBuf,
    start: Instant,
    frames: watch::Sender<Option<Frame>>,
    seq: Arc<AtomicU64>,
    looping: std::sync::Mutex<Option<AbortOnDrop>>,
}

impl Screen {
    pub fn new(simctl: Simctl, udid: String, shot: PathBuf, start: Instant) -> Arc<Self> {
        Arc::new(Self {
            simctl,
            udid,
            shot,
            start,
            frames: watch::channel(None).0,
            seq: Arc::default(),
            looping: std::sync::Mutex::default(),
        })
    }

    /// The newest frames, from now on; the loop runs while anyone holds one of these.
    pub fn frames(&self) -> watch::Receiver<Option<Frame>> {
        let frames = self.frames.subscribe();
        let mut looping = lock(&self.looping);
        if looping.as_ref().is_none_or(|l| l.0.is_finished()) {
            *looping = Some(AbortOnDrop(tokio::spawn(shoot(
                self.simctl.clone(),
                self.udid.clone(),
                self.shot.clone(),
                self.start,
                self.frames.clone(),
                self.seq.clone(),
            ))));
        }
        frames
    }

    /// Stops the loop now.
    pub fn stop(&self) {
        lock(&self.looping).take();
        let _ = std::fs::remove_file(&self.shot);
    }
}

async fn shoot(
    simctl: Simctl,
    udid: String,
    shot: PathBuf,
    start: Instant,
    frames: watch::Sender<Option<Frame>>,
    seq: Arc<AtomicU64>,
) {
    let mut failing = false;
    while frames.receiver_count() > 0 {
        let began = Instant::now();
        let taken = match simctl.screenshot(&udid, &shot).await {
            Ok(()) => std::fs::read(&shot).map_err(|e| e.to_string()),
            Err(why) => Err(why),
        };
        match taken.and_then(|jpeg| {
            let (width, height) = jpeg_size(&jpeg).ok_or("the screenshot is not a JPEG")?;
            Ok((jpeg, width, height))
        }) {
            Ok((jpeg, width, height)) => {
                failing = false;
                frames.send_replace(Some(Frame {
                    seq: seq.fetch_add(1, Ordering::Relaxed) + 1,
                    jpeg: Arc::new(jpeg),
                    width,
                    height,
                    at: start.elapsed(),
                }));
            }
            Err(why) => {
                if !failing {
                    tracing::warn!(udid, error = %why, "iOS live view screenshot failed");
                }
                failing = true;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        tokio::time::sleep(MIN_GAP.saturating_sub(began.elapsed())).await;
    }
}

/// Turns a person's inputs, in the screen's pixels, into agent-device commands, in points.
#[derive(Debug)]
pub struct Gestures {
    /// Pixels per point.
    scale: f64,
    down: Option<(f64, f64, Instant)>,
    at: (f64, f64),
}

impl Gestures {
    pub fn new(scale: f64) -> Self {
        Self {
            scale: if scale >= 1.0 { scale } else { 1.0 },
            down: None,
            at: (0.0, 0.0),
        }
    }

    fn point(&self, x: f64, y: f64) -> (String, String) {
        let p = |v: f64| format!("{}", (v.max(0.0) / self.scale).round() as i64);
        (p(x), p(y))
    }

    /// The command for one input, if it ends a gesture.
    pub fn feed(&mut self, input: &Input, now: Instant) -> Option<Vec<String>> {
        let args = |list: &[&str]| Some(list.iter().map(|s| (*s).to_owned()).collect());
        match input {
            Input::Touch {
                action: TouchAction::Down,
                x,
                y,
            } => {
                self.down = Some((*x, *y, now));
                self.at = (*x, *y);
                None
            }
            Input::Touch {
                action: TouchAction::Move,
                x,
                y,
            } => {
                self.at = (*x, *y);
                None
            }
            Input::Touch {
                action: TouchAction::Up,
                x,
                y,
            } => {
                let (x0, y0, at) = self.down.take()?;
                let moved = ((x - x0).powi(2) + (y - y0).powi(2)).sqrt() / self.scale;
                let (px, py) = self.point(x0, y0);
                if moved < TAP_SLOP {
                    let verb = if now.duration_since(at) >= LONG_PRESS {
                        "longpress"
                    } else {
                        "press"
                    };
                    return args(&[verb, &px, &py]);
                }
                let (qx, qy) = self.point(*x, *y);
                args(&["swipe", &px, &py, &qx, &qy])
            }
            Input::Scroll { x, y, dx, dy } => {
                let (px, py) = self.point(*x, *y);
                let (qx, qy) = self.point(x - dx, y - dy);
                args(&["swipe", &px, &py, &qx, &qy])
            }
            Input::Key { down: false, .. } => None,
            Input::Key { key, .. } => match key.as_str() {
                "Enter" => args(&["keyboard", "return"]),
                "BrowserHome" => args(&["home"]),
                "BrowserBack" => args(&["back"]),
                _ => None,
            },
            Input::Text(text) => args(&["type", text]),
        }
    }
}

/// Folds inputs that piled up into fewer: scrolls one after another into one, text into one.
pub fn coalesce(inputs: Vec<Input>) -> Vec<Input> {
    let mut out: Vec<Input> = Vec::with_capacity(inputs.len());
    for input in inputs {
        match (out.last_mut(), input) {
            (
                Some(Input::Scroll { dx, dy, .. }),
                Input::Scroll {
                    dx: more_x,
                    dy: more_y,
                    ..
                },
            ) => {
                *dx += more_x;
                *dy += more_y;
            }
            (Some(Input::Text(text)), Input::Text(more)) => text.push_str(&more),
            (_, input) => out.push(input),
        }
    }
    out
}

/// A session's queue of a person's inputs, run in order through agent-device; stops when dropped.
pub struct Hands {
    tx: mpsc::UnboundedSender<Input>,
    _worker: AbortOnDrop,
}

/// How the worker runs agent-device: the wrapper, with the session's environment.
pub struct Runner {
    pub wrapper: PathBuf,
    pub env: Vec<(String, String)>,
    pub udid: String,
}

impl Hands {
    pub fn start(runner: Runner, scale: f64) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            tx,
            _worker: AbortOnDrop(tokio::spawn(work(runner, Gestures::new(scale), rx))),
        }
    }

    pub fn send(&self, input: &Input) -> bool {
        self.tx.send(input.clone()).is_ok()
    }
}

async fn work(runner: Runner, mut gestures: Gestures, mut rx: mpsc::UnboundedReceiver<Input>) {
    while let Some(first) = rx.recv().await {
        let mut inputs = vec![first];
        while let Ok(more) = rx.try_recv() {
            inputs.push(more);
        }
        for input in coalesce(inputs) {
            let Some(args) = gestures.feed(&input, Instant::now()) else {
                continue;
            };
            let run = tokio::process::Command::new(&runner.wrapper)
                .args(&args)
                .args(["--platform", "ios", "--udid", &runner.udid])
                .envs(runner.env.iter().map(|(k, v)| (k, v)))
                .env_remove("FLEETD_DEVICE_CONTROL")
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output();
            match tokio::time::timeout(COMMAND, run).await {
                Ok(Ok(out)) if out.status.success() => {}
                Ok(Ok(out)) => tracing::warn!(
                    command = %args.join(" "),
                    said = %String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>(),
                    "a person's input did not reach the iOS simulator"
                ),
                Ok(Err(e)) => tracing::warn!(error = %e, "cannot run agent-device"),
                Err(_) => tracing::warn!(command = %args.join(" "), "a person's input timed out"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(action: TouchAction, x: f64, y: f64) -> Input {
        Input::Touch { action, x, y }
    }

    #[test]
    fn a_tap_is_a_press_in_points_a_drag_a_swipe_and_a_hold_a_longpress() {
        let mut g = Gestures::new(3.0);
        let t0 = Instant::now();
        assert_eq!(g.feed(&touch(TouchAction::Down, 300.0, 600.0), t0), None);
        assert_eq!(
            g.feed(
                &touch(TouchAction::Up, 303.0, 600.0),
                t0 + Duration::from_millis(80)
            ),
            Some(vec!["press".into(), "100".into(), "200".into()])
        );
        g.feed(&touch(TouchAction::Down, 300.0, 1500.0), t0);
        assert_eq!(g.feed(&touch(TouchAction::Move, 300.0, 1000.0), t0), None);
        assert_eq!(
            g.feed(
                &touch(TouchAction::Up, 300.0, 600.0),
                t0 + Duration::from_millis(200)
            ),
            Some(vec![
                "swipe".into(),
                "100".into(),
                "500".into(),
                "100".into(),
                "200".into()
            ])
        );
        g.feed(&touch(TouchAction::Down, 30.0, 30.0), t0);
        assert_eq!(
            g.feed(
                &touch(TouchAction::Up, 30.0, 30.0),
                t0 + Duration::from_secs(1)
            ),
            Some(vec!["longpress".into(), "10".into(), "10".into()])
        );
        assert_eq!(
            g.feed(&touch(TouchAction::Up, 30.0, 30.0), t0),
            None,
            "an up with no down"
        );
    }

    #[test]
    fn the_wheel_swipes_against_it_and_keys_have_their_commands() {
        let mut g = Gestures::new(3.0);
        let now = Instant::now();
        let scroll = Input::Scroll {
            x: 600.0,
            y: 1500.0,
            dx: 0.0,
            dy: 300.0,
        };
        assert_eq!(
            g.feed(&scroll, now),
            Some(vec![
                "swipe".into(),
                "200".into(),
                "500".into(),
                "200".into(),
                "400".into()
            ]),
            "scrolling down drags the content up"
        );
        let key = |key: &str, down| Input::Key {
            down,
            key: key.into(),
            modifiers: 0,
        };
        assert_eq!(
            g.feed(&key("Enter", true), now),
            Some(vec!["keyboard".into(), "return".into()])
        );
        assert_eq!(g.feed(&key("Enter", false), now), None);
        assert_eq!(
            g.feed(&key("BrowserHome", true), now),
            Some(vec!["home".into()])
        );
        assert_eq!(g.feed(&key("F13", true), now), None);
        assert_eq!(
            g.feed(&Input::Text("héllo".into()), now),
            Some(vec!["type".into(), "héllo".into()])
        );
    }

    #[test]
    fn scrolls_and_typing_that_piled_up_go_as_one() {
        let scroll = |dy| Input::Scroll {
            x: 10.0,
            y: 20.0,
            dx: 0.0,
            dy,
        };
        let folded = coalesce(vec![
            scroll(100.0),
            scroll(50.0),
            Input::Text("ab".into()),
            Input::Text("c".into()),
            touch(TouchAction::Down, 1.0, 1.0),
            scroll(-10.0),
        ]);
        assert_eq!(
            folded,
            vec![
                scroll(150.0),
                Input::Text("abc".into()),
                touch(TouchAction::Down, 1.0, 1.0),
                scroll(-10.0)
            ]
        );
    }
}
