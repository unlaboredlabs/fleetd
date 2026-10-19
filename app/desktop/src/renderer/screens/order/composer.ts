// The steer composer's two modes (steering-spec §1, §7): Enter adds to the agent's queue (lands at its next step,
// never cuts a running tool), ⌘Enter interrupts its current step and redirects it now. Shift+Enter is a newline.
// The key resolution follows T3 Code's composer dispatch (packages/client-runtime/src/state/composerDispatch.ts).

import type { SteerMode } from "../../../shared/contracts";

export type Platform = "darwin" | "linux" | "win32" | "other";

export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** An IME is composing: Enter picks a candidate, it never sends. */
  readonly isComposing: boolean;
}

export const modKey = (e: Pick<KeyLike, "metaKey" | "ctrlKey">, platform: Platform): boolean =>
  platform === "darwin" ? e.metaKey : e.ctrlKey;

/** The mode a key sends with, or undefined when the key is the textarea's own (a newline, IME, anything else). */
export function sendModeFor(e: KeyLike, platform: Platform): SteerMode | undefined {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey) return undefined;
  return modKey(e, platform) ? "now" : "queue";
}

export const modLabel = (platform: Platform): string => (platform === "darwin" ? "⌘" : "Ctrl+");

export interface SteerWords {
  /** "the lead", "T88". */
  readonly name: string;
  /** "W41" for the lead, the task id for a task. */
  readonly ref: string;
}

const possessive = (name: string): string => `${name}’s`;

/** The primary button: "Add to queue", or "Interrupt" while the modifier is held. */
export const primaryLabel = (modHeld: boolean): string => (modHeld ? "Interrupt" : "Add to queue");

export const secondaryLabel = "Interrupt and redirect";

export function keyHint(who: SteerWords, platform: Platform): string {
  return `Enter add to ${possessive(who.name)} queue · ${modLabel(platform)}Enter interrupt and redirect now`;
}

export function placeholder(who: SteerWords, platform: Platform): string {
  return `Steer ${who.ref}: Enter lands at ${possessive(who.name)} next step; ${modLabel(platform)}Enter stops its current step.`;
}
