//! One live iOS session: the clone it was lent, `simctl io recordVideo` recording its screen into the session's
//! `video.mp4`, the screenshot loop a person watches and the queue their input goes through (screen.rs), and the
//! action log, a line per tool call of the agent's that drove the simulator, as an android session keeps it.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserAction, BrowserControl, BrowserSessionId, RecordingFile, SessionKind,
};
use fleetd_contracts::ids::Timestamp;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::watch;

use super::pool::{self, Lent};
use super::screen::{Hands, Runner, Screen};
use super::simctl::Simctl;
use crate::node::browser::record::{self, Meta, Scrub};
use crate::node::device::agent_device;
use crate::node::device::scrcpy::{Frame, Input};
use crate::node::mask::Secrets;

/// The start of a result's text the action log keeps.
const RESULT_CHARS: usize = 500;
/// recordVideo finishes its file within moments of SIGINT; this allows a loaded machine.
const FINISH_VIDEO: Duration = Duration::from_secs(20);
/// recordVideo says it started within a second or two; a session that ends sooner waits this long for it at most.
const START_VIDEO: Duration = Duration::from_secs(15);
/// How often the recording's file is looked at, to see it has started.
const FILE_POLL: Duration = Duration::from_millis(250);

/// Whether the recording's file, `before` and `now` (None while it isn't there), shows it recording: there, not
/// empty, and bigger than the last look.
pub fn file_growing(before: Option<u64>, now: Option<u64>) -> bool {
    matches!((before, now), (Some(before), Some(now)) if now > before && now > 0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `simctl io recordVideo`, in a process group of its own so SIGINT reaches simctl through xcrun. It is stopped only
/// once it has started: a SIGINT before then kills it with no file (seen on a loaded CI machine). Started is when it
/// says "Recording started", or else when its file is there and growing, so an Xcode that words it otherwise doesn't
/// hold every session's end for [`START_VIDEO`].
pub struct Recorder {
    child: tokio::process::Child,
    path: PathBuf,
    started: watch::Receiver<bool>,
}

impl Recorder {
    pub fn start(simctl: &Simctl, udid: &str, path: PathBuf) -> Result<Self, String> {
        let mut child = simctl
            .record(udid, &path)
            .process_group(0)
            .spawn()
            .map_err(|e| format!("cannot start simctl's recording: {e}"))?;
        let (tx, started) = watch::channel(false);
        let tx = Arc::new(tx);
        let stdout = child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn AsyncRead + Send + Unpin>);
        let stderr = child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn AsyncRead + Send + Unpin>);
        // The file, looked at every [`FILE_POLL`] until it has started (or nobody waits any more).
        {
            let (tx, path) = (tx.clone(), path.clone());
            tokio::spawn(async move {
                let mut before = None;
                while !*tx.borrow() && !tx.is_closed() {
                    tokio::time::sleep(FILE_POLL).await;
                    let now = std::fs::metadata(&path).ok().map(|m| m.len());
                    if file_growing(before, now) {
                        tx.send_replace(true);
                    }
                    before = now;
                }
            });
        }
        for out in [stdout, stderr].into_iter().flatten() {
            let tx = tx.clone();
            // Reads to the end, so the pipe never fills while it records.
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if super::simctl::recording_started(&line) {
                        tx.send_replace(true);
                    }
                }
            });
        }
        Ok(Self {
            child,
            path,
            started,
        })
    }

    /// Waits until it has started, at most `within`; true if it has.
    pub async fn started(&mut self, within: Duration) -> bool {
        tokio::time::timeout(within, self.started.wait_for(|s| *s))
            .await
            .is_ok_and(|r| r.is_ok())
    }

    /// Stops it, once it has started (or [`START_VIDEO`] passed), and waits for the file to be finished.
    pub async fn finish(mut self) -> Result<(), String> {
        let started = self.started(START_VIDEO).await;
        if let Some(pid) = self.child.id() {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGINT,
            );
        }
        let status = tokio::time::timeout(FINISH_VIDEO, self.child.wait()).await;
        match status {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("simctl's recording went: {e}")),
            Err(_) => {
                let _ = self.child.start_kill();
                return Err("simctl did not finish the video in 20 s".to_owned());
            }
        }
        match std::fs::metadata(&self.path) {
            Ok(m) if m.len() > 0 => Ok(()),
            _ if !started => Err("simctl's recording never started".to_owned()),
            _ => Err("simctl wrote no video".to_owned()),
        }
    }
}

pub struct Session {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub udid: String,
    pub started_at: Timestamp,
    pub start: Instant,
    pub dir: PathBuf,
    /// The node's home: the control file the agent's wrapper checks is there.
    home: PathBuf,
    lent: Mutex<Option<Lent>>,
    recorder: Mutex<Option<Recorder>>,
    screen: Arc<Screen>,
    hands: Hands,
    note: Mutex<Option<String>>,
    seq: AtomicU64,
    control: Mutex<BrowserControl>,
    scrub: Scrub,
    last_active: Mutex<Instant>,
}

