//! One live desktop session: the display it was lent, the node's X connection to it, the screen it reads ten times
//! a second while anything changes (the video, and the frames a person watches), and the action log, a line per
//! `desktop` action and session tool call as a browser session keeps it (node/browser/record.rs).
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use fleetd_contracts::browser::{
    BrowserAction, BrowserControl, BrowserFrame, BrowserInput, BrowserSessionId, DesktopAction,
    DesktopCall, DesktopDone, KeyAction, MouseAction, MouseButton, RecordingFile, ScrollDirection,
    SessionKind,
};
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::prim::{Int, NonEmpty};
use serde_json::{Value, json};

use super::display::Display;
use super::x11::{self, X};
use crate::node::browser::FrameSlot;
use crate::node::browser::record::{self, Meta, Scrub, VideoSink};
use crate::node::mask::Secrets;
use crate::node::util::AbortOnDrop;
use crate::node::wire::to_json;

/// The start of a result's text the action log keeps.
const RESULT_CHARS: usize = 500;

/// How often the node looks at the screen.
const FRAME_EVERY: Duration = Duration::from_millis(100);

/// Without DAMAGE telling it, the node reads the whole screen at least this often.
const FULL_EVERY: Duration = Duration::from_secs(2);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The live view's side of a session.
#[derive(Default)]
struct Live {
    watcher: Option<Arc<FrameSlot>>,
    seq: u64,
    last: Option<BrowserFrame>,
}

pub struct Session {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub started_at: Timestamp,
    pub start: Instant,
    pub dir: PathBuf,
    pub backend: fleetd_contracts::browser::DesktopBackend,
    display: Mutex<Option<Display>>,
    x: Arc<X>,
    ffmpeg: Option<PathBuf>,
    video: Mutex<Option<VideoSink>>,
    /// Set by [`Session::close`] under the video's lock: a frame that comes late starts nothing.
    closed: AtomicBool,
    live: Mutex<Live>,
    /// A person's input, in order.
    inputs: tokio::sync::mpsc::UnboundedSender<BrowserInput>,
    note: Mutex<Option<String>>,
    seq: AtomicU64,
    control: Mutex<BrowserControl>,
    scrub: Scrub,
    last_active: Mutex<Instant>,
    tasks: Mutex<Vec<AbortOnDrop>>,
}

pub struct Opened {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub dir: PathBuf,
    pub ffmpeg: Option<PathBuf>,
    /// The agent session's secrets (its project's, its order's, its MCP servers'), scrubbed from the action log.
    pub secrets: Secrets,
}

impl Session {
    /// Takes a lent display and the node's connection to it, and starts reading its screen. The recording's folder
    /// is made already: nothing here fails, so no display is ever thrown away on the async threads.
    pub fn open(display: Display, x: X, opened: Opened) -> Arc<Self> {
        let x = Arc::new(x);
        let (inputs, mut queued) = tokio::sync::mpsc::unbounded_channel::<BrowserInput>();
        let session = Arc::new(Self {
            id: opened.id,
            thread: opened.thread,
            cwd: opened.cwd,
            purpose: opened.purpose,
            started_at: Timestamp(crate::node::util::now_iso()),
            start: Instant::now(),
            dir: opened.dir,
            backend: display.backend,
            display: Mutex::new(Some(display)),
            x,
            ffmpeg: opened.ffmpeg,
            video: Mutex::default(),
            closed: AtomicBool::new(false),
            live: Mutex::default(),
            inputs,
            note: Mutex::default(),
            seq: AtomicU64::new(0),
            control: Mutex::default(),
            scrub: Scrub::new(&opened.secrets.0),
            last_active: Mutex::new(Instant::now()),
            tasks: Mutex::default(),
        });
        session.write_meta(None);
        let capture = AbortOnDrop(tokio::spawn(capture(Arc::downgrade(&session))));
        let weak = Arc::downgrade(&session);
        let input = AbortOnDrop(tokio::spawn(async move {
            while let Some(input) = queued.recv().await {
                let Some(session) = weak.upgrade() else {
                    return;
                };
                let x = session.x.clone();
                drop(session);
                let done = tokio::task::spawn_blocking(move || person_input(&x, input)).await;
                if let Ok(Err(e)) = done {
                    tracing::debug!(error = %e, "a person's desktop input did not go");
                }
            }
        }));
        lock(&session.tasks).extend([capture, input]);
        session
    }

