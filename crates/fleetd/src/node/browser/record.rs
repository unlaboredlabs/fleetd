//! A session's recording, in `<node home>/browser/recordings/<sessionId>/` until the hub has it: the video, encoded by
//! ffmpeg from the screencast frames as they come (each frame held until the next, at a steady rate, as Playwright's
//! own recorder does); `actions.jsonl`, a line per tool call; and `dom.jsonl`, the page after each call that changed
//! it. Lines are scrubbed before they are written, and the files once more when the session ends.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fleetd_contracts::browser::{BrowserAction, DomSnapshot, RecordingFile, SessionKind};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::node::mask::Masker;

/// Frames a second in the video.
pub const FPS: u64 = 25;

/// The frames due by `at` from the session's start.
fn frames_at(at: Duration) -> u64 {
    at.as_millis() as u64 * FPS / 1000
}

/// What the node keeps beside a recording so a restart can still upload it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub session_id: String,
    /// What the session drove; absent from a recording made before android sessions: a browser.
    #[serde(default)]
    pub kind: SessionKind,
    pub thread_id: String,
    pub cwd: String,
    pub purpose: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub credentials_filled: u64,
    pub note: Option<String>,
}

pub const META: &str = "session.json";

/// Writes the session file, making its folder again if it went: without the file, the upload that reports the
/// session's end and sends its recording has nothing to go on.
pub fn write_meta(dir: &Path, meta: &Meta) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(meta).map_err(std::io::Error::other)?;
    crate::node::secrets::write_atomic(&dir.join(META), &bytes)
}

pub fn read_meta(dir: &Path) -> Option<Meta> {
    serde_json::from_slice(&std::fs::read(dir.join(META)).ok()?).ok()
}

/// The video encoder, fed frames by [`VideoSink`]. None without an ffmpeg.
struct Encoder {
    child: Child,
    stdin: ChildStdin,
    /// ffmpeg's own words, beside the video; never uploaded.
    log: PathBuf,
    /// Frames written so far.
    written: u64,
    last: Option<Vec<u8>>,
}

impl Encoder {
    fn start(ffmpeg: &Path, out: &Path, (width, height): (u32, u32)) -> Result<Self, String> {
        let size = format!("{width}:{height}");
        let log = out.with_extension("log");
        let stderr = std::fs::File::create(&log)
            .map_err(|e| format!("cannot write {}: {e}", log.display()))?;
        let mut child = Command::new(ffmpeg)
            .args([
                "-loglevel",
                "error",
                "-f",
                "image2pipe",
                "-avioflags",
                "direct",
            ])
            .args([
                "-fpsprobesize",
                "0",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
            ])
            .args([
                "-framerate",
                &FPS.to_string(),
                "-c:v",
                "mjpeg",
                "-i",
                "pipe:0",
            ])
            .args(["-y", "-an", "-r", &FPS.to_string(), "-c:v", "libvpx-vp9"])
            .args([
                "-qmin",
                "0",
                "-qmax",
                "50",
                "-crf",
                "8",
                "-deadline",
                "realtime",
            ])
            .args(["-speed", "8", "-b:v", "1M", "-threads", "1"])
            .args(["-vf", &format!("pad={size}:0:0:gray,crop={size}:0:0")])
            .arg(out)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(stderr)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", ffmpeg.display()))?;
        let stdin = child.stdin.take().expect("piped stdin");
        Ok(Self {
            child,
            stdin,
            log,
            written: 0,
            last: None,
        })
    }

    /// Holds the last frame up to `at`.
    async fn fill_to(&mut self, at: Duration) -> std::io::Result<()> {
        let due = frames_at(at);
        let Some(last) = &self.last else {
            return Ok(());
        };
        while self.written < due {
            self.stdin.write_all(last).await?;
            self.written += 1;
        }
        Ok(())
    }

    /// The frame shown until now runs until this one's time; the first also covers the time before it.
    async fn frame(&mut self, jpeg: Vec<u8>, at: Duration) -> std::io::Result<()> {
        if self.last.is_none() {
            self.last = Some(jpeg.clone());
        }
        self.fill_to(at).await?;
        self.last = Some(jpeg);
        Ok(())
    }

    /// The end of what ffmpeg said, to say why it failed.
    fn said(&self) -> String {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        let last = text
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default();
        last.chars().take(200).collect()
    }

    async fn finish(mut self, at: Duration) -> Result<(), String> {
        if let Some(last) = self.last.clone() {
            let written = async {
                self.fill_to(at).await?;
                // The last frame shows for at least one tick.
                self.stdin.write_all(&last).await
            };
            written
                .await
                .map_err(|e| format!("ffmpeg stopped taking frames ({e}): {}", self.said()))?;
        }
        let Self {
            mut child, stdin, ..
        } = self;
        drop(stdin);
        let status = tokio::time::timeout(Duration::from_secs(60), child.wait())
            .await
            .map_err(|_| "ffmpeg did not finish the video in 60 s".to_owned())?
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("ffmpeg failed ({status})"))
        }
    }
}

enum Feed {
    Frame(Vec<u8>, Duration),
    Tick(Duration),
    Finish(Duration, tokio::sync::oneshot::Sender<Result<(), String>>),
}

