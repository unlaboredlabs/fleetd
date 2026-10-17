//! External input latency on X11: type through XTEST and time until the input bar's pixels change.
//!
//! This is the whole path a user sees: X server -> gpui's X11 backend -> handler -> draw -> present ->
//! pixels in the X framebuffer. On Xvfb + lavapipe "present" is a CPU blit into the server, so the image
//! read back with GetImage is exactly what a screen would show.

use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt as _, ImageFormat, InputFocus, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::wrapper::ConnectionExt as _;

const BAR_HEIGHT: u16 = 40;

pub fn type_and_watch(window: u32, keys: usize) -> Result<Vec<f64>, Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let keycode = keycodes(&conn)?;
    let geom = conn.get_geometry(window)?.reply()?;
    let (w, h) = (geom.width, geom.height);
    focus(window)?;

    let bar = |conn: &x11rb::rust_connection::RustConnection| -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        Ok(conn.get_image(ImageFormat::Z_PIXMAP, window, 0, (h - BAR_HEIGHT) as i16, w, BAR_HEIGHT, !0)?.reply()?.data)
    };
    let press = |code: u8| -> Result<Instant, Box<dyn std::error::Error>> {
        let at = Instant::now();
        conn.xtest_fake_input(KEY_PRESS_EVENT, code, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        conn.xtest_fake_input(KEY_RELEASE_EVENT, code, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        conn.flush()?;
        Ok(at)
    };
    let wait_change = |before: &[u8], sent: Instant| -> Result<Option<f64>, Box<dyn std::error::Error>> {
        while sent.elapsed() < Duration::from_secs(2) {
            if bar(&conn)? != before {
                return Ok(Some(sent.elapsed().as_secs_f64() * 1000.0));
            }
        }
        Ok(None)
    };

    let mut samples = Vec::with_capacity(keys);
    for i in 0..keys {
        // Enter every 40 letters clears the input so the echo stays on screen; not measured.
        if i > 0 && i % 40 == 0 {
            let before = bar(&conn)?;
            let sent = press(keycode[26])?;
            wait_change(&before, sent)?;
            std::thread::sleep(Duration::from_millis(50));
        }
        let before = bar(&conn)?;
        let sent = press(keycode[i % 26])?;
        match wait_change(&before, sent)? {
            Some(ms) => samples.push(ms),
            None => return Err(format!("key {i}: no echo within 2 s").into()),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(samples)
}

/// Gives the window keyboard focus, as a window manager would. Without a WM on Xvfb nothing else does,
/// and gpui throttles unfocused windows to 30 fps.
pub fn focus(window: u32) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, _) = x11rb::connect(None)?;
    let geom = conn.get_geometry(window)?.reply()?;
    conn.set_input_focus(InputFocus::POINTER_ROOT, window, x11rb::CURRENT_TIME)?;
    conn.warp_pointer(x11rb::NONE, window, 0, 0, 0, 0, (geom.width / 2) as i16, (geom.height / 2) as i16)?;
    conn.sync()?;
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

/// Keycodes for `a`..`z`, then Return.
fn keycodes(conn: &impl Connection) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let map = conn.get_keyboard_mapping(min, max - min + 1)?.reply()?;
    let per = map.keysyms_per_keycode as usize;
    let find = |sym: u32| -> Result<u8, String> {
        map.keysyms
            .chunks(per)
            .position(|syms| syms.first() == Some(&sym))
            .map(|ix| min + ix as u8)
            .ok_or_else(|| format!("no keycode for keysym {sym:#x}"))
    };
    let mut codes = (0..26).map(|i| find(0x61 + i)).collect::<Result<Vec<_>, _>>()?;
    codes.push(find(0xff0d)?);
    Ok(codes)
}

/// Writes the root window as a binary PPM (for checking what Xvfb shows; no image crate needed).
pub fn screenshot(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let s = &conn.setup().roots[screen];
    let img = conn.get_image(ImageFormat::Z_PIXMAP, s.root, 0, 0, s.width_in_pixels, s.height_in_pixels, !0)?.reply()?;
    let mut out = format!("P6\n{} {}\n255\n", s.width_in_pixels, s.height_in_pixels).into_bytes();
    for px in img.data.chunks(4) {
        out.extend_from_slice(&[px[2], px[1], px[0]]);
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Left-clicks at root coordinates (for driving the app in lab checks).
pub fn click(x: i16, y: i16) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    conn.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, x11rb::CURRENT_TIME, root, x, y, 0)?;
    conn.sync()?;
    std::thread::sleep(Duration::from_millis(50));
    conn.xtest_fake_input(BUTTON_PRESS_EVENT, 1, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
    conn.xtest_fake_input(BUTTON_RELEASE_EVENT, 1, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
    conn.sync()?;
    Ok(())
}

/// Types printable ASCII, plus `\t` (Tab), `\n` (Return) and `\u{8}` (BackSpace), into the focused window (for lab checks).
pub fn type_text(text: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let (min, max) = (conn.setup().min_keycode, conn.setup().max_keycode);
    let map = conn.get_keyboard_mapping(min, max - min + 1)?.reply()?;
    let per = map.keysyms_per_keycode as usize;
    let shift = map.keysyms.chunks(per).position(|s| s.first() == Some(&0xffe1)).map(|ix| min + ix as u8).ok_or("no Shift key")?;
    for ch in text.chars() {
        let sym = match ch {
            '\t' => 0xff09,
            '\n' => 0xff0d,
            '\u{8}' => 0xff08,
            c if c.is_ascii_graphic() || c == ' ' => c as u32,
            c => return Err(format!("can't type {c:?}").into()),
        };
        // Column 0 is the unshifted symbol, column 1 the shifted one.
        let (ix, shifted) = map
            .keysyms
            .chunks(per)
            .enumerate()
            .find_map(|(ix, syms)| syms.iter().take(2).position(|&s| s == sym).map(|col| (ix, col == 1)))
            .ok_or_else(|| format!("no key for {ch:?}"))?;
        let code = min + ix as u8;
        if shifted {
            conn.xtest_fake_input(KEY_PRESS_EVENT, shift, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        }
        conn.xtest_fake_input(KEY_PRESS_EVENT, code, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        conn.xtest_fake_input(KEY_RELEASE_EVENT, code, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        if shifted {
            conn.xtest_fake_input(KEY_RELEASE_EVENT, shift, x11rb::CURRENT_TIME, root, 0, 0, 0)?;
        }
        conn.sync()?;
        std::thread::sleep(Duration::from_millis(15));
    }
    Ok(())
}
