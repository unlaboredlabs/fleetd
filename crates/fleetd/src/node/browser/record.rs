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

/// Matroska as ffmpeg reads it from a pipe: one MJPEG track, each frame a cluster of its own stamped with its time and
/// how long it shows (in ms), so ffmpeg decodes a frame once and repeats it itself for its constant frame rate.
mod mkv {
    /// An EBML number in its shortest form (all ones is reserved for "unknown").
    pub(super) fn size(n: usize, out: &mut Vec<u8>) {
        let len = (1..8).find(|l| n < (1 << (7 * l)) - 1).unwrap_or(8);
        let marked = n as u64 | 1 << (7 * len);
        out.extend_from_slice(&marked.to_be_bytes()[8 - len..]);
    }

    fn element(id: &[u8], body: &[u8], out: &mut Vec<u8>) {
        out.extend_from_slice(id);
        size(body.len(), out);
        out.extend_from_slice(body);
    }

    fn uint(id: &[u8], n: u64, out: &mut Vec<u8>) {
        let bytes = n.to_be_bytes();
        let skip = (n.leading_zeros() as usize / 8).min(7);
        element(id, &bytes[skip..], out);
    }

    /// The file's start: a segment of unknown size (it is a stream), times in ms, one `width`×`height` MJPEG track.
    pub fn header((width, height): (u32, u32)) -> Vec<u8> {
        let mut out = Vec::new();
        let mut ebml = Vec::new();
        element(&[0x42, 0x82], b"matroska", &mut ebml);
        uint(&[0x42, 0x87], 4, &mut ebml);
        uint(&[0x42, 0x85], 2, &mut ebml);
        element(&[0x1a, 0x45, 0xdf, 0xa3], &ebml, &mut out);
        // The segment, of unknown size.
        out.extend_from_slice(&[
            0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ]);
        let mut info = Vec::new();
        uint(&[0x2a, 0xd7, 0xb1], 1_000_000, &mut info);
        element(&[0x15, 0x49, 0xa9, 0x66], &info, &mut out);
        let mut video = Vec::new();
        uint(&[0xb0], width.into(), &mut video);
        uint(&[0xba], height.into(), &mut video);
        let mut track = Vec::new();
        uint(&[0xd7], 1, &mut track);
        uint(&[0x73, 0xc5], 1, &mut track);
        uint(&[0x83], 1, &mut track);
        element(&[0x86], b"V_MJPEG", &mut track);
        element(&[0xe0], &video, &mut track);
        let mut entry = Vec::new();
        element(&[0xae], &track, &mut entry);
        element(&[0x16, 0x54, 0xae, 0x6b], &entry, &mut out);
        out
    }

    /// A frame shown from `at_ms` for `shows_ms`.
    pub fn frame(jpeg: &[u8], at_ms: u64, shows_ms: u64, out: &mut Vec<u8>) {
        let mut block = Vec::with_capacity(jpeg.len() + 4);
        // Track 1, at the cluster's own time, no flags.
        block.extend_from_slice(&[0x81, 0, 0, 0]);
        block.extend_from_slice(jpeg);
        let mut group = Vec::with_capacity(block.len() + 16);
        element(&[0xa1], &block, &mut group);
        uint(&[0x9b], shows_ms, &mut group);
        let mut cluster = Vec::with_capacity(group.len() + 16);
        uint(&[0xe7], at_ms, &mut cluster);
        element(&[0xa0], &group, &mut cluster);
        element(&[0x1f, 0x43, 0xb6, 0x75], &cluster, out);
    }
}

/// A frame and the first tick of the video it shows in.
struct Held {
    jpeg: Vec<u8>,
    tick: u64,
}

/// The video encoder, fed frames by [`VideoSink`]. None without an ffmpeg.
struct Encoder {
    child: Child,
    stdin: ChildStdin,
    /// ffmpeg's own words, beside the video; never uploaded.
    log: PathBuf,
    size: (u32, u32),
    /// The newest frame, not written yet: how long it shows is known once a later one comes, time passes or the
    /// video ends.
    held: Option<Held>,
    /// Whether the header has gone.
    started: bool,
}

