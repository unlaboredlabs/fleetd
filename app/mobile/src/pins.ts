// This person's pinned chats on one hub (W232). The hub keeps them (chat_pins_get / _set), in their order, the same
// on each of their phones; this phone keeps a copy per hub (prefs.ts pins) so the list shows them at once on launch
// and offline. A pin or unpin shows at once and goes to the hub, one set at a time; one the hub hasn't taken yet
// (offline, the link dropped, the app closed) stays pending for that hub, kept on disk, and goes on its next live
// link, over what the hub has. Another phone's change (chat.pins, which only this person's devices get) is read again,
// unless one made here is still pending. A change made while the hub is being asked what they are (at launch, on a
// new link), or after it couldn't say, is not sent as this phone's copy changed: it shows at once, waits for the hub's
// own list, is made again on top of that and then sent, since the list sent replaces the hub's and the copy may lack a
// chat pinned on another device. Only if the hub can't be reached does it wait as one made offline. A hub that has
// never had them claims, once, those of its own chats among the pins an older build kept before the hubs did: another
// hub's chats never go to it. A hub from before pins, or a key with no person, leaves them on this phone alone.
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
  /** Whether this phone's copy is the hub's own list: it answered a read or took a set, and isn't being asked again. */
  #fresh = false;
  /** The reads asked, and whether the newest is still on its way: only its answer counts. */
  #reads = 0;
  #reading = false;
  /** Changes made before the hub said what the pins are: made again on top of its list once it answers. */
  #waiting: Array<(keys: readonly Key[]) => readonly Key[]> = [];

  constructor(call: PinCall, store: PinStore, known: (key: Key) => boolean = () => true) {
    this.#call = call;
    this.#store = store;
    this.#known = known;
  }

  /** On each snapshot (its chats known), and when another of this person's devices changed them. */
  async read(): Promise<void> {
    if (this.#store.pending()) return this.#flush();
    // What the hub has may be newer than this copy until it answers: a change made meanwhile waits for it.
    this.#fresh = false;
    this.#reading = true;
    const no = ++this.#reads;
    const edits = this.#edits;
    const r = await this.#call("chat_pins_get", {});
    // Asked again since: that answer is the one that counts.
    if (no !== this.#reads) return;
    this.#reading = false;
    if (!r.ok) {
      const waited = this.#waited().length > 0;
      if (refused(r.error.code)) this.#onHub = false;
      // Not reached: what waited for the answer is a change made offline, for the next live link.
      else if (waited) this.#store.setPending(true);
      return;
    }
    this.#onHub = true;
    if (edits !== this.#edits || this.#store.pending() || this.#sending) return;
    this.#fresh = true;
    const waiting = this.#waited();
    if (r.output.set) {
      // The hub's own list, with what waited for it made again on top: nothing pinned on another device is left out.
      this.#store.save(waiting.reduce<readonly Key[]>((keys, change) => change(keys), r.output.pins.map(keyOf)));
      if (waiting.length === 0) return;
    } else {
      // Never set on the hub: those of its chats this phone kept, as changed here since, go up, once.
      const mine = this.#store.saved().filter(this.#known);
      if (mine.length === 0 && waiting.length === 0) return;
      this.#store.save(mine);
    }
    this.#store.setPending(true);
    return this.#flush();
  }

  /**
   * Pinned, unpinned or moved here: `how` gets the pins of this hub's chats and returns them changed. Shown at once,
   * then sent: as this phone's copy changed when that is the hub's list, else made again on the hub's own once it says.
   */
  change(how: (keys: readonly Key[]) => readonly Key[]): Promise<void> {
    const change = (keys: readonly Key[]) => how(keys.filter(this.#known));
    if (this.#onHub !== false && !this.#fresh && !this.#store.pending()) {
      this.#store.save(change(this.#store.saved()));
      this.#waiting.push(change);
      return this.#reading ? Promise.resolve() : this.read();
    }
    this.#edits++;
    this.#store.save(change(this.#store.saved()));
    if (this.#onHub === false) return Promise.resolve();
    this.#store.setPending(true);
    return this.#flush();
  }

  /** The changes that waited for the hub's list, taken. */
  #waited(): ReadonlyArray<(keys: readonly Key[]) => readonly Key[]> {
    const waiting = this.#waiting;
    this.#waiting = [];
    return waiting;
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
          this.#fresh = true;
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
