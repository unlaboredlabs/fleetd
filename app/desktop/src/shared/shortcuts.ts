// THE shortcut map. The native menu (main) shows these accelerators and the renderer's keymap runs them, so a key
// is defined once. Each id is also the palette command id that the key runs (renderer/src/palette/registry.ts).
//
// `Mod` is ⌘ on macOS and Ctrl elsewhere. A key is a letter, a digit, or one of the punctuation keys in CODES.

export type Platform = "darwin" | "linux" | "win32" | "other";

export type ShortcutSection = "General" | "Go to" | "Orders" | "Board";

export interface Shortcut {
  readonly keys: string;
  /** The command's name, as the menu item and the shortcuts sheet show it. */
  readonly title: string;
  readonly section: ShortcutSection;
}

const jump = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`order.open.${n}`, { keys: `Mod+${n}`, title: `Open order ${n} in the sidebar`, section: "Orders" }]),
) as Record<`order.open.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`, Shortcut>;

export const SHORTCUTS = {
  "palette.toggle": { keys: "Mod+K", title: "Command Palette", section: "General" },
  "shortcuts.show": { keys: "Mod+/", title: "Keyboard Shortcuts", section: "General" },
  "order.new": { keys: "Mod+N", title: "New Order", section: "General" },
  "composer.focus": { keys: "Mod+L", title: "Focus Composer", section: "General" },
  "sidebar.toggle": { keys: "Mod+B", title: "Toggle Sidebar", section: "General" },
  "board.open": { keys: "Mod+0", title: "Board", section: "Go to" },
  "inbox.toggle": { keys: "Mod+I", title: "Inbox", section: "Go to" },
  "status.toggle": { keys: "Mod+.", title: "Status", section: "Go to" },
  "settings.open": { keys: "Mod+,", title: "Settings…", section: "Go to" },
  "order.previous": { keys: "Mod+[", title: "Previous Order", section: "Orders" },
  "order.next": { keys: "Mod+]", title: "Next Order", section: "Orders" },
  "order.stop": { keys: "Mod+Shift+.", title: "Stop Order…", section: "Orders" },
  ...jump,
  "board.toggleGrouping": { keys: "Mod+Shift+G", title: "Group by Project or Status", section: "Board" },
  "composer.pickProject": { keys: "Mod+Shift+P", title: "Pick the Order's Project", section: "Board" },
  "composer.pickType": { keys: "Mod+Shift+T", title: "Pick the Order's Type", section: "Board" },
  "composer.attach": { keys: "Mod+Shift+A", title: "Attach a File to the Order", section: "Board" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const isShortcutId = (id: string): id is ShortcutId => Object.hasOwn(SHORTCUTS, id);

/** Keys a focused component handles itself. They are listed so the sheet shows them; nothing dispatches them globally. */
export const LOCAL_KEYS: readonly { readonly where: string; readonly keys: readonly string[]; readonly title: string }[] = [
  { where: "Command palette", keys: ["↑", "↓"], title: "Move the selection" },
  { where: "Command palette", keys: ["Enter"], title: "Run it" },
  { where: "Anywhere", keys: ["Esc"], title: "Close the menu, panel or sheet" },
];

/** Punctuation and digits match on the physical key, because Shift changes their character ("." becomes ">"). */
const CODES: Readonly<Record<string, string>> = {
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  "\\": "Backslash",
};

export interface Chord {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Lowercase letter, digit or punctuation character. */
  readonly key: string;
}

export const parseChord = (keys: string): Chord => {
  const parts = keys.split("+");
  // "Mod++" would be a literal plus; none of ours use it.
  const key = parts.pop() ?? "";
  if (!/^[a-z0-9]$/iu.test(key) && CODES[key] === undefined) throw new Error(`unsupported key in shortcut "${keys}"`);
  return { mod: parts.includes("Mod"), shift: parts.includes("Shift"), alt: parts.includes("Alt"), key: key.toLowerCase() };
};

/** The fields of a KeyboardEvent the matcher reads, so it is testable without a DOM. */
export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export const chordMatches = (chord: Chord, event: KeyInput, platform: Platform): boolean => {
  const mac = platform === "darwin";
  const mod = mac ? event.metaKey : event.ctrlKey;
  // The other platform modifier must be up, or Ctrl+⌘+K on a Mac would also count.
  const other = mac ? event.ctrlKey : event.metaKey;
  if (mod !== chord.mod || other || event.shiftKey !== chord.shift || event.altKey !== chord.alt) return false;
  const code = CODES[chord.key];
  if (code !== undefined) return event.code === code;
  if (/^[0-9]$/u.test(chord.key)) return event.code === `Digit${chord.key}` || event.code === `Numpad${chord.key}`;
  // Letters follow the layout, as the menu's key equivalents do; a layout without Latin letters (Cyrillic, Greek)
  // falls back to the physical key, as macOS does for ⌘ shortcuts.
  if (/^[a-z]$/iu.test(event.key)) return event.key.toLowerCase() === chord.key;
  return event.code === `Key${chord.key.toUpperCase()}`;
};

const CHORDS = new Map(Object.entries(SHORTCUTS).map(([id, s]) => [id as ShortcutId, parseChord(s.keys)]));

/** The shortcut this key press is, if any. */
export const shortcutFor = (event: KeyInput, platform: Platform): ShortcutId | undefined => {
  for (const [id, chord] of CHORDS) if (chordMatches(chord, event, platform)) return id;
  return undefined;
};

/** For Electron's MenuItem `accelerator`. */
export const accelerator = (id: ShortcutId): string => SHORTCUTS[id].keys.replace("Mod", "CmdOrCtrl");

const MAC_SYMBOLS: Readonly<Record<string, string>> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };

/** As people read it: "⇧⌘." on macOS (Apple's modifier order), "Ctrl+Shift+." elsewhere. */
export const displayKeys = (keys: string, platform: Platform): string => {
  const parts = keys.split("+");
  const key = (parts.pop() ?? "").toUpperCase();
  if (platform === "darwin") {
    const order = ["Alt", "Shift", "Mod"].filter((m) => parts.includes(m));
    return order.map((m) => MAC_SYMBOLS[m]).join("") + key;
  }
  return [...parts.map((m) => (m === "Mod" ? "Ctrl" : m)), key].join("+");
};

export const display = (id: ShortcutId, platform: Platform): string => displayKeys(SHORTCUTS[id].keys, platform);