impl Encoder {
    fn start(ffmpeg: &Path, out: &Path, (width, height): (u32, u32)) -> Result<Self, String> {
        let size = format!("{width}:{height}");
        let log = out.with_extension("log");
        let stderr = std::fs::File::create(&log)
            .map_err(|e| format!("cannot write {}: {e}", log.display()))?;
        let mut child = Command::new(ffmpeg)
            .args(["-loglevel", "error", "-f", "matroska"])
            .args([
                "-fpsprobesize",
                "0",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
            ])
            .args(["-i", "pipe:0"])
            // A steady FPS: ffmpeg shows each frame for its ticks, as the frames' times and durations say.
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
            // No look-ahead (the realtime deadline uses none anyway; the video is the same, ffmpeg holds ~60 MB less).
            .args([
                "-speed",
                "8",
                "-b:v",
                "1M",
                "-threads",
                "1",
                "-lag-in-frames",
                "0",
            ])
            .args(["-vf", &format!("pad={size}:0:0:gray,crop={size}:0:0")])
            // 4:2:0 whatever the frames are (a desktop's keep colour at full resolution): VP9's profile 0, which every
            // player plays, at its usual cost.
            .args(["-pix_fmt", "yuv420p"])
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
            size: (width, height),
            held: None,
            started: false,
        })
    }

    /// Writes the held frame, shown until tick `until`, its last `own` ticks each a block of their own. So the video's
    /// last frame always comes one tick after the block before it: ffmpeg 6 shows the last frame as long as that gap,
    /// whatever its duration says.
    async fn write(&mut self, until: u64, own: u64) -> std::io::Result<()> {
        let Some(held) = &self.held else {
            return Ok(());
        };
        let ms = |tick: u64| tick * 1000 / FPS;
        let mut bytes = if self.started {
            Vec::with_capacity((held.jpeg.len() + 64) * (own as usize + 1))
        } else {
            mkv::header(self.size)
        };
        let cut = until.saturating_sub(own).max(held.tick + 1);
        mkv::frame(&held.jpeg, ms(held.tick), ms(cut - held.tick), &mut bytes);
        for tick in cut..until {
            mkv::frame(&held.jpeg, ms(tick), ms(1), &mut bytes);
        }
        self.stdin.write_all(&bytes).await?;
        self.started = true;
        Ok(())
    }

    /// The frame shown until now runs until this one's time; the first also covers the time before it. Of frames
    /// within one tick the newest shows.
    async fn frame(&mut self, jpeg: Vec<u8>, at: Duration) -> std::io::Result<()> {
        let tick = frames_at(at);
        let from = self.held.as_ref().map_or(0, |held| held.tick);
        if from < tick {
            if self.held.is_none() {
                self.held = Some(Held {
                    jpeg: jpeg.clone(),
                    tick: 0,
                });
            }
            self.write(tick, 1).await?;
        }
        self.held = Some(Held {
            jpeg,
            tick: from.max(tick),
        });
        Ok(())
    }

    /// Time passes on a still page: once a second its frame is written up to now, so the file keeps up.
    async fn tick(&mut self, at: Duration) -> std::io::Result<()> {
        let due = frames_at(at);
        match &self.held {
            Some(held) if held.tick + FPS < due => {
                self.write(due - 1, 1).await?;
                if let Some(held) = &mut self.held {
                    held.tick = due - 1;
                }
                Ok(())
            }
            _ => Ok(()),
        }
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
        if let Some(held) = &self.held {
            // The last frame shows for at least one tick.
            let until = frames_at(at).max(held.tick + 1);
            self.write(until, 2)
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
                    Feed::Tick(at) if broken.is_none() => encoder.tick(at).await,
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
    write_line(path, &value)
}

fn write_line(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(&line)
}

/// Appends a step to the action log, scrubbed, and keeps it as its session's latest for the heartbeat.
pub fn append_action(dir: &Path, action: &BrowserAction, scrub: &Scrub) -> std::io::Result<()> {
    let mut value = serde_json::to_value(action).map_err(std::io::Error::other)?;
    scrub.value(&mut value);
    if let (Some(id), Ok(step)) = (
        dir.file_name().and_then(|n| n.to_str()),
        serde_json::from_value::<BrowserAction>(value.clone()),
    ) {
        steps::note(dir, id, step);
    }
    write_line(&dir.join(RecordingFile::Actions.file_name()), &value)
}

/// Each session's latest step on this machine, for the heartbeat: the Screens page says what each live screen's agent
/// did last. Kept by the session's id (its recording's folder name) with that folder; one whose folder is gone
/// (uploaded, thrown away) or whose step is a day old is forgotten.
pub mod steps {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use fleetd_contracts::browser::{
        BrowserAction, BrowserSessionId, SCREEN_STEPS_MAX, STEP_ARGS_BYTES, STEP_RESULT_CHARS,
        ScreenStep,
    };

    const KEEP: Duration = Duration::from_secs(24 * 3600);

    type Steps = HashMap<String, (Instant, PathBuf, BrowserAction)>;

    static STEPS: Mutex<Option<Steps>> = Mutex::new(None);

    fn lock() -> std::sync::MutexGuard<'static, Option<Steps>> {
        STEPS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The step, cut short for the heartbeat: a long command's args go as `{}`, a result to its start.
    pub fn brief(mut step: BrowserAction) -> BrowserAction {
        if serde_json::to_vec(&step.args).map_or(true, |a| a.len() > STEP_ARGS_BYTES) {
            step.args = serde_json::json!({});
        }
        step.result = step
            .result
            .map(|r| r.chars().take(STEP_RESULT_CHARS).collect());
        step
    }

    pub fn note(dir: &Path, session_id: &str, step: BrowserAction) {
        if BrowserSessionId::new(session_id).is_err() {
            return;
        }
        lock().get_or_insert_default().insert(
            session_id.to_owned(),
            (Instant::now(), dir.to_owned(), brief(step)),
        );
    }

    /// The latest step of each session whose recording is still here, newest first, at most [`SCREEN_STEPS_MAX`]; the
    /// rest are forgotten.
    pub fn latest() -> Vec<ScreenStep> {
        let mut guard = lock();
        let Some(steps) = guard.as_mut() else {
            return Vec::new();
        };
        steps.retain(|_, (at, dir, _)| at.elapsed() < KEEP && dir.is_dir());
        let mut out: Vec<_> = steps.iter().collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.1.0));
        out.into_iter()
            .take(SCREEN_STEPS_MAX)
            .map(|(id, (_, _, step))| ScreenStep {
                session_id: BrowserSessionId::unchecked(id),
                step: step.clone(),
            })
            .collect()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_logged_step_is_its_sessions_latest_scrubbed_and_short_until_its_recording_goes() {
        let root = tempfile::tempdir().unwrap();
        let id = "B00000000000000000000000000000abc";
        let dir = root.path().join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let scrub = Scrub::new(&[("TOKEN".to_owned(), "s3cr3t-value".to_owned())]);
        let action = |seq: u64, args: serde_json::Value, result: &str| -> BrowserAction {
            serde_json::from_value(serde_json::json!({
                "seq": seq, "at": "2026-11-03T10:00:00.000Z", "offsetMs": 0, "tool": "agent-browser",
                "args": args, "ok": true, "result": result, "durationMs": 1,
            }))
            .unwrap()
        };
        let mine = |steps: Vec<fleetd_contracts::browser::ScreenStep>| {
            steps.into_iter().find(|s| s.session_id.as_str() == id)
        };
        append_action(
            &dir,
            &action(
                1,
                serde_json::json!({ "command": "open https://a.example" }),
                "ok",
            ),
            &scrub,
        )
        .unwrap();
        let typed = serde_json::json!({ "command": "fill @e2 s3cr3t-value" });
        append_action(&dir, &action(2, typed, &"x".repeat(500)), &scrub).unwrap();
        let latest = mine(steps::latest()).unwrap().step;
        assert_eq!(latest.seq, 2);
        let command = latest.args["command"].as_str().unwrap();
        assert!(
            !command.contains("s3cr3t-value"),
            "scrubbed as logged: {command}"
        );
        assert_eq!(latest.result.unwrap().chars().count(), 200);
        // A script's long args go as {}: the step's words need its command only.
        let long = serde_json::json!({ "command": format!("eval {}", "a".repeat(900)) });
        append_action(&dir, &action(3, long, "ok"), &scrub).unwrap();
        assert_eq!(
            mine(steps::latest()).unwrap().step.args,
            serde_json::json!({})
        );
        // Its recording uploaded and gone: forgotten.
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(mine(steps::latest()).is_none());
    }

    #[test]
    fn sizes_are_shortest_ebml_numbers() {
        let size = |n| {
            let mut out = Vec::new();
            mkv::size(n, &mut out);
            out
        };
        assert_eq!(size(0), [0x80]);
        assert_eq!(size(126), [0xfe]);
        // 127 in one byte would be all ones: "unknown".
        assert_eq!(size(127), [0x40, 0x7f]);
        assert_eq!(size(70_000), [0x21, 0x11, 0x70]);
    }

    fn jpeg(rgb: [u8; 3]) -> Vec<u8> {
        let pixels: Vec<u8> = (0..64 * 48).flat_map(|_| rgb).collect();
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, 80)
            .encode(&pixels, 64, 48, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        out
    }

    /// The (id, body) of each EBML element in `bytes`.
    fn elements(mut bytes: &[u8]) -> Vec<(u32, &[u8])> {
        let number = |bytes: &[u8], keep_marker: bool| {
            let len = bytes[0].leading_zeros() as usize + 1;
            let mut n = u64::from(if keep_marker {
                bytes[0]
            } else {
                bytes[0] & 0xff_u8.checked_shr(len as u32).unwrap_or(0)
            });
            for b in &bytes[1..len] {
                n = n << 8 | u64::from(*b);
            }
            (n, len)
        };
        let mut out = Vec::new();
        while !bytes.is_empty() {
            let (id, id_len) = number(bytes, true);
            let (size, size_len) = number(&bytes[id_len..], false);
            let start = id_len + size_len;
            let end = (start + size as usize).min(bytes.len());
            out.push((id as u32, &bytes[start..end]));
            bytes = &bytes[end..];
        }
        out
    }

    /// Each video frame's time in ms, as the webm has them.
    fn frame_times(webm: &[u8]) -> Vec<i64> {
        let mut times = Vec::new();
        let segment = elements(webm)
            .into_iter()
            .find(|(id, _)| *id == 0x1853_8067)
            .expect("a segment")
            .1;
        for (_, cluster) in elements(segment)
            .into_iter()
            .filter(|(id, _)| *id == 0x1f43_b675)
        {
            let mut base = 0;
            for (id, body) in elements(cluster) {
                match id {
                    0xe7 => base = body.iter().fold(0i64, |n, b| n << 8 | i64::from(*b)),
                    0xa3 => times.push(base + i64::from(i16::from_be_bytes([body[1], body[2]]))),
                    _ => {}
                }
            }
        }
        times
    }

    /// Frames at their own times, newest per tick, a still page's ticks and the end: the video has a frame for every
    /// 1/25 s up to the end, as when the encoder was fed the held frame 25 times a second.
    #[tokio::test]
    async fn the_video_holds_each_frame_at_a_steady_rate() {
        let Some(ffmpeg) = super::super::tests::ffmpeg() else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("video.webm");
        let sink = VideoSink::start(Some(&ffmpeg), out.clone(), (64, 48)).unwrap();
        let ms = Duration::from_millis;
        sink.frame(jpeg([200, 0, 0]), ms(130));
        sink.frame(jpeg([0, 200, 0]), ms(150));
        sink.frame(jpeg([0, 0, 200]), ms(170));
        sink.tick(ms(1000));
        sink.frame(jpeg([200, 200, 0]), ms(1210));
        for second in 2..=4 {
            sink.tick(ms(second * 1000));
        }
        sink.frame(jpeg([0, 200, 200]), ms(4415));
        sink.finish(ms(4503)).await.unwrap();
        let times = frame_times(&std::fs::read(&out).unwrap());
        assert_eq!(times, (0..112).map(|n| n * 40).collect::<Vec<_>>());
    }

    /// A frame in the last tick still shows, for one tick.
    #[tokio::test]
    async fn the_last_frame_shows() {
        let Some(ffmpeg) = super::super::tests::ffmpeg() else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("video.webm");
        let sink = VideoSink::start(Some(&ffmpeg), out.clone(), (64, 48)).unwrap();
        sink.frame(jpeg([200, 0, 0]), Duration::from_millis(300));
        sink.finish(Duration::from_millis(310)).await.unwrap();
        let times = frame_times(&std::fs::read(&out).unwrap());
        assert_eq!(times, (0..8).map(|n| n * 40).collect::<Vec<_>>());
    }
}