    pub fn offset_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    pub fn touch(&self) {
        *lock(&self.last_active) = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        lock(&self.last_active).elapsed()
    }

    pub fn note(&self) -> Option<String> {
        lock(&self.note).clone()
    }

    fn set_note(&self, note: String) {
        let mut held = lock(&self.note);
        *held = Some(match held.take() {
            Some(before) => format!("{before}; {note}"),
            None => note,
        });
    }

    pub fn meta(&self, ended_at: Option<String>) -> Meta {
        Meta {
            session_id: self.id.to_string(),
            kind: SessionKind::LinuxDesktop,
            thread_id: self.thread.clone(),
            cwd: self.cwd.clone(),
            purpose: self.purpose.clone(),
            started_at: self.started_at.to_string(),
            ended_at,
            credentials_filled: 0,
            note: self.note(),
        }
    }

    pub fn write_meta(&self, ended_at: Option<String>) {
        if let Err(e) = record::write_meta(&self.dir, &self.meta(ended_at)) {
            tracing::warn!(session = %self.id, error = %e, "desktop session file not written");
        }
    }

    pub fn control(&self) -> BrowserControl {
        *lock(&self.control)
    }

    /// Who drives the desktop: a person takes it (`Human`: the agent's actions are refused until they hand it back),
    /// or hands it back (`HandingBack`, until the agent's next action, then `Agent`). Logged as a step.
    pub fn set_control(&self, control: BrowserControl, by: &str) {
        let before = std::mem::replace(&mut *lock(&self.control), control);
        if before == control {
            return;
        }
        match control {
            BrowserControl::Human => {
                self.step("takeover", json!({ "by": by }), true, None, 0);
            }
            BrowserControl::HandingBack | BrowserControl::Agent => {
                if before == BrowserControl::Human {
                    self.step("handback", json!({ "by": by }), true, None, 0);
                }
            }
        }
        // The watcher's next frame says who drives now.
        let mut live = lock(&self.live);
        if let Some(last) = &mut live.last {
            last.control = control;
        }
        if let (Some(watcher), Some(last)) = (&live.watcher, &live.last) {
            watcher.replace(
                self.id.as_str(),
                to_json(&NodeToHub::BrowserFrame(last.clone())),
            );
        }
    }

    /// Sends this session's frames to the hub from now on (`Some`), the newest at once, or no more.
    pub fn set_watcher(&self, watcher: Option<Arc<FrameSlot>>) {
        let mut live = lock(&self.live);
        live.watcher = watcher;
        if live.watcher.is_some() {
            tracing::debug!(target: "fleetd::stages", screen = %self.id, ms = self.offset_ms(), frame = live.last.is_some(), "desktop watched");
        }
        if let (Some(watcher), Some(last)) = (&live.watcher, &live.last) {
            let mut last = last.clone();
            last.control = self.control();
            watcher.replace(self.id.as_str(), to_json(&NodeToHub::BrowserFrame(last)));
        }
    }

    /// Queues a person's input behind what came before it, if they have control as it comes; once queued it goes,
    /// even when they hand back before it is done.
    pub fn queue_input(&self, input: BrowserInput) {
        if self.control() == BrowserControl::Human {
            let _ = self.inputs.send(input);
        }
    }

