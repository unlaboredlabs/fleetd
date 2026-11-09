// Keys on the Mac (crates/fleetd/src/node/desktop/mac/keys.rs): the X keysyms the `desktop` tool and the live view name
// keys with (x11.ts `keysym`), as macOS virtual keycodes (Carbon's kVK_*, the ANSI layout's positions) with the Shift a
// US layout needs, or as a modifier's flag. What no key types goes as the text a key event carries.

/** CGEventFlags of the modifiers. */
export const SHIFT = 0x0002_0000;
export const CONTROL = 0x0004_0000;
export const OPTION = 0x0008_0000;
export const COMMAND = 0x0010_0000;

/** What one keysym is on a Mac: a key (its virtual keycode, and whether Shift picks the keysym there), a modifier (its
 * keycode and flag), or a character no key of the layout types, sent as text ("" for a key a Mac has none of). */
export type Key = { code: number; shift: boolean } | { modifier: number; flag: number } | { text: string };

/** The ANSI layout's keys for the characters they type, unshifted then shifted. */
const CHARS: [number, string, string][] = [
  [0x00, "a", "A"], [0x01, "s", "S"], [0x02, "d", "D"], [0x03, "f", "F"], [0x04, "h", "H"], [0x05, "g", "G"],
  [0x06, "z", "Z"], [0x07, "x", "X"], [0x08, "c", "C"], [0x09, "v", "V"], [0x0b, "b", "B"], [0x0c, "q", "Q"],
  [0x0d, "w", "W"], [0x0e, "e", "E"], [0x0f, "r", "R"], [0x10, "y", "Y"], [0x11, "t", "T"], [0x12, "1", "!"],
  [0x13, "2", "@"], [0x14, "3", "#"], [0x15, "4", "$"], [0x16, "6", "^"], [0x17, "5", "%"], [0x18, "=", "+"],
  [0x19, "9", "("], [0x1a, "7", "&"], [0x1b, "-", "_"], [0x1c, "8", "*"], [0x1d, "0", ")"], [0x1e, "]", "}"],
  [0x1f, "o", "O"], [0x20, "u", "U"], [0x21, "[", "{"], [0x22, "i", "I"], [0x23, "p", "P"], [0x25, "l", "L"],
  [0x26, "j", "J"], [0x27, "'", '"'], [0x28, "k", "K"], [0x29, ";", ":"], [0x2a, "\\", "|"], [0x2b, ",", "<"],
  [0x2c, "/", "?"], [0x2d, "n", "N"], [0x2e, "m", "M"], [0x2f, ".", ">"], [0x32, "`", "~"],
];

/** The function keys' codes, F1 to F20. */
const FUNCTION = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a];

/** The key a character is typed with, and whether with Shift. */
export function ofChar(c: string): [number, boolean] | undefined {
  if (c === " ") return [0x31, false];
  if (c === "\n" || c === "\r") return [0x24, false];
  if (c === "\t") return [0x30, false];
  for (const [code, plain, shifted] of CHARS) {
    if (plain === c) return [code, false];
    if (shifted === c) return [code, true];
  }
  return undefined;
}

const NAMED: Record<number, number> = {
  0xff0d: 0x24, 0xff8d: 0x24, // Return, KP_Enter
  0xff09: 0x30, // Tab
  0xff1b: 0x35, // Escape
  0xff08: 0x33, // BackSpace: the Mac's Delete
  0xffff: 0x75, // Delete: forward delete
  0xff50: 0x73, 0xff57: 0x77, 0xff55: 0x74, 0xff56: 0x79, // Home, End, Page_Up, Page_Down
  0xff51: 0x7b, 0xff52: 0x7e, 0xff53: 0x7c, 0xff54: 0x7d, // Left, Up, Right, Down
  0xff63: 0x72, // Insert: Help
  0xffe5: 0x39, // Caps_Lock
};

const MODIFIERS: Record<number, [number, number]> = {
  0xffe1: [0x38, SHIFT], 0xffe2: [0x3c, SHIFT],
  0xffe3: [0x3b, CONTROL], 0xffe4: [0x3e, CONTROL],
  0xffe9: [0x3a, OPTION], 0xffea: [0x3d, OPTION],
  0xffeb: [0x37, COMMAND], 0xffe7: [0x37, COMMAND],
  0xffec: [0x36, COMMAND], 0xffe8: [0x36, COMMAND],
};

/** A keysym on the Mac (x11.ts `keysym`'s values). Super is Command, Alt is Option. */
export function ofSym(sym: number): Key {
  if (NAMED[sym] !== undefined) return { code: NAMED[sym], shift: false };
  if (sym >= 0xffbe && sym <= 0xffd1) return { code: FUNCTION[sym - 0xffbe]!, shift: false };
  const mod = MODIFIERS[sym];
  if (mod) return { modifier: mod[0], flag: mod[1] };
  const c =
    (sym >= 0x20 && sym <= 0x7e) || (sym >= 0xa0 && sym <= 0xff)
      ? String.fromCodePoint(sym)
      : (sym & 0xff00_0000) === 0x0100_0000
        ? String.fromCodePoint(sym & 0x00ff_ffff)
        : undefined;
  // Keys a Mac has none of (Menu, Print): nothing to press.
  if (c === undefined) return { text: "" };
  const key = ofChar(c);
  return key ? { code: key[0], shift: key[1] } : { text: c };
}
