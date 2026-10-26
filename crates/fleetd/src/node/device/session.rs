//! One live android session: the emulator copy it was lent, scrcpy's stream of its screen (the video, and the frames a
//! person watches), and the action log, a line per tool call of the agent's that drove the device (its `agent-device`
//! commands, fleetd's session tools) as a browser session keeps it (node/browser/record.rs).
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserAction, BrowserControl, BrowserSessionId, RecordingFile, SessionKind,
};
use fleetd_contracts::ids::Timestamp;
use serde_json::Value;
use tokio::sync::watch;

use super::emulator::Lent;
use super::scrcpy::{Frame, Input, Stream};
use super::sdk::Sdk;
use crate::node::browser::record::{self, Meta, Scrub, VideoSink};
use crate::node::mask::Masker;
use crate::node::util::AbortOnDrop;

/// The start of a result's text the action log keeps.
const RESULT_CHARS: usize = 500;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct Session {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub serial: String,
    pub started_at: Timestamp,
    pub start: Instant,
    pub dir: PathBuf,
    /// The node's home: the control file the agent's wrapper checks is there.
    home: PathBuf,
    lent: Mutex<Option<Lent>>,
    stream: Mutex<Option<Stream>>,
    video: Arc<Mutex<Option<VideoSink>>>,
    /// The newest frame, for whoever watches.
    frames: watch::Sender<Option<Frame>>,
    note: Arc<Mutex<Option<String>>>,
    seq: AtomicU64,
    control: Mutex<BrowserControl>,
    scrub: Arc<Scrub>,
    last_active: Mutex<Instant>,
    _ticker: Mutex<Option<AbortOnDrop>>,
}

pub struct Opened {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub dir: PathBuf,
    pub home: PathBuf,
    pub masker: Masker,
}