    /// A new screen: into the video, and to the hub while it watches.
    fn frame(&self, jpeg: Vec<u8>, (width, height): (u32, u32), at: Duration) {
        {
            let mut video = lock(&self.video);
            if self.closed.load(Ordering::Relaxed) {
                return;
            }
            if video.is_none() && lock(&self.note).is_none() {
                match VideoSink::start(
                    self.ffmpeg.as_deref(),
                    self.dir.join(RecordingFile::Video.file_name()),
                    (width, height),
                ) {
                    Ok(sink) => *video = Some(sink),
                    Err(why) => self.set_note(why),
                }
            }
            if let Some(sink) = video.as_ref() {
                sink.frame(jpeg.clone(), at);
            }
        }
        let mut live = lock(&self.live);
        live.seq += 1;
        if live.seq == 1 {
            tracing::debug!(target: "fleetd::stages", screen = %self.id, ms = self.offset_ms(), watched = live.watcher.is_some(), "desktop's first frame");
        }
        let frame = BrowserFrame {
            session_id: self.id.clone(),
            seq: live.seq,
            jpeg_b64: NonEmpty::unchecked(base64::engine::general_purpose::STANDARD.encode(&jpeg)),
            width: Int::unchecked(i64::from(width)),
            height: Int::unchecked(i64::from(height)),
            url: None,
            control: self.control(),
        };
        // Only this session still holds the slot: its link went, and the hub watches again on the next one.
        if live
            .watcher
            .as_ref()
            .is_some_and(|w| Arc::strong_count(w) == 1)
        {
            live.watcher = None;
        }
        if let Some(watcher) = &live.watcher {
            watcher.replace(
                self.id.as_str(),
                to_json(&NodeToHub::BrowserFrame(frame.clone())),
            );
        }
        live.last = Some(frame);
    }

    /// Time passes on a still screen: its frame keeps showing in the video.
    fn tick(&self, at: Duration) {
        if let Some(sink) = lock(&self.video).as_ref() {
            sink.tick(at);
        }
    }

    /// Logs one step: an action of the agent's, or fleetd's own, and returns its number.
    pub fn step(
        &self,
        tool: &str,
        mut args: Value,
        ok: bool,
        result: Option<&str>,
        duration_ms: u64,
    ) -> u64 {
        self.touch();
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.scrub.value(&mut args);
        let action = BrowserAction {
            seq,
            at: Timestamp(crate::node::util::now_iso()),
            offset_ms: self.offset_ms().saturating_sub(duration_ms),
            tool: tool.to_owned(),
            args,
            ok,
            result: result.map(|r| {
                self.scrub
                    .text(&r.chars().take(RESULT_CHARS).collect::<String>())
            }),
            duration_ms,
            url: None,
            target: None,
        };
        if let Err(e) = record::append_action(&self.dir, &action, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "desktop action not logged");
        }
        seq
    }

    /// Does one `desktop` action of the agent's, and logs it.
    pub async fn act(self: &Arc<Self>, call: DesktopCall) -> Result<DesktopDone, String> {
        let started = Instant::now();
        let args = serde_json::to_value(&call).unwrap_or_default();
        let session = self.clone();
        let outcome = tokio::task::spawn_blocking(move || match call.action {
            DesktopAction::Launch => session.launch_app(&call),
            _ => act(&session.x, &call),
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
        let ms = started.elapsed().as_millis() as u64;
        match &outcome {
            Ok(done) => self.step("desktop", args, true, Some(&done.message), ms),
            Err(why) => self.step("desktop", args, false, Some(why), ms),
        };
        outcome.map(|mut done| {
            done.message = self.scrub.text(&done.message);
            done
        })
    }

    /// `launch`: starts an app on the display and says how it looks a moment later (blocking).
    fn launch_app(&self, call: &DesktopCall) -> Result<DesktopDone, String> {
        let command = call.text.as_ref().ok_or("launch needs text: the command")?;
        let launched = self.launch(command.as_str())?;
        let message = match launched.exited {
            None => format!(
                "Started `{}` (pid {}). Take a screenshot to see its window.",
                command.as_str(),
                launched.pid
            ),
            Some((code, output)) => format!(
                "`{}` exited at once{}: {}",
                command.as_str(),
                code.map(|c| format!(" with code {c}")).unwrap_or_default(),
                if output.is_empty() {
                    "it printed nothing"
                } else {
                    &output
                }
            ),
        };
        Ok(DesktopDone {
            message,
            jpeg_b64: None,
            width: None,
            height: None,
        })
    }

    /// Starts an app on the display (blocking).
    pub fn launch(&self, command: &str) -> Result<super::display::Launched, String> {
        let display = lock(&self.display);
        let display = display.as_ref().ok_or("the session has ended")?;
        display.launch(command, Path::new(&self.cwd))
    }

    /// Stops reading the screen, finishes the video and throws the display away with everything on it. Returns the
    /// files there are.
    pub async fn close(&self) -> Vec<(RecordingFile, u64)> {
        let sink = {
            let mut video = lock(&self.video);
            self.closed.store(true, Ordering::Relaxed);
            video.take()
        };
        lock(&self.tasks).clear();
        if let Some(sink) = sink
            && let Err(why) = sink.finish(self.start.elapsed()).await
        {
            let _ = std::fs::remove_file(self.dir.join(RecordingFile::Video.file_name()));
            self.set_note(format!("no video: {why}"));
        }
        let display = lock(&self.display).take();
        let _ = tokio::task::spawn_blocking(move || drop(display)).await;
        let actions = self.dir.join(RecordingFile::Actions.file_name());
        if let Err(e) = record::scrub_file(&actions, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "recording not scrubbed");
            let _ = std::fs::remove_file(&actions);
        }
        self.write_meta(Some(crate::node::util::now_iso()));
        crate::node::browser::session::files(&self.dir)
    }
}

