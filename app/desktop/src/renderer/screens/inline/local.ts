// What the person just did to an inline item, kept outside the component by hub and requestId: the chat list is
// virtual and drops rows scrolled far away, and a confirm waiting for its second key, an opened fold or a failed
// answer must still be there when the row comes back. An answer on its way lands here even if its row is gone.
// A secret's typed value is here too, so a row that scrolls away keeps it until it is saved: only in this window's
// memory, never written anywhere, and dropped once saved or no longer asked for.
import { useSyncExternalStore } from "react";
import type { Action, Failure } from "./request";

export type Failed = { readonly action: Action; readonly failure: Failure };

export interface Local {
  /** The answer the hub accepted, shown until a requests read that went out after it lands (see `after`). */
  readonly sent: Readonly<Record<string, unknown>> | null;
  /**
   * The data layer's read mark (readsStarted) when the person's last act landed: an answer the hub accepted, a
   * failed one, or an Approve waiting for its second key. A requests read numbered above it is the hub's truth.
   */
  readonly after: number | null;
  readonly busy: boolean;
  readonly failed: Failed | null;
  /** A command that can't be undone, waiting for "Yes, run it". */
  readonly confirming: boolean;
  /** An answered item, opened back up to its card. */
  readonly open: boolean;
  /** Focus was in the card when the answer went out, so the folded line or Retry takes it back. */
  readonly refocus: boolean;
  /** A secret's value, typed and not yet saved. */
  readonly draft: string;
}

const EMPTY: Local = { sent: null, after: null, busy: false, failed: null, confirming: false, open: false, refocus: false, draft: "" };
const states = new Map<string, Local>();
const listeners = new Map<string, Set<() => void>>();

export const patchLocal = (key: string, patch: Partial<Local>): void => {
  states.set(key, { ...(states.get(key) ?? EMPTY), ...patch });
  for (const l of listeners.get(key) ?? []) l();
};

export const useLocal = (key: string): Local =>
  useSyncExternalStore(
    (onChange) => {
      const set = listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    () => states.get(key) ?? EMPTY,
  );
