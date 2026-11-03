//! Keys on the Mac: the X keysyms the `desktop` tool and the live view name keys with (x11::keysym), as macOS virtual
//! keycodes (Carbon's kVK_*, the ANSI layout's positions) with the Shift a US layout needs, or as a modifier's flag.
//! What no key types goes as the text a key event carries (CGEventKeyboardSetUnicodeString).

/// CGEventFlags of the modifiers.
pub const SHIFT: u64 = 0x0002_0000;
pub const CONTROL: u64 = 0x0004_0000;
pub const OPTION: u64 = 0x0008_0000;
pub const COMMAND: u64 = 0x0010_0000;

/// What one keysym is on a Mac.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// A key: its virtual keycode, and whether Shift picks the keysym there.
    Code(u16, bool),
    /// A modifier: its keycode and its flag.
    Modifier(u16, u64),
    /// A character no key of the layout types: sent as text.
    Text(char),
}

/// The ANSI layout's keys for the characters they type, unshifted then shifted.
const CHARS: [(u16, char, char); 47] = [
    (0x00, 'a', 'A'),
    (0x01, 's', 'S'),
    (0x02, 'd', 'D'),
    (0x03, 'f', 'F'),
    (0x04, 'h', 'H'),
    (0x05, 'g', 'G'),
    (0x06, 'z', 'Z'),
    (0x07, 'x', 'X'),
    (0x08, 'c', 'C'),
    (0x09, 'v', 'V'),
    (0x0b, 'b', 'B'),
    (0x0c, 'q', 'Q'),
    (0x0d, 'w', 'W'),
    (0x0e, 'e', 'E'),
    (0x0f, 'r', 'R'),
    (0x10, 'y', 'Y'),
    (0x11, 't', 'T'),
    (0x12, '1', '!'),
    (0x13, '2', '@'),
    (0x14, '3', '#'),
    (0x15, '4', '$'),
    (0x16, '6', '^'),
    (0x17, '5', '%'),
    (0x18, '=', '+'),
    (0x19, '9', '('),
    (0x1a, '7', '&'),
    (0x1b, '-', '_'),
    (0x1c, '8', '*'),
    (0x1d, '0', ')'),
    (0x1e, ']', '}'),
    (0x1f, 'o', 'O'),
    (0x20, 'u', 'U'),
    (0x21, '[', '{'),
    (0x22, 'i', 'I'),
    (0x23, 'p', 'P'),
    (0x25, 'l', 'L'),
    (0x26, 'j', 'J'),
    (0x27, '\'', '"'),
    (0x28, 'k', 'K'),
    (0x29, ';', ':'),
    (0x2a, '\\', '|'),
    (0x2b, ',', '<'),
    (0x2c, '/', '?'),
    (0x2d, 'n', 'N'),
    (0x2e, 'm', 'M'),
    (0x2f, '.', '>'),
    (0x32, '`', '~'),
];

/// The function keys' codes, F1 to F20.
const FUNCTION: [u16; 20] = [
    0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a,
    0x40, 0x4f, 0x50, 0x5a,
];

/// The key a character is typed with, and whether with Shift.
pub fn of_char(c: char) -> Option<(u16, bool)> {
    match c {
        ' ' => Some((0x31, false)),
        '\n' | '\r' => Some((0x24, false)),
        '\t' => Some((0x30, false)),
        _ => CHARS.iter().find_map(|(code, plain, shifted)| {
            if *plain == c {
                Some((*code, false))
            } else if *shifted == c {
                Some((*code, true))
            } else {
                None
            }
        }),
    }
}

/// A keysym on the Mac (x11::keysym's values). Super is Command, Alt is Option.
pub fn of_sym(sym: u32) -> Key {
    let code = |c| Key::Code(c, false);
    match sym {
        0xff0d | 0xff8d => code(0x24), // Return, KP_Enter
        0xff09 => code(0x30),          // Tab
        0xff1b => code(0x35),          // Escape
        0xff08 => code(0x33),          // BackSpace: the Mac's Delete
        0xffff => code(0x75),          // Delete: forward delete
        0xff50 => code(0x73),          // Home
        0xff57 => code(0x77),          // End
        0xff55 => code(0x74),          // Page_Up
        0xff56 => code(0x79),          // Page_Down
        0xff51 => code(0x7b),          // Left
        0xff52 => code(0x7e),          // Up
        0xff53 => code(0x7c),          // Right
        0xff54 => code(0x7d),          // Down
        0xff63 => code(0x72),          // Insert: Help
        0xffe5 => code(0x39),          // Caps_Lock
        0xffbe..=0xffd1 => code(FUNCTION[(sym - 0xffbe) as usize]),
        0xffe1 => Key::Modifier(0x38, SHIFT),
        0xffe2 => Key::Modifier(0x3c, SHIFT),
        0xffe3 => Key::Modifier(0x3b, CONTROL),
        0xffe4 => Key::Modifier(0x3e, CONTROL),
        0xffe9 => Key::Modifier(0x3a, OPTION),
        0xffea => Key::Modifier(0x3d, OPTION),
        0xffeb | 0xffe7 => Key::Modifier(0x37, COMMAND),
        0xffec | 0xffe8 => Key::Modifier(0x36, COMMAND),
        _ => {
            let c = match sym {
                0x20..=0x7e | 0xa0..=0xff => char::from_u32(sym),
                s if s & 0xff00_0000 == 0x0100_0000 => char::from_u32(s & 0x00ff_ffff),
                _ => None,
            };
            match c {
                Some(c) => match of_char(c) {
                    Some((code, shift)) => Key::Code(code, shift),
                    None => Key::Text(c),
                },
                // Keys a Mac has none of (Menu, Print): nothing to press.
                None => Key::Text('\u{0}'),
            }
        }
    }
}
