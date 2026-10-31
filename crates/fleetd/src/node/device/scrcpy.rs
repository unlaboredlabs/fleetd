//! An emulator's screen and input, through scrcpy's server: the node pushes the pinned jar, starts it over adb and
//! speaks its protocol itself (no scrcpy client, no window). Its H.264 stream is decoded by ffmpeg into JPEG frames,
//! which feed both the session's video (record.rs's VP9 encoder, as for a browser) and whoever watches it live; a
//! person's input goes back on its control socket as touches, scrolls, key events and text.
//!
//! The protocol is scrcpy's own and changes between versions, so the server is pinned with it (sdk.rs). It runs with
//! `raw_stream` (bare H.264, no headers) but a dummy byte, so the node knows a forwarded connection reached it.
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rand::RngCore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::sdk::{SCRCPY_VERSION, Sdk};
use crate::node::util::AbortOnDrop;

/// Where the jar goes on the device.
const SERVER_PATH: &str = "/data/local/tmp/scrcpy-server.jar";
/// The longer side of the stream: a 720×1600 screen comes as 576×1280.
pub const MAX_SIZE: u32 = 1280;
const MAX_FPS: u32 = 30;
/// scrcpy refuses longer text in one message.
const TEXT_MAX_BYTES: usize = 300;

/// One frame of the screen, as JPEG.
#[derive(Clone, Debug)]
pub struct Frame {
    /// 1, 2, ... per stream.
    pub seq: u64,
    pub jpeg: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    /// From the session's start.
    pub at: Duration,
}

/// A running server for one emulator: its frames go to `on_frame`; [`Stream::send`] takes input. Stopped (the server,
/// the decoder, the forward) when dropped.
pub struct Stream {
    control: mpsc::UnboundedSender<Vec<u8>>,
    size: Arc<std::sync::Mutex<Option<(u32, u32)>>>,
    _server: Child,
    _decoder: Child,
    _tasks: Vec<AbortOnDrop>,
    _forward: Forward,
}

/// An adb forward, removed when dropped.
struct Forward {
    adb: std::process::Command,
    port: u16,
}

