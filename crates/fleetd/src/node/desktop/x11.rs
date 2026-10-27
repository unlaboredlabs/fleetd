//! The node's own X11 connection to a session's display, over its socket with the display's cookie: the screen as
//! JPEG (GetImage, with DAMAGE saying when it changed), and the agent's and a person's input through XTEST, as
//! xdotool sends it. Nothing else reaches the display but the session's own apps.
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, ImageFormat, ImageOrder};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::{DefaultStream, RustConnection};

/// JPEG quality of the frames: the live view's, the video's and the agent's screenshots.
const QUALITY: u8 = 70;

const NO_SYMBOL: u32 = 0;
const SHIFT_L: u32 = 0xffe1;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One grab of the screen.
pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct X {
    conn: RustConnection,
    root: xproto::Window,
    width: u16,
    height: u16,
    lsb_first: bool,
    keys: Mutex<Keymap>,
    damage: Option<damage::Damage>,
}

/// The display's keyboard mapping, as the node last read or changed it.
struct Keymap {
    min: u8,
    per: u8,
    syms: Vec<u32>,
    /// A keycode with nothing on it, bound to each keysym the map lacks while it is typed.
    scratch: Option<u8>,
}

impl Keymap {
    /// The keycode for a keysym, and whether Shift picks it there.
    fn find(&self, sym: u32) -> Option<(u8, bool)> {
        let per = usize::from(self.per.max(1));
        self.syms.chunks(per).enumerate().find_map(|(i, row)| {
            let code = self.min.checked_add(u8::try_from(i).ok()?)?;
            match row.iter().take(2).position(|s| *s == sym)? {
                0 => Some((code, false)),
                _ => Some((code, true)),
            }
        })
    }
}

fn x_err(e: impl std::fmt::Display) -> String {
    format!("the X display: {e}")
}