/// Frames in, a video out, on a task of its own so a slow encoder never holds up the screencast.
#[derive(Clone)]
pub struct VideoSink {
    tx: mpsc::UnboundedSender<Feed>,
}

impl VideoSink {
    /// Starts encoding to `out`, `size` pixels (a frame of another size is padded or cut to it); `Err` says why there
    /// will be no video.
    pub fn start(ffmpeg: Option<&Path>, out: PathBuf, size: (u32, u32)) -> Result<Self, String> {
        let Some(ffmpeg) = ffmpeg else {
            return Err("no video: this machine has no ffmpeg for it".to_owned());
        };
        let mut encoder = Encoder::start(ffmpeg, &out, size)?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Feed>();
        tokio::spawn(async move {
            let mut broken = None;
            while let Some(feed) = rx.recv().await {
                let step = match feed {
                    Feed::Frame(jpeg, at) if broken.is_none() => encoder.frame(jpeg, at).await,
                    Feed::Tick(at) if broken.is_none() => encoder.fill_to(at).await,
                    Feed::Finish(at, done) => {
                        let result = match broken.take() {
                            Some(why) => Err(why),
                            None => encoder.finish(at).await,
                        };
                        let _ = done.send(result);
                        return;
                    }
                    _ => Ok(()),
                };
                if let Err(e) = step {
                    let said = encoder.said();
                    broken = Some(format!("ffmpeg stopped taking frames ({e}): {said}"));
                }
            }
        });
        Ok(Self { tx })
    }

    pub fn frame(&self, jpeg: Vec<u8>, at: Duration) {
        let _ = self.tx.send(Feed::Frame(jpeg, at));
    }

    /// Time passes on a still page: its frame keeps showing.
    pub fn tick(&self, at: Duration) {
        let _ = self.tx.send(Feed::Tick(at));
    }

    pub async fn finish(&self, at: Duration) -> Result<(), String> {
        let (done, wait) = tokio::sync::oneshot::channel();
        if self.tx.send(Feed::Finish(at, done)).is_err() {
            return Err("the video encoder stopped".to_owned());
        }
        wait.await
            .unwrap_or_else(|_| Err("the video encoder stopped".to_owned()))
    }
}

/// What a session scrubs: its project's and order's secrets as every session's reports are masked, and each value
/// filled into its browser in every form a page or a trace may show it.
///
/// A value too short to mask wherever it appears (a card's 3-digit code, under [`crate::node::mask::MIN_LEN`]) is
/// masked where it is a field's value: a whole JSON string, and an HTML `value` attribute.
pub struct Scrub(Masker, Vec<(String, String)>);

impl Scrub {
    /// Every form a page or a trace may show a value in ([`Masker::thorough`]), for both kinds.
    pub fn new(secrets: &[(String, String)]) -> Self {
        let short = secrets
            .iter()
            .filter(|(_, v)| !v.is_empty() && v.len() < crate::node::mask::MIN_LEN)
            .map(|(name, value)| (format!("***{name}***"), value.clone()))
            .collect();
        Self(Masker::thorough(secrets), short)
    }

    pub fn text(&self, text: &str) -> String {
        let mut out = self.0.text(text).into_owned();
        for (shown, value) in &self.1 {
            if out == *value {
                return shown.clone();
            }
            for (open, close) in [
                ("\"", "\""),
                ("'", "'"),
                ("&quot;", "&quot;"),
                ("\\\"", "\\\""),
            ] {
                out = out.replace(
                    &format!("value={open}{value}{close}"),
                    &format!("value={open}{shown}{close}"),
                );
            }
        }
        out
    }

    pub fn value(&self, value: &mut serde_json::Value) {
        self.0.value(value);
        if self.1.is_empty() {
            return;
        }
        match value {
            serde_json::Value::String(s) => {
                let scrubbed = self.text(s);
                if scrubbed != *s {
                    *s = scrubbed;
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|i| self.value(i)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|v| self.value(v)),
            _ => {}
        }
    }
}

/// Appends one scrubbed JSON line to a recording file.
pub fn append_line<T: Serialize>(path: &Path, item: &T, scrub: &Scrub) -> std::io::Result<()> {
    let mut value = serde_json::to_value(item).map_err(std::io::Error::other)?;
    scrub.value(&mut value);
    let mut line = serde_json::to_vec(&value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(&line)
}

pub fn append_action(dir: &Path, action: &BrowserAction, scrub: &Scrub) -> std::io::Result<()> {
    append_line(&dir.join(RecordingFile::Actions.file_name()), action, scrub)
}

pub fn append_dom(dir: &Path, snapshot: &DomSnapshot, scrub: &Scrub) -> std::io::Result<()> {
    append_line(&dir.join(RecordingFile::Dom.file_name()), snapshot, scrub)
}

/// Scrubs a text file of the recording in place with every value known by the end (one filled after a line was
/// written, too).
pub fn scrub_file(path: &Path, scrub: &Scrub) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let scrubbed = scrub.text(&text);
    if scrubbed != text {
        crate::node::secrets::write_atomic(path, scrubbed.as_bytes())?;
    }
    Ok(())
}