impl Drop for Forward {
    fn drop(&mut self) {
        let _ = self
            .adb
            .args(["forward", "--remove", &format!("tcp:{}", self.port)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// The server's arguments, in order: `send_dummy_byte` after `raw_stream`, which turns it off.
pub fn server_args(scid: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        format!("CLASSPATH={SERVER_PATH}"),
        "app_process".into(),
        "/".into(),
        "com.genymobile.scrcpy.Server".into(),
        SCRCPY_VERSION.into(),
    ];
    args.extend([
        format!("scid={scid}"),
        "log_level=warn".into(),
        "tunnel_forward=true".into(),
        "audio=false".into(),
        "control=true".into(),
        "video_codec=h264".into(),
        format!("max_size={MAX_SIZE}"),
        format!("max_fps={MAX_FPS}"),
        "raw_stream=true".into(),
        "send_dummy_byte=true".into(),
        "clipboard_autosync=false".into(),
    ]);
    args
}

/// Puts scrcpy's server on the device, where [`Stream::start`] runs it: done by the pool while a copy waits, so a
/// session's stream starts without it.
pub async fn push_server(sdk: &Sdk, serial: &str) -> Result<(), String> {
    let pushed = sdk
        .adb_async(serial)
        .arg("push")
        .arg(&sdk.scrcpy_server)
        .arg(SERVER_PATH)
        .output()
        .await
        .map_err(|e| format!("cannot run adb: {e}"))?;
    if !pushed.status.success() {
        return Err(format!(
            "adb could not push scrcpy's server: {}",
            String::from_utf8_lossy(&pushed.stderr).trim()
        ));
    }
    Ok(())
}

impl Stream {
    /// Starts the server on `serial` (pushing it first unless it is `pushed` there) and decodes its stream with
    /// `ffmpeg`. Returns once both sockets are connected.
    pub async fn start(
        sdk: &Sdk,
        serial: &str,
        pushed: bool,
        ffmpeg: &std::path::Path,
        start: Instant,
        on_frame: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let t = Instant::now();
        if !pushed {
            push_server(sdk, serial).await?;
        }
        let push_ms = t.elapsed().as_millis() as u64;
        let scid = format!("{:08x}", rand::thread_rng().next_u32() & 0x7fff_ffff);
        let forwarded = sdk
            .adb_async(serial)
            .args(["forward", "tcp:0", &format!("localabstract:scrcpy_{scid}")])
            .output()
            .await
            .map_err(|e| format!("cannot run adb: {e}"))?;
        let port: u16 = String::from_utf8_lossy(&forwarded.stdout)
            .trim()
            .parse()
            .map_err(|_| {
                format!(
                    "adb did not forward a port: {}",
                    String::from_utf8_lossy(&forwarded.stderr).trim()
                )
            })?;
        let forward = Forward {
            adb: sdk.adb(serial),
            port,
        };
        let server = sdk
            .adb_async(serial)
            .arg("shell")
            .args(server_args(&scid))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot start scrcpy's server: {e}"))?;
        let t = Instant::now();
        let (video, control) = connect(port).await?;
        tracing::debug!(
            kind = "android",
            serial,
            push_ms,
            connect_ms = t.elapsed().as_millis() as u64,
            "screen timing: scrcpy's stream connected"
        );
        let mut decoder = Command::new(ffmpeg)
            .args(["-loglevel", "error", "-f", "h264", "-flags", "low_delay"])
            .args(["-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"])
            .args(["-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", ffmpeg.display()))?;
        let mut decoder_in = decoder.stdin.take().expect("piped stdin");
        let mut decoder_out = decoder.stdout.take().expect("piped stdout");
        let pump = tokio::spawn(async move {
            let mut video = video;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match video.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if decoder_in.write_all(&buf[..n]).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let size = Arc::new(std::sync::Mutex::new(None));
        let frames = {
            let size = size.clone();
            let seq = AtomicU64::new(0);
            tokio::spawn(async move {
                let mut jpegs = Jpegs::default();
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let n = match decoder_out.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    for jpeg in jpegs.push(&buf[..n]) {
                        let Some((width, height)) = jpeg_size(&jpeg) else {
                            continue;
                        };
                        *size
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) =
                            Some((width, height));
                        on_frame(Frame {
                            seq: seq.fetch_add(1, Ordering::Relaxed) + 1,
                            jpeg: Arc::new(jpeg),
                            width,
                            height,
                            at: start.elapsed(),
                        });
                    }
                }
            })
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            let mut control = control;
            while let Some(message) = rx.recv().await {
                if control.write_all(&message).await.is_err() {
                    return;
                }
            }
        });
        Ok(Self {
            control: tx,
            size,
            _server: server,
            _decoder: decoder,
            _tasks: vec![AbortOnDrop(pump), AbortOnDrop(frames), AbortOnDrop(writer)],
            _forward: forward,
        })
    }

    /// The stream's size now, once a frame came.
    pub fn size(&self) -> Option<(u32, u32)> {
        *self
            .size
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Sends a person's input; positions are in the last frame's pixels. False when there is no frame yet to place a
    /// touch in, or the server is gone.
    pub fn send(&self, input: &Input) -> bool {
        let Some(size) = self.size() else {
            return false;
        };
        messages(input, size)
            .into_iter()
            .all(|m| self.control.send(m).is_ok())
    }
}

/// How soon a connect the server didn't take yet is tried again: it listens within a second of its start.
const CONNECT_RETRY: Duration = Duration::from_millis(20);

/// Connects the video socket, then the control socket, as the server accepts them. Until the server listens, adb
/// takes the connection and closes it at once: no dummy byte, so try again.
async fn connect(port: u16) -> Result<(TcpStream, TcpStream), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(mut video) = TcpStream::connect(("127.0.0.1", port)).await {
            let mut dummy = [0u8; 1];
            let read = tokio::time::timeout(Duration::from_secs(2), video.read(&mut dummy)).await;
            if let Ok(Ok(1)) = read {
                let control = TcpStream::connect(("127.0.0.1", port))
                    .await
                    .map_err(|e| format!("scrcpy's control socket did not connect: {e}"))?;
                let _ = video.set_nodelay(true);
                let _ = control.set_nodelay(true);
                return Ok((video, control));
            }
        }
        if Instant::now() > deadline {
            return Err("scrcpy's server did not answer in 10 s".to_owned());
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

/// Splits ffmpeg's MJPEG output into whole JPEGs (start FF D8, end FF D9; the data in between never holds FF D9).
#[derive(Default)]
struct Jpegs {
    buf: Vec<u8>,
}

impl Jpegs {
    fn push(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let Some(start) = find(&self.buf, &[0xff, 0xd8], 0) else {
                self.buf.clear();
                return out;
            };
            let Some(end) = find(&self.buf, &[0xff, 0xd9], start + 2) else {
                self.buf.drain(..start);
                return out;
            };
            out.push(self.buf[start..end + 2].to_vec());
            self.buf.drain(..end + 2);
        }
    }
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// A JPEG's width and height, from its frame header.
pub fn jpeg_size(jpeg: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < jpeg.len() {
        if jpeg[i] != 0xff {
            return None;
        }
        let marker = jpeg[i + 1];
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if matches!(marker, 0xc0..=0xc3) {
            let height = u16::from_be_bytes([jpeg[i + 5], jpeg[i + 6]]) as u32;
            let width = u16::from_be_bytes([jpeg[i + 7], jpeg[i + 8]]) as u32;
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

/// What a person does to a device, in the last frame's pixels. The app's mouse maps to one finger (a press is
/// `Down`, a move while pressed `Move`, a release `Up`), its wheel to `Scroll`, its keys to `Key` (a key that types
/// goes as `Text`).
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Touch {
        action: TouchAction,
        x: f64,
        y: f64,
    },
    /// Pixels as a browser's wheel reports them: positive `dy` scrolls down.
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    /// A key by the browser's `KeyboardEvent.key` name ("Enter", "Backspace", "ArrowUp"; "BrowserBack" and
    /// "BrowserHome" are Android's Back and Home); `modifiers` as CDP sums them (Alt 1, Ctrl 2, Meta 4, Shift 8).
    Key {
        down: bool,
        key: String,
        modifiers: u32,
    },
    Text(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchAction {
    Down,
    Up,
    Move,
}

/// Android's keycode for a browser key name; None for one that types (it goes as text) or that Android lacks.
pub fn keycode(key: &str) -> Option<u32> {
    Some(match key {
        "Enter" => 66,
        "Backspace" => 67,
        "Delete" => 112,
        "Tab" => 61,
        "Escape" => 111,
        "ArrowUp" => 19,
        "ArrowDown" => 20,
        "ArrowLeft" => 21,
        "ArrowRight" => 22,
        "Home" => 122,
        "End" => 123,
        "PageUp" => 92,
        "PageDown" => 93,
        "BrowserBack" => 4,
        "BrowserHome" => 3,
        "ContextMenu" => 82,
        "AudioVolumeUp" => 24,
        "AudioVolumeDown" => 25,
        _ => return None,
    })
}

/// Android's meta state for CDP's modifiers.
pub fn meta_state(modifiers: u32) -> u32 {
    let mut meta = 0;
    if modifiers & 1 != 0 {
        meta |= 0x02; // ALT_ON
    }
    if modifiers & 2 != 0 {
        meta |= 0x1000; // CTRL_ON
    }
    if modifiers & 4 != 0 {
        meta |= 0x10000; // META_ON
    }
    if modifiers & 8 != 0 {
        meta |= 0x01; // SHIFT_ON
    }
    meta
}

/// scrcpy's control messages for one input, given the stream's size.
pub fn messages(input: &Input, (width, height): (u32, u32)) -> Vec<Vec<u8>> {
    let position = |x: f64, y: f64| {
        let mut out = Vec::with_capacity(12);
        out.extend_from_slice(&(x.clamp(0.0, f64::from(width)) as i32).to_be_bytes());
        out.extend_from_slice(&(y.clamp(0.0, f64::from(height)) as i32).to_be_bytes());
        out.extend_from_slice(&(width as u16).to_be_bytes());
        out.extend_from_slice(&(height as u16).to_be_bytes());
        out
    };
    match input {
        Input::Touch { action, x, y } => {
            let mut m = vec![2u8];
            m.push(match action {
                TouchAction::Down => 0,
                TouchAction::Up => 1,
                TouchAction::Move => 2,
            });
            // A finger, not the mouse pointer (-1), so apps see a touch.
            m.extend_from_slice(&(-2i64).to_be_bytes());
            m.extend(position(*x, *y));
            let pressure: u16 = if *action == TouchAction::Up {
                0
            } else {
                0xffff
            };
            m.extend_from_slice(&pressure.to_be_bytes());
            m.extend_from_slice(&0i32.to_be_bytes()); // action button
            m.extend_from_slice(&0i32.to_be_bytes()); // buttons
            vec![m]
        }
        Input::Scroll { x, y, dx, dy } => {
            // scrcpy takes -16..16 notches as a signed 16-bit fraction of 16; a wheel notch is about 100 px, and a
            // positive vertical notch scrolls up.
            let fixed = |notches: f64| ((notches / 16.0).clamp(-1.0, 1.0) * 32767.0) as i16;
            let mut m = vec![3u8];
            m.extend(position(*x, *y));
            m.extend_from_slice(&fixed(dx / 100.0).to_be_bytes());
            m.extend_from_slice(&fixed(-dy / 100.0).to_be_bytes());
            m.extend_from_slice(&0i32.to_be_bytes());
            vec![m]
        }
        Input::Key {
            down,
            key,
            modifiers,
        } => {
            let Some(code) = keycode(key) else {
                return Vec::new();
            };
            let mut m = vec![0u8, if *down { 0 } else { 1 }];
            m.extend_from_slice(&code.to_be_bytes());
            m.extend_from_slice(&0u32.to_be_bytes()); // repeat
            m.extend_from_slice(&meta_state(*modifiers).to_be_bytes());
            vec![m]
        }
        Input::Text(text) => {
            let mut out = Vec::new();
            let mut rest = text.as_str();
            while !rest.is_empty() {
                let mut cut = rest.len().min(TEXT_MAX_BYTES);
                while !rest.is_char_boundary(cut) {
                    cut -= 1;
                }
                let (piece, after) = rest.split_at(cut);
                let mut m = vec![1u8];
                m.extend_from_slice(&(piece.len() as u32).to_be_bytes());
                m.extend_from_slice(piece.as_bytes());
                out.push(m);
                rest = after;
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_gets_a_dummy_byte_after_raw_stream_turns_it_off() {
        let args = server_args("1234abcd");
        assert_eq!(
            args[4], SCRCPY_VERSION,
            "the client's version must match the jar"
        );
        let raw = args.iter().position(|a| a == "raw_stream=true").unwrap();
        let dummy = args
            .iter()
            .position(|a| a == "send_dummy_byte=true")
            .unwrap();
        assert!(dummy > raw);
        assert!(args.contains(&"scid=1234abcd".to_owned()));
        assert!(args.contains(&"audio=false".to_owned()));
    }

    #[test]
    fn a_tap_is_a_finger_down_and_up_where_the_frame_was_touched() {
        let down = messages(
            &Input::Touch {
                action: TouchAction::Down,
                x: 288.0,
                y: 640.0,
            },
            (576, 1280),
        );
        assert_eq!(down.len(), 1);
        let m = &down[0];
        // type, action, pointer id, x, y, width, height, pressure, action button, buttons: 32 bytes.
        assert_eq!(m.len(), 32);
        assert_eq!(m[0..2], [2, 0]);
        assert_eq!(i64::from_be_bytes(m[2..10].try_into().unwrap()), -2);
        assert_eq!(i32::from_be_bytes(m[10..14].try_into().unwrap()), 288);
        assert_eq!(i32::from_be_bytes(m[14..18].try_into().unwrap()), 640);
        assert_eq!(u16::from_be_bytes(m[18..20].try_into().unwrap()), 576);
        assert_eq!(u16::from_be_bytes(m[20..22].try_into().unwrap()), 1280);
        assert_eq!(m[22..24], [0xff, 0xff]);
        let up = messages(
            &Input::Touch {
                action: TouchAction::Up,
                x: 9999.0,
                y: -5.0,
            },
            (576, 1280),
        );
        assert_eq!(up[0][1], 1);
        assert_eq!(
            i32::from_be_bytes(up[0][10..14].try_into().unwrap()),
            576,
            "kept on screen"
        );
        assert_eq!(i32::from_be_bytes(up[0][14..18].try_into().unwrap()), 0);
        assert_eq!(up[0][22..24], [0, 0]);
    }

    #[test]
    fn keys_map_to_android_keycodes_and_text_goes_in_pieces() {
        let enter = messages(
            &Input::Key {
                down: true,
                key: "Enter".into(),
                modifiers: 8,
            },
            (576, 1280),
        );
        assert_eq!(enter[0][0..2], [0, 0]);
        assert_eq!(u32::from_be_bytes(enter[0][2..6].try_into().unwrap()), 66);
        assert_eq!(
            u32::from_be_bytes(enter[0][10..14].try_into().unwrap()),
            0x01,
            "shift"
        );
        assert_eq!(keycode("BrowserBack"), Some(4));
        assert!(
            messages(
                &Input::Key {
                    down: true,
                    key: "a".into(),
                    modifiers: 0
                },
                (1, 1)
            )
            .is_empty(),
            "a key that types goes as text"
        );
        let long = "é".repeat(200); // 400 bytes
        let pieces = messages(&Input::Text(long.clone()), (1, 1));
        assert_eq!(pieces.len(), 2);
        let joined: Vec<u8> = pieces.iter().flat_map(|p| p[5..].to_vec()).collect();
        assert_eq!(String::from_utf8(joined).unwrap(), long);
        assert_eq!(meta_state(1 | 2 | 4), 0x02 | 0x1000 | 0x10000);
    }

    #[test]
    fn a_wheel_down_scrolls_down() {
        let m = &messages(
            &Input::Scroll {
                x: 10.0,
                y: 20.0,
                dx: 0.0,
                dy: 100.0,
            },
            (576, 1280),
        )[0];
        assert_eq!(m[0], 3);
        assert_eq!(m.len(), 1 + 12 + 2 + 2 + 4);
        assert!(i16::from_be_bytes(m[15..17].try_into().unwrap()) < 0);
    }

    #[test]
    fn jpegs_are_split_whole_and_measured() {
        // A minimal JPEG head: SOI, an APP0 segment, SOF0 with height 1280 and width 576, then EOI.
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
        jpeg.extend([
            0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x00, 0x02, 0x40, 0x01, 0x01, 0x11, 0x00,
        ]);
        jpeg.extend([0xff, 0xd9]);
        assert_eq!(jpeg_size(&jpeg), Some((576, 1280)));
        let mut split = Jpegs::default();
        let mut stream = jpeg.clone();
        stream.extend(&jpeg);
        let (a, b) = stream.split_at(jpeg.len() + 3);
        let first = split.push(a);
        assert_eq!(first, vec![jpeg.clone()]);
        assert_eq!(split.push(b), vec![jpeg]);
    }
}
