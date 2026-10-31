// This person's pinned chats on one hub (W232). The hub keeps them (chat_pins_get / _set), in their order, the same
// on each of their phones; this phone keeps a copy per hub (prefs.ts pins) so the list shows them at once on launch
// and offline. A pin or unpin shows at once and goes to the hub, one set at a time; one the hub hasn't taken yet
// (offline, the link dropped, the app closed) stays pending for that hub, kept on disk, and goes on its next live
// link, over what the hub has. Another phone's change (chat.pins, which only this person's devices get) is read again,
// unless one made here is still pending. A hub that has never had them claims, once, those of its own chats among the
// pins an older build kept before the hubs did: another hub's chats never go to it. A hub from before pins, or a key
// with no person, leaves them on this phone alone.
import type { ToolInput } from "./desktop";
import type { Typed } from "./hub/client";
import { keyOf, refOf, type Key } from "./store";

/** Where this phone keeps its copy of one hub's pins, and whether a change to them waits to be sent. */
export interface PinStore {
  saved(): readonly Key[];
  save(keys: readonly Key[]): void;
  pending(): boolean;
  setPending(on: boolean): void;
}

/** The hub's two calls for them (Session's client). */
export type PinCall = <T extends "chat_pins_get" | "chat_pins_set">(tool: T, input: ToolInput<T>) => Promise<Typed<T>>;

/** A copy in memory: a session made without one (tests, a screen's own). */
export const memoryPins = (start: readonly Key[] = []): PinStore => {
  let keys = start;
  let pending = false;
  return {
    saved: () => keys,
    save: (next) => {
      keys = next;
    },
    pending: () => pending,
    setPending: (on) => {
      pending = on;
    },
  };
};

/**
 * The hub won't keep them: a hub from before pins has no such tool, and a key with no person may not set any. Anything
 * else (offline, the link dropped mid-call, no answer in time, a failure on the hub) leaves the change to send again.
 */
const refused = (code: string): boolean => code === "not_found" || code === "forbidden";

export class Pins {
  readonly #call: PinCall;
  readonly #store: PinStore;
  /** Whether a chat is this hub's: only those go up from the pins an older build kept. */
  readonly #known: (key: Key) => boolean;
  /** Whether the hub keeps them: unknown until a read or a set answers. */
  #onHub: boolean | undefined;
  #sending = false;
  /** Changes made here: a read, or a set's answer, from before the newest one is stale. */
  #edits = 0;

  constructor(call: PinCall, store: PinStore, known: (key: Key) => boolean = () => true) {
    this.#call = call;
    this.#store = store;
    this.#known = known;
  }

  /** On each snapshot (its chats known), and when another of this person's devices changed them. */
  async read(): Promise<void> {
    if (this.#store.pending()) return this.#flush();
    const edits = this.#edits;
    const r = await this.#call("chat_pins_get", {});
    if (!r.ok) {
      if (refused(r.error.code)) this.#onHub = false;
      return;
    }
    this.#onHub = true;
    if (edits !== this.#edits || this.#store.pending() || this.#sending) return;
    if (r.output.set) {
      this.#store.save(r.output.pins.map(keyOf));
      return;
    }
    // Never set on the hub: those of its chats this phone kept go up, once.
    const mine = this.#store.saved().filter(this.#known);
    if (mine.length === 0) return;
    this.#store.save(mine);
    this.#store.setPending(true);
    return this.#flush();
  }

  /** Pinned, unpinned or moved here: shown at once, then sent. */
  set(keys: readonly Key[]): Promise<void> {
    this.#edits++;
    this.#store.save(keys);
    if (this.#onHub === false) return Promise.resolve();
    this.#store.setPending(true);
    return this.#flush();
  }

  /** The newest pins to the hub, one set at a time; what changes meanwhile goes next. */
  async #flush(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#store.pending()) {
        const edits = this.#edits;
        const r = await this.#call("chat_pins_set", { pins: this.#store.saved().map(refOf) });
        if (r.ok) {
          this.#onHub = true;
          // Changed again while this one went: still pending, and the loop sends the newest.
          if (edits === this.#edits) this.#store.setPending(false);
          continue;
        }
        // Refused: kept here alone. Else still pending, for the next live link.
        if (refused(r.error.code)) {
          this.#onHub = false;
          this.#store.setPending(false);
        }
        return;
      }
    } finally {
      this.#sending = false;
    }
  }
}
