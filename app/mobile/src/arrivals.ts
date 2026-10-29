// Which bubbles enter with motion, as the desktop app decides it (screens/chat/model.ts arrivalsOf): only what arrives
// while the chat is open and live (a reply, your send, a streamed reply's text once written), each a step after the
// others that came with it. What the chat opened with, older pages, and what a reconnect brings show still. Pure, so
// it is unit-tested.
import type { ChatItem } from "./desktop";

/** How long after it came in a bubble still enters as it mounts: its motion and the stagger, with room. */
export const ENTER_MS = 1000;

export interface Arrival {
  /** When it came in (epoch ms). */
  readonly at: number;
  readonly step: number;
}

export interface Arrivals {
  readonly live: boolean;
  /** Every message shown so far, by row key, and by `key~` while it streamed. */
  readonly known: ReadonlySet<string>;
  /** The newest hub seq shown so far: an unknown message older than it is from an older page. */
  readonly newest: number;
  /** By row key. */
  readonly entering: ReadonlyMap<string, Arrival>;
}

/** A row's key, the same from your send to the hub's echo of it: it enters once. */
export const rowKeyOf = (item: Pick<ChatItem, "id" | "clientRequestId">): string => item.clientRequestId ?? item.id;

/** Streaming is another shape from what it ends as: the typing dots, then its bubbles. */
const phaseKey = (i: ChatItem): string => (i.state === "streaming" ? `${rowKeyOf(i)}~` : rowKeyOf(i));
const enters = (i: ChatItem): boolean => i.kind !== "event" && i.message?.history === undefined;

export const arrivalsOf = (prev: Arrivals | undefined, items: readonly ChatItem[], live: boolean, nowMs: number): Arrivals => {
  const known = new Set(prev?.known);
  const entering = new Map([...(prev?.entering ?? [])].filter(([, a]) => nowMs - a.at < ENTER_MS));
  // Only while it was live before and still is: the first view, a held one and the page after it come in still.
  const still = prev === undefined || !prev.live || !live;
  let newest = prev?.newest ?? -Infinity;
  let step = 0;
  for (const i of items) {
    const key = phaseKey(i);
    const seq = i.message?.seq;
    const newer = seq === undefined || seq > (prev?.newest ?? -Infinity) || known.has(`${rowKeyOf(i)}~`);
    if (!still && !known.has(key) && newer && enters(i)) entering.set(rowKeyOf(i), { at: nowMs, step: step++ });
    known.add(key);
    if (seq !== undefined && seq > newest) newest = seq;
  }
  return { live, known, newest, entering };
};
