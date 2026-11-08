//! The Mac's screen as a session drives it: frames from ScreenCaptureKit (capture.rs) and input as CGEvents posted at
//! the HID level, as a mouse and keyboard would send them, in the display's points (a frame's pixels). The modifiers
//! held down are kept here and set on every event, so a person's Shift or Command and an agent's chords reach the
//! app whatever the HID system made of the modifier keys' own events. Typed text goes as the text key events carry,
//! so any keyboard layout types it as written; a chord's keys go by their place on an ANSI keyboard.
use std::sync::Mutex;
use std::time::Duration;

use super::capture::Capture;
use super::ffi::{self, Api, CGEventRef, CGPoint};
use super::keys::{self, Key};
use crate::node::desktop::screen::{Raw, Screen};
use crate::node::desktop::x11;

// CGEventType
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const RIGHT_DRAGGED: u32 = 7;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
const OTHER_DRAGGED: u32 = 27;
/// kCGHIDEventTap.
const HID: u32 = 0;
/// kCGMouseEventClickState.
const CLICK_STATE: u32 = 1;
/// kCGScrollEventUnitLine.
const LINES: u32 = 1;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A posted event, released once posted.
struct Event<'a> {
    api: &'a Api,
    event: CGEventRef,
}

impl Drop for Event<'_> {
    fn drop(&mut self) {
        // SAFETY: made by a CGEventCreate* call here, +1.
        unsafe { (self.api.CFRelease)(self.event) };
    }
}

pub struct MacScreen {
    capture: Capture,
    /// The modifiers held down now (keys::SHIFT, ...).
    flags: Mutex<u64>,
    /// The mouse buttons held down now: a move while one is down is a drag.
    buttons: Mutex<u8>,
}

impl MacScreen {
    /// The Mac's screen, once macOS has every call it needs.
    pub fn open() -> Result<Self, String> {
        ffi::api()?;
        Ok(Self {
            capture: Capture::new(),
            flags: Mutex::new(0),
            buttons: Mutex::new(0),
        })
    }

    fn api(&self) -> Result<&'static Api, String> {
        ffi::api()
    }

    fn post(&self, event: Event<'_>) -> Result<(), String> {
        if event.event.is_null() {
            return Err("macOS made no event".into());
        }
        // SAFETY: a live event made here.
        unsafe {
            (event.api.CGEventSetFlags)(event.event, *lock(&self.flags));
            (event.api.CGEventPost)(HID, event.event);
        }
        Ok(())
    }

    fn clamp(&self, x: i64, y: i64) -> CGPoint {
        let (w, h) = self.size();
        CGPoint {
            x: x.clamp(0, i64::from(w.saturating_sub(1))) as f64,
            y: y.clamp(0, i64::from(h.saturating_sub(1))) as f64,
        }
    }

    fn mouse(&self, kind: u32, at: CGPoint, button: u32, clicks: i64) -> Result<(), String> {
        let api = self.api()?;
        // SAFETY: a mouse event from no source, at a point.
        let event = Event {
            api,
            event: unsafe { (api.CGEventCreateMouseEvent)(std::ptr::null(), kind, at, button) },
        };
        if clicks > 0 && !event.event.is_null() {
            // SAFETY: a live event made here.
            unsafe { (api.CGEventSetIntegerValueField)(event.event, CLICK_STATE, clicks) };
        }
        self.post(event)
    }

    fn at_pointer(&self) -> Result<CGPoint, String> {
        let (x, y) = self.pointer()?;
        Ok(CGPoint {
            x: x as f64,
            y: y as f64,
        })
    }

    /// The event types of a button: down, up, dragged; and its CGMouseButton.
    fn kinds(button: u8) -> (u32, u32, u32, u32) {
        match button {
            3 => (RIGHT_DOWN, RIGHT_UP, RIGHT_DRAGGED, 1),
            2 => (OTHER_DOWN, OTHER_UP, OTHER_DRAGGED, 2),
            _ => (LEFT_DOWN, LEFT_UP, LEFT_DRAGGED, 0),
        }
    }

    fn key_code(&self, code: u16, down: bool) -> Result<(), String> {
        let api = self.api()?;
        // SAFETY: a keyboard event from no source.
        let event = Event {
            api,
            event: unsafe { (api.CGEventCreateKeyboardEvent)(std::ptr::null(), code, down) },
        };
        self.post(event)
    }

    /// Text no key types, as a key event carrying it.
    fn key_text(&self, text: &str) -> Result<(), String> {
        let api = self.api()?;
        let units: Vec<u16> = text.encode_utf16().collect();
        // A key event carries at most 20 UTF-16 units.
        for chunk in units.chunks(20) {
            for down in [true, false] {
                // SAFETY: a keyboard event from no source, given its text.
                let event = Event {
                    api,
                    event: unsafe { (api.CGEventCreateKeyboardEvent)(std::ptr::null(), 0, down) },
                };
                if !event.event.is_null() {
                    unsafe {
                        (api.CGEventKeyboardSetUnicodeString)(
                            event.event,
                            chunk.len(),
                            chunk.as_ptr(),
                        )
                    };
                }
                self.post(event)?;
            }
        }
        Ok(())
    }

    /// A key with Shift where it needs it, both down and up.
    fn tap(&self, code: u16, shift: bool) -> Result<(), String> {
        let before = *lock(&self.flags);
        if shift {
            *lock(&self.flags) |= keys::SHIFT;
        }
        let pressed = self
            .key_code(code, true)
            .and_then(|()| self.key_code(code, false));
        *lock(&self.flags) = before;
        pressed
    }
}