impl Session {
    /// Takes a lent emulator and starts recording it. The stream connects in the background (about a second): the
    /// agent's first command needn't wait for it, and the video starts with its first frame.
    pub fn open(lent: Lent, sdk: Sdk, opened: Opened) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&opened.dir)
            .map_err(|e| format!("cannot make {}: {e}", opened.dir.display()))?;
        let serial = lent.emulator.serial.clone();
        let session = Arc::new(Self {
            id: opened.id,
            thread: opened.thread,
            cwd: opened.cwd,
            purpose: opened.purpose,
            serial: serial.clone(),
            started_at: Timestamp(crate::node::util::now_iso()),
            start: Instant::now(),
            dir: opened.dir,
            home: opened.home,
            lent: Mutex::new(Some(lent)),
            stream: Mutex::default(),
            video: Arc::default(),
            frames: watch::channel(None).0,
            note: Arc::default(),
            seq: AtomicU64::new(0),
            control: Mutex::default(),
            scrub: Arc::new(Scrub::new(Arc::new(opened.masker), &[])),
            last_active: Mutex::new(Instant::now()),
            _ticker: Mutex::default(),
        });
        session.write_meta(None);
        let weak = Arc::downgrade(&session);
        tokio::spawn(async move {
            let Some(this) = weak.upgrade() else { return };
            let (start, video, note, frames, dir) = (
                this.start,
                this.video.clone(),
                this.note.clone(),
                this.frames.clone(),
                this.dir.clone(),
            );
            let ffmpeg = sdk.ffmpeg.clone();
            let encoder = sdk.ffmpeg.clone();
            let on_frame = move |frame: Frame| {
                let mut sink = lock(&video);
                if sink.is_none() && lock(&note).is_none() {
                    match VideoSink::start(
                        Some(&encoder),
                        dir.join(RecordingFile::Video.file_name()),
                        (frame.width, frame.height),
                    ) {
                        Ok(started) => *sink = Some(started),
                        Err(why) => *lock(&note) = Some(why),
                    }
                }
                if let Some(sink) = sink.as_ref() {
                    sink.frame(frame.jpeg.to_vec(), frame.at);
                }
                frames.send_replace(Some(frame));
            };
            drop(this);
            let stream = Stream::start(&sdk, &serial, &ffmpeg, start, on_frame).await;
            let Some(this) = weak.upgrade() else { return };
            match stream {
                Ok(stream) => {
                    *lock(&this.stream) = Some(stream);
                    let video = this.video.clone();
                    *lock(&this._ticker) = Some(AbortOnDrop(tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            if let Some(sink) = lock(&video).as_ref() {
                                sink.tick(start.elapsed());
                            }
                        }
                    })));
                }
                Err(why) => {
                    tracing::warn!(session = %this.id, error = %why, "device stream not started");
                    this.set_note(format!("no video or live view: {why}"));
                }
            }
        });
        Ok(session)
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
            kind: SessionKind::Android,
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
            tracing::warn!(session = %self.id, error = %e, "device session file not written");
        }
    }

    /// The newest frames of the screen, from the first on (None until the stream connects): live view. A watcher
    /// that falls behind skips to the newest.
    pub fn frames(&self) -> watch::Receiver<Option<Frame>> {
        self.frames.subscribe()
    }

    /// A person's input, while they have control. False when it can't go (they don't have control, or the stream
    /// isn't up yet).
    pub fn input(&self, input: &Input) -> bool {
        if self.control() != BrowserControl::Human {
            return false;
        }
        lock(&self.stream).as_ref().is_some_and(|s| s.send(input))
    }

    pub fn control(&self) -> BrowserControl {
        *lock(&self.control)
    }

    /// Who drives the device: a person takes it (`Human`: the agent's `agent-device` refuses until they hand it back),
    /// or hands it back (`HandingBack`, until the agent's next command, then `Agent`). Logged as a step.
    pub fn set_control(&self, control: BrowserControl, by: &str) {
        let before = std::mem::replace(&mut *lock(&self.control), control);
        if before == control {
            return;
        }
        let file = super::agent_device::control_path(&self.home, &self.thread);
        match control {
            BrowserControl::Human => {
                if let Some(dir) = file.parent() {
                    let _ = crate::node::config::mkdir_private(dir);
                }
                if let Err(e) = std::fs::write(&file, "human\n") {
                    tracing::warn!(session = %self.id, error = %e, "device control file not written");
                }
                self.step("takeover", serde_json::json!({ "by": by }), true, None, 0);
            }
            BrowserControl::HandingBack | BrowserControl::Agent => {
                let _ = std::fs::remove_file(&file);
                if before == BrowserControl::Human {
                    self.step("handback", serde_json::json!({ "by": by }), true, None, 0);
                }
            }
        }
    }

    /// Logs one step: a tool call of the agent's, or fleetd's own, and returns its number.
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
        };
        if let Err(e) = record::append_action(&self.dir, &action, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "device action not logged");
        }
        seq
    }

    /// Stops the stream, finishes the video and throws the emulator away with everything done in it. Returns the
    /// files there are.
    pub async fn close(&self) -> Vec<(RecordingFile, u64)> {
        lock(&self._ticker).take();
        lock(&self.stream).take();
        let sink = lock(&self.video).take();
        if let Some(sink) = sink
            && let Err(why) = sink.finish(self.start.elapsed()).await
        {
            let _ = std::fs::remove_file(self.dir.join(RecordingFile::Video.file_name()));
            self.set_note(format!("no video: {why}"));
        }
        lock(&self.lent).take();
        super::agent_device::release(&self.home, &self.thread);
        let actions = self.dir.join(RecordingFile::Actions.file_name());
        if let Err(e) = record::scrub_file(&actions, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "recording not scrubbed");
            let _ = std::fs::remove_file(&actions);
        }
        self.write_meta(Some(crate::node::util::now_iso()));
        crate::node::browser::session::files(&self.dir)
    }
}

/// Where the node keeps device recordings until the hub has them.
pub fn recordings_dir(home: &Path) -> PathBuf {
    super::sdk::device_dir(home).join("recordings")
}