impl X {
    /// Connects to the X server at `socket`, authorized by its MIT cookie.
    pub fn connect(socket: &Path, cookie: &[u8]) -> Result<Self, String> {
        let stream = UnixStream::connect(socket)
            .map_err(|e| format!("cannot reach {}: {e}", socket.display()))?;
        let (stream, _) = DefaultStream::from_unix_stream(stream).map_err(x_err)?;
        let conn = RustConnection::connect_to_stream_with_auth_info(
            stream,
            0,
            b"MIT-MAGIC-COOKIE-1".to_vec(),
            cookie.to_vec(),
        )
        .map_err(x_err)?;
        let setup = conn.setup();
        let screen = setup.roots.first().ok_or("the X display has no screen")?;
        let (root, width, height) = (screen.root, screen.width_in_pixels, screen.height_in_pixels);
        let lsb_first = setup.image_byte_order == ImageOrder::LSB_FIRST;
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        if conn
            .extension_information(xtest::X11_EXTENSION_NAME)
            .map_err(x_err)?
            .is_none()
        {
            return Err("the X display has no XTEST extension".into());
        }
        let damage = match conn.extension_information(damage::X11_EXTENSION_NAME) {
            Ok(Some(_)) => (|| {
                conn.damage_query_version(1, 1).ok()?.reply().ok()?;
                let id = conn.generate_id().ok()?;
                conn.damage_create(id, root, damage::ReportLevel::NON_EMPTY)
                    .ok()?;
                Some(id)
            })(),
            _ => None,
        };
        let keys = read_keymap(&conn, min, max)?;
        conn.flush().map_err(x_err)?;
        Ok(Self {
            conn,
            root,
            width,
            height,
            lsb_first,
            keys: Mutex::new(keys),
            damage,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (u32::from(self.width), u32::from(self.height))
    }

    /// Whether the screen may have changed since the last call: always without DAMAGE.
    pub fn changed(&self) -> bool {
        let Some(damage) = self.damage else {
            return true;
        };
        let mut changed = false;
        while let Ok(Some(event)) = self.conn.poll_for_event() {
            match event {
                Event::DamageNotify(_) => changed = true,
                Event::MappingNotify(_) => {
                    let min = lock(&self.keys).min;
                    if let Ok(keys) = read_keymap(&self.conn, min, self.max_keycode()) {
                        let mut held = lock(&self.keys);
                        *held = Keymap {
                            scratch: held.scratch,
                            ..keys
                        };
                    }
                }
                _ => {}
            }
        }
        if changed {
            let _ = self.conn.damage_subtract(damage, x11rb::NONE, x11rb::NONE);
            let _ = self.conn.flush();
        }
        changed
    }

    fn max_keycode(&self) -> u8 {
        self.conn.setup().max_keycode
    }

    /// The whole screen, as a JPEG.
    pub fn grab(&self) -> Result<Shot, String> {
        let raw = self.grab_raw()?;
        Ok(Shot {
            jpeg: self.encode(&raw)?,
            width: u32::from(self.width),
            height: u32::from(self.height),
        })
    }

    /// The screen's pixels as the server sends them (32 bits each).
    pub fn grab_raw(&self) -> Result<Vec<u8>, String> {
        let image = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                0,
                0,
                self.width,
                self.height,
                !0,
            )
            .map_err(x_err)?
            .reply()
            .map_err(x_err)?;
        let want = usize::from(self.width) * usize::from(self.height) * 4;
        if image.data.len() < want {
            return Err(format!(
                "the X display sent {} bytes for a {}x{} screen; it needs 24-bit color",
                image.data.len(),
                self.width,
                self.height
            ));
        }
        Ok(image.data)
    }

    /// A raw grab as a JPEG.
    pub fn encode(&self, raw: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(raw.len() / 10);
        let encoder = jpeg_encoder::Encoder::new(&mut out, QUALITY);
        let encoded = if self.lsb_first {
            encoder.encode(raw, self.width, self.height, jpeg_encoder::ColorType::Bgra)
        } else {
            // xRGB, most significant byte first: the same bytes reversed in each pixel.
            let flipped: Vec<u8> = raw
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|[a, r, g, b]| [*b, *g, *r, *a])
                .collect();
            encoder.encode(
                &flipped,
                self.width,
                self.height,
                jpeg_encoder::ColorType::Bgra,
            )
        };
        encoded.map_err(|e| format!("cannot encode the screen: {e}"))?;
        Ok(out)
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, x, y, 0)
            .map_err(x_err)?;
        Ok(())
    }

    /// Waits until the server has done everything sent so far.
    pub fn sync(&self) -> Result<(), String> {
        self.conn
            .get_input_focus()
            .map_err(x_err)?
            .reply()
            .map_err(x_err)?;
        Ok(())
    }

    fn clamp(&self, x: i64, y: i64) -> (i16, i16) {
        let x = x.clamp(0, i64::from(self.width.saturating_sub(1)));
        let y = y.clamp(0, i64::from(self.height.saturating_sub(1)));
        (x as i16, y as i16)
    }

    pub fn move_to(&self, x: i64, y: i64) -> Result<(), String> {
        let (x, y) = self.clamp(x, y);
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, x, y)
    }

    /// Presses or releases a mouse button (1 left, 2 middle, 3 right, 4-7 the wheel).
    pub fn button(&self, button: u8, down: bool) -> Result<(), String> {
        let kind = match down {
            true => xproto::BUTTON_PRESS_EVENT,
            false => xproto::BUTTON_RELEASE_EVENT,
        };
        self.fake(kind, button, 0, 0)
    }

    pub fn click(&self, x: i64, y: i64, button: u8, count: u8) -> Result<(), String> {
        self.move_to(x, y)?;
        for _ in 0..count {
            self.button(button, true)?;
            self.button(button, false)?;
        }
        self.sync()
    }

    pub fn drag(&self, from: (i64, i64), to: (i64, i64)) -> Result<(), String> {
        self.move_to(from.0, from.1)?;
        self.button(1, true)?;
        self.sync()?;
        // A few steps on the way, for apps that only start a drag once the pointer moves.
        for step in 1..=4 {
            let at = |a: i64, b: i64| a + (b - a) * step / 4;
            self.move_to(at(from.0, to.0), at(from.1, to.1))?;
        }
        self.button(1, false)?;
        self.sync()
    }

    /// Wheel clicks at a point: `dy` > 0 scrolls down, `dx` > 0 right.
    pub fn scroll(&self, x: i64, y: i64, dx: i64, dy: i64) -> Result<(), String> {
        self.move_to(x, y)?;
        let wheel = |button: u8, n: i64| -> Result<(), String> {
            for _ in 0..n.unsigned_abs().min(50) {
                self.button(button, true)?;
                self.button(button, false)?;
            }
            Ok(())
        };
        wheel(if dy < 0 { 4 } else { 5 }, dy)?;
        wheel(if dx < 0 { 6 } else { 7 }, dx)?;
        self.sync()
    }

    pub fn pointer(&self) -> Result<(i64, i64), String> {
        let at = self
            .conn
            .query_pointer(self.root)
            .map_err(x_err)?
            .reply()
            .map_err(x_err)?;
        Ok((i64::from(at.root_x), i64::from(at.root_y)))
    }

    /// The keycode for a keysym, binding it to the scratch keycode when the keyboard lacks it; and whether Shift
    /// picks it.
    fn keycode(&self, sym: u32) -> Result<(u8, bool), String> {
        let mut keys = lock(&self.keys);
        if let Some(found) = keys.find(sym) {
            return Ok(found);
        }
        let scratch = match keys.scratch {
            Some(code) => code,
            None => {
                let per = usize::from(keys.per.max(1));
                let empty = keys
                    .syms
                    .chunks(per)
                    .rposition(|row| row.iter().all(|s| *s == NO_SYMBOL))
                    .ok_or("the keyboard has no free keycode to type this with")?;
                let code = keys.min + u8::try_from(empty).map_err(|e| e.to_string())?;
                keys.scratch = Some(code);
                code
            }
        };
        let per = keys.per.max(1);
        let row = vec![sym; usize::from(per)];
        self.conn
            .change_keyboard_mapping(1, scratch, per, &row)
            .map_err(x_err)?;
        let start = usize::from(scratch - keys.min) * usize::from(per);
        if let Some(slot) = keys.syms.get_mut(start..start + usize::from(per)) {
            slot.copy_from_slice(&row);
        }
        drop(keys);
        self.sync()?;
        Ok((scratch, false))
    }

    /// Presses or releases one key by keysym; Shift goes with it where the keyboard needs it, when `shift` allows.
    pub fn key_sym(&self, sym: u32, down: bool, shift: bool) -> Result<(), String> {
        let (code, needs_shift) = self.keycode(sym)?;
        let shift_code = match needs_shift && shift {
            true => Some(self.keycode(SHIFT_L)?.0),
            false => None,
        };
        let kind = |down| match down {
            true => xproto::KEY_PRESS_EVENT,
            false => xproto::KEY_RELEASE_EVENT,
        };
        if down && let Some(shift) = shift_code {
            self.fake(kind(true), shift, 0, 0)?;
        }
        self.fake(kind(down), code, 0, 0)?;
        if !down && let Some(shift) = shift_code {
            self.fake(kind(false), shift, 0, 0)?;
        }
        Ok(())
    }

    /// A chord as xdotool names it (`ctrl+shift+t`): every key pressed in order, then released in reverse.
    pub fn chord(&self, chord: &str) -> Result<(), String> {
        let syms = parse_chord(chord)?;
        let shifted = syms.len() == 1;
        for sym in &syms {
            self.key_sym(*sym, true, shifted)?;
        }
        for sym in syms.iter().rev() {
            self.key_sym(*sym, false, shifted)?;
        }
        self.sync()
    }

    /// Types text, a key per character.
    pub fn type_text(&self, text: &str) -> Result<(), String> {
        for c in text.chars() {
            let sym = char_keysym(c);
            self.key_sym(sym, true, true)?;
            self.key_sym(sym, false, true)?;
            // Each key is done before the next, as xdotool's own small delay makes sure.
            self.sync()?;
        }
        Ok(())
    }
}