impl Screen for MacScreen {
    fn size(&self) -> (u32, u32) {
        Capture::size().unwrap_or((1, 1))
    }

    fn changed(&self) -> bool {
        true
    }

    fn grab_raw(&self) -> Result<Raw, String> {
        self.capture.grab()
    }

    fn encode(&self, raw: &Raw) -> Result<Vec<u8>, String> {
        crate::node::desktop::screen::jpeg(&raw.data, raw.width, raw.height)
    }

    fn sync(&self) -> Result<(), String> {
        // Posted events reach the window server in order; a moment lets the app take them in.
        std::thread::sleep(Duration::from_millis(20));
        Ok(())
    }

    fn move_to(&self, x: i64, y: i64) -> Result<(), String> {
        let at = self.clamp(x, y);
        let held = *lock(&self.buttons);
        match held {
            0 => self.mouse(MOVED, at, 0, 0),
            button => {
                let (_, _, dragged, which) = Self::kinds(button);
                self.mouse(dragged, at, which, 0)
            }
        }
    }

    fn button(&self, button: u8, down: bool) -> Result<(), String> {
        let at = self.at_pointer()?;
        let (pressed, released, _, which) = Self::kinds(button);
        *lock(&self.buttons) = if down { button } else { 0 };
        self.mouse(if down { pressed } else { released }, at, which, 1)
    }

    fn click(&self, x: i64, y: i64, button: u8, count: u8) -> Result<(), String> {
        let at = self.clamp(x, y);
        self.mouse(MOVED, at, 0, 0)?;
        let (pressed, released, _, which) = Self::kinds(button);
        for n in 1..=i64::from(count.max(1)) {
            self.mouse(pressed, at, which, n)?;
            self.mouse(released, at, which, n)?;
        }
        self.sync()
    }

    fn drag(&self, from: (i64, i64), to: (i64, i64)) -> Result<(), String> {
        let start = self.clamp(from.0, from.1);
        self.mouse(MOVED, start, 0, 0)?;
        self.mouse(LEFT_DOWN, start, 0, 1)?;
        self.sync()?;
        // A few steps on the way, for apps that only start a drag once the pointer moves.
        for step in 1..=4 {
            let at = |a: i64, b: i64| a + (b - a) * step / 4;
            self.mouse(
                LEFT_DRAGGED,
                self.clamp(at(from.0, to.0), at(from.1, to.1)),
                0,
                0,
            )?;
            std::thread::sleep(Duration::from_millis(15));
        }
        self.mouse(LEFT_UP, self.clamp(to.0, to.1), 0, 1)?;
        self.sync()
    }

    fn scroll(&self, x: i64, y: i64, dx: i64, dy: i64) -> Result<(), String> {
        self.mouse(MOVED, self.clamp(x, y), 0, 0)?;
        let api = self.api()?;
        // The wheel's lines: positive scrolls up and left, as a wheel turned away does.
        let (vertical, horizontal) = (-dy.clamp(-50, 50) as i32, -dx.clamp(-50, 50) as i32);
        // SAFETY: a scroll event from no source, two wheels.
        let event = Event {
            api,
            event: unsafe {
                (api.CGEventCreateScrollWheelEvent2)(
                    std::ptr::null(),
                    LINES,
                    2,
                    vertical,
                    horizontal,
                    0,
                )
            },
        };
        self.post(event)?;
        self.sync()
    }

    fn pointer(&self) -> Result<(i64, i64), String> {
        let api = self.api()?;
        // SAFETY: an empty event from no source says where the pointer is.
        let event = Event {
            api,
            event: unsafe { (api.CGEventCreate)(std::ptr::null()) },
        };
        if event.event.is_null() {
            return Err("macOS made no event to read the pointer from".into());
        }
        let at = unsafe { (api.CGEventGetLocation)(event.event) };
        Ok((at.x.round() as i64, at.y.round() as i64))
    }

    fn key_sym(&self, sym: u32, down: bool, shift: bool) -> Result<(), String> {
        match keys::of_sym(sym) {
            Key::Modifier(code, flag) => {
                {
                    let mut flags = lock(&self.flags);
                    if down {
                        *flags |= flag;
                    } else {
                        *flags &= !flag;
                    }
                }
                self.key_code(code, down)
            }
            Key::Code(code, needs_shift) => {
                let before = *lock(&self.flags);
                if needs_shift && shift {
                    *lock(&self.flags) |= keys::SHIFT;
                }
                let pressed = self.key_code(code, down);
                *lock(&self.flags) = before;
                pressed
            }
            Key::Text('\u{0}') => Ok(()),
            Key::Text(c) if down => self.key_text(&c.to_string()),
            Key::Text(_) => Ok(()),
        }
    }

    fn chord(&self, chord: &str) -> Result<(), String> {
        let syms = x11::parse_chord(chord)?;
        let shifted = syms.len() == 1;
        for sym in &syms {
            self.key_sym(*sym, true, shifted)?;
        }
        for sym in syms.iter().rev() {
            self.key_sym(*sym, false, shifted)?;
        }
        self.sync()
    }

    fn type_text(&self, text: &str) -> Result<(), String> {
        // As text the key events carry, whatever the keyboard's layout; a newline and a tab as their keys.
        let mut run = String::new();
        for c in text.chars() {
            match c {
                '\n' | '\r' | '\t' => {
                    if !run.is_empty() {
                        self.key_text(&std::mem::take(&mut run))?;
                    }
                    let (code, _) = keys::of_char(c).expect("newline and tab have keys");
                    self.tap(code, false)?;
                }
                c => run.push(c),
            }
        }
        if !run.is_empty() {
            self.key_text(&run)?;
        }
        self.sync()
    }
}
