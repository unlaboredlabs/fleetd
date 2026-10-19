// The app-wide keymap: one keydown listener that turns a SHORTCUTS chord into its registered command. It runs in
// the capture phase, so a focused field or a Radix layer can't swallow ⌘K, and it only claims a key that has an
// enabled command; anything else reaches the page untouched.

import { shortcutFor, type KeyInput, type Platform, type ShortcutId } from "../../../shared/shortcuts";
import { commandFor } from "./registry";

/** Held down, these step through orders; every other shortcut fires once per press. */
const REPEATS: ReadonlySet<ShortcutId> = new Set(["order.previous", "order.next"]);

/** The command id a key press should run, or undefined to leave the key alone. */
export const dispatchable = (event: KeyInput & { readonly repeat: boolean; readonly isComposing: boolean }, platform: Platform): ShortcutId | undefined => {
  if (event.isComposing) return undefined;
  const id = shortcutFor(event, platform);
  if (id === undefined || (event.repeat && !REPEATS.has(id))) return undefined;
  return commandFor(id) ? id : undefined;
};

export const installKeymap = (platform: Platform, before?: (id: ShortcutId) => void): (() => void) => {
  const onKeyDown = (event: KeyboardEvent) => {
    const id = dispatchable(event, platform);
    if (id === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    before?.(id);
    commandFor(id)?.run();
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
};

/**
 * For a focused picker (a question card, an option list): plain 1–9 pick, Enter takes the recommendation, N says
 * No. Undefined while typing in a field or with a modifier held, so the field keeps its keys.
 */
export type PickerKey = { readonly kind: "pick"; readonly n: number } | { readonly kind: "accept" } | { readonly kind: "no" };

export const pickerKey = (event: KeyInput & { readonly target?: EventTarget | null }): PickerKey | undefined => {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target;
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null)) {
    return undefined;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/u.exec(event.code)?.[1];
  if (digit !== undefined && !event.shiftKey) return { kind: "pick", n: Number(digit) };
  if (event.key === "Enter" && !event.shiftKey) return { kind: "accept" };
  if (event.key.toLowerCase() === "n" && !event.shiftKey) return { kind: "no" };
  return undefined;
};
