// This person's pinned chats (W232). The hub keeps them (chat_pins_get / _set), in their order, the same on each of
// their phones; this phone keeps a copy (prefs.ts pinned) so the list shows them at once on launch and offline. A pin
// or unpin shows at once and goes to the hub, one set at a time; one made offline goes when the link is back, over
// what the hub has. Another phone's change (chat.pins, which only this person's devices get) is read again, unless one
// made here since is still on its way. A hub that has never had them gets the pins this phone kept on its own, from
// before the hub kept them. A hub from before pins, or a key with no person, leaves them on this phone alone.
import type { ToolInput } from "./desktop";
import type { Typed } from "./hub/client";
import { keyOf, refOf, type Key } from "./store";

/** Where this phone keeps its copy. */
export interface PinStore {
  saved(): readonly Key[];
  save(keys: readonly Key[]): void;
}

/** The hub's two calls for them (Session's client). */
export type PinCall = <T extends "chat_pins_get" | "chat_pins_set">(tool: T, input: ToolInput<T>) => Promise<Typed<T>>;

/** A copy in memory: a session made without one (tests, a screen's own). */
export const memoryPins = (start: readonly Key[] = []): PinStore => {
  let keys = start;
  return {
    saved: () => keys,
    save: (next) => {
      keys = next;
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
  /** Whether the hub keeps them: unknown until a read or a set answers. */
  #onHub: boolean | undefined;
  /** Changed here and not yet taken by the hub. */
  #dirty = false;
  #sending = false;
  /** Changes made here: a read that started before the newest one is stale. */
  #edits = 0;

  constructor(call: PinCall, store: PinStore) {
    this.#call = call;
    this.#store = store;
  }

  /** On each live link, and when another of this person's devices changed them. */
  async read(): Promise<void> {
    if (this.#dirty) return this.#flush();
    const edits = this.#edits;
    const r = await this.#call("chat_pins_get", {});
    if (!r.ok) {
      if (refused(r.error.code)) this.#onHub = false;
      return;
    }
    this.#onHub = true;
    if (edits !== this.#edits || this.#dirty || this.#sending) return;
    if (r.output.set) {
      this.#store.save(r.output.pins.map(keyOf));
      return;
    }
    // Never set on the hub: the pins this phone kept go up, once.
    if (this.#store.saved().length === 0) return;
    this.#dirty = true;
    return this.#flush();
  }

  /** Pinned, unpinned or moved here: shown at once, then sent. */
  set(keys: readonly Key[]): Promise<void> {
    this.#edits++;
    this.#store.save(keys);
    if (this.#onHub === false) return Promise.resolve();
    this.#dirty = true;
    return this.#flush();
  }

  /** The newest pins to the hub, one set at a time; what changes meanwhile goes next. */
  async #flush(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#dirty) {
        this.#dirty = false;
        const r = await this.#call("chat_pins_set", { pins: this.#store.saved().map(refOf) });
        if (r.ok) {
          this.#onHub = true;
          continue;
        }
        // Refused: kept here alone. Else again on the next live link, over what the hub has.
        if (refused(r.error.code)) this.#onHub = false;
        else this.#dirty = true;
        return;
      }
    } finally {
      this.#sending = false;
    }
  }
}
