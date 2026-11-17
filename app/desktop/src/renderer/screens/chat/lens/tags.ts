// The tagged chat (a project's trial, `chatTags`): which order each message is about, and a lens on one order. Pure;
// chatRows (../model.ts) lays the rows out from it.
//
// The hub tags (`about`, a bubble's own `about`); the app only reads. A tag's words show only while two or more of the
// project's orders are open: in a one-order chat everything is about it. A closed order's messages stay as they are.
// A lens keeps one order's messages, and of a message about several orders only its bubbles.
import type { ChatAbout } from "../../../../shared/contracts";
import type { ChatItem } from "../../../src/data/chat";

export interface Tags {
  /** Two or more of the project's orders are open: the tags name them. */
  readonly named: boolean;
  /** The order a lens shows, by id: only its messages, and its name off their tags. */
  readonly lens?: string | undefined;
}

/** The order a message is about, by id: the hub's tag, or a send's own from a lens until the hub has it. */
export const aboutOf = (item: ChatItem): string | undefined => item.message?.about?.workstreamId ?? item.about;

/** A lead message about several orders: each bubble's own, by its key (bubblesOf's, the part's index). */
export const partAbout = (item: ChatItem, key: string): ChatAbout | undefined => item.message?.parts?.[Number(key)]?.about;

const partOrders = (item: ChatItem): readonly string[] =>
  (item.message?.parts ?? []).flatMap((p) => (p.about === undefined ? [] : [p.about.workstreamId]));

/** It is about `order`, wholly or in one of its bubbles. */
export const isAbout = (item: ChatItem, order: string): boolean => aboutOf(item) === order || partOrders(item).includes(order);

/** In a lens on `order`, the bubbles of a message about several orders that are its own, by key; undefined: all of them. */
export const lensParts = (item: ChatItem, order: string): readonly string[] | undefined => {
  if (aboutOf(item) !== undefined || partOrders(item).length === 0) return undefined;
  return (item.message?.parts ?? []).flatMap((p, n) => (p.about?.workstreamId === order ? [String(n)] : []));
};

/** What sets a run apart: its order, and on the lead's, whom it is for. A change starts a new run, with its own line. */
export const tagKey = (item: ChatItem): string =>
  `${aboutOf(item) ?? partOrders(item)[0] ?? ""}|${item.author === "lead" ? (item.message?.for?.personId ?? "") : ""}`;

/** The line over a run: the order's name (unless the lens is on it) and, over the lead's, whom it is for unless that's you. */
export interface Tag {
  readonly order?: ChatAbout | undefined;
  /** The first name of the person a lead message is for. */
  readonly to?: string | undefined;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

export function tagOf(
  item: ChatItem,
  tags: Tags,
  me: string | undefined,
  nameOf: (p: { personId: string; name: string }) => string,
): Tag | undefined {
  if (!tags.named) return undefined;
  const m = item.message;
  // A send from a lens isn't named until the hub has it: it is about the lens's order, whose name is off anyway. Of a
  // message about several orders, its first bubble's; in a lens only the lens's bubbles show, so none.
  const about = m?.about ?? (tags.lens === undefined ? m?.parts?.find((p) => p.about !== undefined)?.about : undefined);
  const order = about !== undefined && about.workstreamId !== tags.lens ? about : undefined;
  const whom = item.author === "lead" ? m?.for : undefined;
  const to = whom !== undefined && me !== undefined && whom.personId !== me ? firstName(nameOf(whom)) : undefined;
  return order === undefined && to === undefined
    ? undefined
    : {
        ...(order === undefined ? {} : { order }),
        ...(to === undefined ? {} : { to }),
      };
}

/** One message of the chat as shown; in a lens, of a message about several orders, the bubbles that show, by key. */
export interface Step {
  readonly item: ChatItem;
  readonly n: number;
  readonly parts?: readonly string[] | undefined;
}

/** The messages in the order they show: all of them, or in a lens only its order's. */
export function stepsOf(items: readonly ChatItem[], tags: Tags): Step[] {
  const lens = tags.lens;
  if (lens === undefined) return items.map((item, n) => ({ item, n }));
  return items.flatMap((item, n): Step[] => {
    if (!isAbout(item, lens)) return [];
    const parts = lensParts(item, lens);
    return [{ item, n, ...(parts === undefined ? {} : { parts }) }];
  });
}