/// Reads the screen while the session lives: a new frame whenever it changed, and the video kept going between.
async fn capture(session: std::sync::Weak<Session>) {
    let mut last_hash = None::<u64>;
    let mut last_full = Instant::now() - FULL_EVERY;
    let mut last_tick = Instant::now();
    loop {
        let Some(this) = session.upgrade() else {
            return;
        };
        let x = this.x.clone();
        let full = last_full.elapsed() >= FULL_EVERY;
        let grabbed =
            tokio::task::spawn_blocking(move || -> Result<Option<(u64, Vec<u8>)>, String> {
                if !x.changed() && !full {
                    return Ok(None);
                }
                let raw = x.grab_raw()?;
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                raw.hash(&mut hasher);
                let hash = hasher.finish();
                if Some(hash) == last_hash {
                    return Ok(Some((hash, Vec::new())));
                }
                Ok(Some((hash, x.encode(&raw)?)))
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        let at = this.start.elapsed();
        match grabbed {
            Ok(Some((hash, jpeg))) => {
                if full {
                    last_full = Instant::now();
                }
                if !jpeg.is_empty() {
                    last_hash = Some(hash);
                    this.frame(jpeg, this.x.size(), at);
                    last_tick = Instant::now();
                }
            }
            Ok(None) => {}
            Err(why) => {
                tracing::warn!(session = %this.id, error = %why, "desktop screen not read");
                this.set_note(format!("the screen stopped being read: {why}"));
                return;
            }
        }
        if last_tick.elapsed() >= Duration::from_secs(1) {
            this.tick(at);
            last_tick = Instant::now();
        }
        drop(this);
        tokio::time::sleep(FRAME_EVERY).await;
    }
}

fn point(c: Option<[Int<0, 8192>; 2]>) -> Option<(i64, i64)> {
    c.map(|[x, y]| (x.get(), y.get()))
}

/// One `desktop` action on the display (blocking).
fn act(x: &X, call: &DesktopCall) -> Result<DesktopDone, String> {
    let said = |message: String| DesktopDone {
        message,
        jpeg_b64: None,
        width: None,
        height: None,
    };
    let need_text = || {
        call.text
            .as_ref()
            .map(|t| t.as_str())
            .ok_or_else(|| format!("{} needs text", call.action.as_str()))
    };
    let at = |what: &str| -> Result<(i64, i64), String> {
        match point(call.coordinate) {
            Some(p) => Ok(p),
            None => x.pointer().map_err(|e| format!("{what}: {e}")),
        }
    };
    match call.action {
        DesktopAction::Screenshot => {
            x.sync()?;
            let shot = x.grab()?;
            Ok(DesktopDone {
                message: format!("The screen, {}x{}.", shot.width, shot.height),
                jpeg_b64: Some(base64::engine::general_purpose::STANDARD.encode(&shot.jpeg)),
                width: Some(shot.width),
                height: Some(shot.height),
            })
        }
        DesktopAction::LeftClick
        | DesktopAction::RightClick
        | DesktopAction::MiddleClick
        | DesktopAction::DoubleClick
        | DesktopAction::TripleClick => {
            let (button, count) = match call.action {
                DesktopAction::RightClick => (3, 1),
                DesktopAction::MiddleClick => (2, 1),
                DesktopAction::DoubleClick => (1, 2),
                DesktopAction::TripleClick => (1, 3),
                _ => (1, 1),
            };
            let (px, py) = at("click")?;
            x.click(px, py, button, count)?;
            Ok(said(format!("{} at ({px}, {py}).", call.action.as_str())))
        }
        DesktopAction::MouseMove => {
            let (px, py) = point(call.coordinate).ok_or("mouse_move needs coordinate")?;
            x.move_to(px, py)?;
            x.sync()?;
            Ok(said(format!("Moved the mouse to ({px}, {py}).")))
        }
        DesktopAction::LeftClickDrag => {
            let from =
                point(call.start_coordinate).ok_or("left_click_drag needs start_coordinate")?;
            let to = point(call.coordinate).ok_or("left_click_drag needs coordinate")?;
            x.drag(from, to)?;
            Ok(said(format!(
                "Dragged from ({}, {}) to ({}, {}).",
                from.0, from.1, to.0, to.1
            )))
        }
        DesktopAction::Type => {
            let text = need_text()?;
            x.type_text(text)?;
            Ok(said(format!("Typed {} characters.", text.chars().count())))
        }
        DesktopAction::Key => {
            let keys = need_text()?;
            x.chord(keys)?;
            Ok(said(format!("Pressed {keys}.")))
        }
        DesktopAction::Scroll => {
            let (px, py) = at("scroll")?;
            let n = call.scroll_amount.map_or(3, |n| n.get());
            let (dx, dy) = match call.scroll_direction.unwrap_or(ScrollDirection::Down) {
                ScrollDirection::Up => (0, -n),
                ScrollDirection::Down => (0, n),
                ScrollDirection::Left => (-n, 0),
                ScrollDirection::Right => (n, 0),
            };
            x.scroll(px, py, dx, dy)?;
            Ok(said(format!("Scrolled {n} at ({px}, {py}).")))
        }
        DesktopAction::Wait => {
            let secs = call.duration.map_or(1, |d| d.get());
            std::thread::sleep(Duration::from_secs(secs as u64));
            Ok(said(format!("Waited {secs} s.")))
        }
        DesktopAction::CursorPosition => {
            let (px, py) = x.pointer()?;
            Ok(said(format!("The mouse is at ({px}, {py}).")))
        }
        DesktopAction::Launch => Err("launch goes through the session".into()),
    }
}

/// A person's input from the live view, in the frame's pixels, which are the screen's.
fn person_input(x: &X, input: BrowserInput) -> Result<(), String> {
    match input {
        BrowserInput::Mouse {
            action,
            x: px,
            y: py,
            button,
            delta_x,
            delta_y,
            ..
        } => {
            let (px, py) = (px.round() as i64, py.round() as i64);
            let button = match button {
                MouseButton::Left => 1,
                MouseButton::Middle => 2,
                MouseButton::Right => 3,
                MouseButton::None => 0,
            };
            match action {
                MouseAction::Moved => x.move_to(px, py)?,
                MouseAction::Pressed | MouseAction::Released if button > 0 => {
                    x.move_to(px, py)?;
                    x.button(button, action == MouseAction::Pressed)?;
                }
                MouseAction::Pressed | MouseAction::Released => {}
                MouseAction::Wheel => {
                    // A wheel notch is about 100 pixels in a browser's deltas.
                    let notches = |d: f64| match d {
                        0.0 => 0,
                        d => (d / 100.0).round().abs().max(1.0).copysign(d) as i64,
                    };
                    x.scroll(px, py, notches(delta_x), notches(delta_y))?;
                }
            }
            x.sync()
        }
        BrowserInput::Key {
            action, key, text, ..
        } => {
            // A key that types goes by its character; the rest by name. Modifiers come as keys of their own.
            let sym = text
                .as_ref()
                .and_then(|t| {
                    let mut chars = t.as_str().chars();
                    match (chars.next(), chars.next()) {
                        (Some(c), None) if !c.is_control() => Some(x11::char_keysym(c)),
                        _ => None,
                    }
                })
                .or_else(|| x11::keysym(key.as_str()))
                .ok_or_else(|| format!("no key {}", key.as_str()))?;
            x.key_sym(sym, action == KeyAction::Down, false)?;
            x.sync()
        }
        BrowserInput::Text { text } => x.type_text(text.as_str()),
    }
}
