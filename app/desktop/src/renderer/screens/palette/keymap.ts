// The app-wide keymap: one keydown listener that turns a SHORTCUTS chord into its registered command. It runs in
// the capture phase, so a focused field or a Radix layer can't swallow ⌘K, and it only claims a key that has an
// enabled command; anything else reaches the page untouched.

import { shortcutFor, type KeyInput, type Platform, type ShortcutId } from "../../../shared/shortcuts";
import { commandFor } from "./registry";

/** Held down, these step through projects; every other shortcut fires once per press. */
const REPEATS: ReadonlySet<ShortcutId> = new Set(["project.previous", "project.next"]);

/** Ctrl+N/P step the palette's selection. Off macOS Ctrl is Mod, so while it is open they are its keys, not ⌘N. */
const paletteKey = (event: KeyInput, platform: Platform): boolean =>
  platform !== "darwin" && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.code === "KeyN" || event.code === "KeyP");

/**
 * The command id a key press should run, or undefined to leave the key alone. While the palette is open only the
 * keys it uses itself (Ctrl+N/P, ⌘K) are held back; every other shortcut runs (the host closes the palette first).
 */
export const dispatchable = (
  event: KeyInput & { readonly repeat: boolean; readonly isComposing: boolean },
  platform: Platform,
  paletteOpen = false,
): ShortcutId | undefined => {
  if (event.isComposing) return undefined;
  const id = shortcutFor(event, platform);
  if (id === undefined || (event.repeat && !REPEATS.has(id))) return undefined;
  // ⌘K inside the palette lists the selected item's actions; the palette decides, and closes when there are none.
  if (paletteOpen && (paletteKey(event, platform) || id === "palette.toggle")) return undefined;
  return commandFor(id) ? id : undefined;
};

export const installKeymap = (platform: Platform, paletteOpen: () => boolean, before?: (id: ShortcutId) => void): (() => void) => {
  const onKeyDown = (event: KeyboardEvent) => {
    const id = dispatchable(event, platform, paletteOpen());
    if (id === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    before?.(id);
    commandFor(id)?.run();
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
};