pub struct Opened {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub dir: PathBuf,
    pub home: PathBuf,
    /// The golden's pixels per point, for a person's taps.
    pub scale: f64,
    /// The agent session's secrets, scrubbed from everything recorded.
    pub secrets: Secrets,
}

impl Session {
    /// Takes a lent clone and starts recording it.
    pub fn open(lent: Lent, simctl: Simctl, opened: Opened) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&opened.dir)
            .map_err(|e| format!("cannot make {}: {e}", opened.dir.display()))?;
        let udid = lent.udid.clone();
        let start = Instant::now();
        let mut note = None;
        let recorder = match Recorder::start(
            &simctl,
            &udid,
            opened.dir.join(RecordingFile::VideoMp4.file_name()),
        ) {
            Ok(recorder) => Some(recorder),
            Err(why) => {
                note = Some(format!("no video: {why}"));
                None
            }
        };
        let shot = super::ios_dir(&opened.home)
            .join("screens")
            .join(format!("{}.jpg", opened.id));
        if let Some(dir) = shot.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let path = std::env::var("PATH").ok();
        let hands = Hands::start(
            Runner {
                wrapper: super::wrapper::bin_dir(&opened.home).join("agent-device"),
                env: super::wrapper::env(&opened.home, &opened.thread, path.as_deref()),
                udid: udid.clone(),
            },
            opened.scale,
        );
        let session = Arc::new(Self {
            id: opened.id,
            thread: opened.thread,
            cwd: opened.cwd,
            purpose: opened.purpose,
            udid: udid.clone(),
            started_at: Timestamp(crate::node::util::now_iso()),
            start,
            dir: opened.dir,
            home: opened.home,
            lent: Mutex::new(Some(lent)),
            recorder: Mutex::new(recorder),
            screen: Screen::new(simctl, udid, shot, start),
            hands,
            note: Mutex::new(note),
            seq: AtomicU64::new(0),
            control: Mutex::default(),
            scrub: Scrub::new(&opened.secrets.0),
            last_active: Mutex::new(Instant::now()),
        });
        session.write_meta(None);
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
            kind: SessionKind::Ios,
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

    /// The newest frames of the screen (None until the first screenshot): live view. The screenshot loop runs while
    /// a watcher holds one; one that falls behind skips to the newest.
    pub fn frames(&self) -> watch::Receiver<Option<Frame>> {
        self.screen.frames()
    }

    /// A person's input, while they have control: queued for agent-device. False when it can't go.
    pub fn input(&self, input: &Input) -> bool {
        self.control() == BrowserControl::Human && self.hands.send(input)
    }

    pub fn control(&self) -> BrowserControl {
        *lock(&self.control)
    }

    /// Who drives the simulator: a person takes it (`Human`: the agent's `agent-device` refuses until they hand it
    /// back), or hands it back (`HandingBack`, until the agent's next command, then `Agent`). Logged as a step.
    pub fn set_control(&self, control: BrowserControl, by: &str) {
        let before = std::mem::replace(&mut *lock(&self.control), control);
        if before == control {
            return;
        }
        let file = agent_device::control_path(&self.home, &self.thread);
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
            target: None,
        };
        if let Err(e) = record::append_action(&self.dir, &action, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "device action not logged");
        }
        seq
    }

    /// Finishes the video, stops the live view and the session's agent-device daemon, and deletes the clone with
    /// everything done in it and its runner, which the daemon leaves leased (wrapper.rs). Returns the files there are.
    pub async fn close(&self) -> Vec<(RecordingFile, u64)> {
        self.screen.stop();
        let recorder = lock(&self.recorder).take();
        if let Some(recorder) = recorder
            && let Err(why) = recorder.finish().await
        {
            let _ = std::fs::remove_file(self.dir.join(RecordingFile::VideoMp4.file_name()));
            self.set_note(format!("no video: {why}"));
        }
        pool::stop_daemon(&agent_device::session_dir(&self.home, &self.thread).join("state")).await;
        agent_device::release(&self.home, &self.thread);
        lock(&self.lent).take();
        let actions = self.dir.join(RecordingFile::Actions.file_name());
        if let Err(e) = record::scrub_file(&actions, &self.scrub) {
            tracing::warn!(session = %self.id, error = %e, "recording not scrubbed");
            let _ = std::fs::remove_file(&actions);
        }
        self.write_meta(Some(crate::node::util::now_iso()));
        crate::node::browser::session::files(&self.dir)
    }
}

/// Where the node keeps iOS recordings until the hub has them.
pub fn recordings_dir(home: &Path) -> PathBuf {
    super::ios_dir(home).join("recordings")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_has_started_once_its_file_is_there_and_growing() {
        assert!(!file_growing(None, None), "not there yet");
        assert!(
            !file_growing(None, Some(4096)),
            "just appeared: one more look"
        );
        assert!(!file_growing(Some(4096), Some(4096)), "not growing");
        assert!(!file_growing(Some(0), Some(0)));
        assert!(file_growing(Some(0), Some(48)));
        assert!(file_growing(Some(4096), Some(9000)));
        assert!(!file_growing(Some(9000), None), "gone");
    }
}
