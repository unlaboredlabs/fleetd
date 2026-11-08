//! What a desktop session reads and drives, whichever screen it is: a Linux display over the node's own X11
//! connection (x11.rs), or the agents' Mac's own screen through ScreenCaptureKit and CGEvent (mac/). The session's
//! recording, live view, takeover and the agent's `desktop` actions sit on this alone.
use std::path::Path;

use super::display::Launched;

/// One read of the screen: its pixels as the screen gives them, at its size then.
pub struct Raw {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// One grab of the screen, as a JPEG.
pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// JPEG quality of a desktop's frames (the live view's, the video's and the agent's screenshots), for brightness.
const QUALITY: u8 = 70;
/// Colour keeps every pixel (4:4:4: halved, as JPEG's usual 4:2:0, red or blue text on a dark terminal goes dim and
/// soft), at a coarser quality that pays for it.
const CHROMA_QUALITY: u32 = 40;
/// JPEG's sample table for colour (ITU-T T.81 Annex K), which a quality scales.
const CHROMA: [u16; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/// A screen's pixels (32 bits each, BGRA in memory) as a JPEG.
pub fn jpeg(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    // As libjpeg (and the encoder, for its own tables) scales a table to a quality.
    let scale = match CHROMA_QUALITY {
        q if q < 50 => 5000 / q,
        q => 200 - 2 * q,
    };
    let chroma = CHROMA.map(|v| ((u32::from(v) * scale + 50) / 100).clamp(1, 255) as u16);
    let mut out = Vec::with_capacity(bgra.len() / 10);
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, QUALITY);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    encoder.set_quantization_tables(
        jpeg_encoder::QuantizationTableType::Default,
        jpeg_encoder::QuantizationTableType::Custom(Box::new(chroma)),
    );
    encoder.set_optimized_huffman_tables(true);
    encoder
        .encode(
            bgra,
            u16::try_from(width).map_err(|_| "the screen is too wide to encode")?,
            u16::try_from(height).map_err(|_| "the screen is too tall to encode")?,
            jpeg_encoder::ColorType::Bgra,
        )
        .map_err(|e| format!("cannot encode the screen: {e}"))?;
    Ok(out)
}

/// A screen: its pixels, and input as a person or an agent gives it. Coordinates are the screen's own pixels, as its
/// frames show them. Every call blocks.
pub trait Screen: Send + Sync {
    /// Its size now.
    fn size(&self) -> (u32, u32);
    /// Whether it may have changed since the last call: always, where the screen can't say.
    fn changed(&self) -> bool;
    fn grab_raw(&self) -> Result<Raw, String>;
    fn encode(&self, raw: &Raw) -> Result<Vec<u8>, String>;
    /// The whole screen, as a JPEG.
    fn grab(&self) -> Result<Shot, String> {
        let raw = self.grab_raw()?;
        Ok(Shot {
            jpeg: self.encode(&raw)?,
            width: raw.width,
            height: raw.height,
        })
    }
    /// Waits until everything sent so far is done.
    fn sync(&self) -> Result<(), String>;
    fn move_to(&self, x: i64, y: i64) -> Result<(), String>;
    /// Presses or releases a mouse button (1 left, 2 middle, 3 right) where the pointer is.
    fn button(&self, button: u8, down: bool) -> Result<(), String>;
    fn click(&self, x: i64, y: i64, button: u8, count: u8) -> Result<(), String>;
    fn drag(&self, from: (i64, i64), to: (i64, i64)) -> Result<(), String>;
    /// Wheel clicks at a point: `dy` > 0 scrolls down, `dx` > 0 right.
    fn scroll(&self, x: i64, y: i64, dx: i64, dy: i64) -> Result<(), String>;
    fn pointer(&self) -> Result<(i64, i64), String>;
    /// Presses or releases one key by its X keysym (x11::keysym names them); Shift goes with it where the keyboard
    /// needs it, when `shift` allows.
    fn key_sym(&self, sym: u32, down: bool, shift: bool) -> Result<(), String>;
    /// A chord as xdotool names it (`ctrl+shift+t`): every key pressed in order, then released in reverse.
    fn chord(&self, chord: &str) -> Result<(), String>;
    fn type_text(&self, text: &str) -> Result<(), String>;
}

/// What a session was lent to put its screen on: a display of its own, thrown away when this drops, or the Mac's
/// lease, given back when this drops.
pub trait Lent: Send + Sync {
    /// Starts an app on the screen with `sh -c`, in `cwd` where the screen's apps can see it, and looks at it a moment
    /// later.
    fn launch(&self, command: &str, cwd: &Path) -> Result<Launched, String>;
    /// One agent-desktop command (its arguments, the command first), and what it printed.
    fn agent_desktop(&self, args: &str) -> Result<String, String> {
        let _ = args;
        Err("agent_desktop drives the agents' Mac's screen (session_start kind mac); on a Linux desktop use the \
             other actions"
            .into())
    }
}