fn read_keymap(conn: &RustConnection, min: u8, max: u8) -> Result<Keymap, String> {
    let map = conn
        .get_keyboard_mapping(min, max - min + 1)
        .map_err(x_err)?
        .reply()
        .map_err(x_err)?;
    Ok(Keymap {
        min,
        per: map.keysyms_per_keycode,
        syms: map.keysyms,
        scratch: None,
    })
}

/// A character's keysym: Latin-1 as itself, the rest of Unicode as X maps it; newline and tab as their keys.
pub fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        ' '..='~' | '\u{a0}'..='\u{ff}' => c as u32,
        _ => 0x0100_0000 | c as u32,
    }
}

/// A key's keysym by its xdotool (X keysym) name, its browser `KeyboardEvent.key` name, or the character it types.
pub fn keysym(name: &str) -> Option<u32> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(char_keysym(c));
    }
    if let Some(n) = name
        .strip_prefix(['F', 'f'])
        .and_then(|n| n.parse::<u32>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return Some(0xffbe + n - 1);
    }
    let sym = match name.to_ascii_lowercase().as_str() {
        "return" | "enter" | "kp_enter" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" | "del" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "page_up" | "prior" | "pageup" => 0xff55,
        "page_down" | "next" | "pagedown" => 0xff56,
        "left" | "arrowleft" => 0xff51,
        "up" | "arrowup" => 0xff52,
        "right" | "arrowright" => 0xff53,
        "down" | "arrowdown" => 0xff54,
        "space" => 0x20,
        "menu" | "contextmenu" => 0xff67,
        "print" | "printscreen" => 0xff61,
        "caps_lock" | "capslock" => 0xffe5,
        "shift" | "shift_l" => SHIFT_L,
        "shift_r" => 0xffe2,
        "ctrl" | "control" | "control_l" => 0xffe3,
        "control_r" => 0xffe4,
        "alt" | "alt_l" => 0xffe9,
        "alt_r" | "altgraph" => 0xffea,
        "super" | "super_l" | "meta" | "win" | "cmd" | "os" => 0xffeb,
        "super_r" => 0xffec,
        "minus" => 0x2d,
        "plus" => 0x2b,
        "equal" => 0x3d,
        "comma" => 0x2c,
        "period" => 0x2e,
        "slash" => 0x2f,
        "backslash" => 0x5c,
        "semicolon" => 0x3b,
        "apostrophe" => 0x27,
        "grave" => 0x60,
        "bracketleft" => 0x5b,
        "bracketright" => 0x5d,
        _ => return None,
    };
    Some(sym)
}

/// `ctrl+shift+t` as keysyms, in order.
pub fn parse_chord(chord: &str) -> Result<Vec<u32>, String> {
    let names: Vec<&str> = match chord {
        "+" => vec!["+"],
        _ => chord.split('+').map(str::trim).collect(),
    };
    names
        .iter()
        .map(|name| match name.is_empty() {
            true => Err(format!("`{chord}` names an empty key")),
            false => keysym(name).ok_or_else(|| {
                format!(
                    "`{name}` is not a key name (use xdotool's: Return, ctrl+s, alt+F4, Page_Down)"
                )
            }),
        })
        .collect()
}

/// How long the node waits for a display's socket to answer.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
