// The tagged chat (a project's trial, `chatTags`): which order each message is about, the finished orders folded into
// their landing line, and a lens on one order. Pure; chatRows (../model.ts) lays the rows out from it.
//
// The hub tags (`about`, a bubble's own `about`, `fold`); the app only reads. A tag's words show only while two or
// more of the project's orders are open: in a one-order chat everything is about it. A fold hides a closed order's
// messages behind one line where its landing was said, except an approval or secret still open and your own message
// the lead hasn't answered. A lens keeps one order's messages, and of a message about several orders only its bubbles.
import type { ChatAbout, ChatFold } from "../../../../shared/contracts";
import type { ChatItem } from "../../../src/data/chat";

export interface Tags {
  /** Two or more of the project's orders are open: the tags name them. */
  readonly named: boolean;
  /** The order a lens shows, by id: only its messages, and its name off their tags. */
  readonly lens?: string | undefined;
  /** The folds opened, by order id. */
  readonly opened?: ReadonlySet<string> | undefined;
  /** The approvals and secrets still open, by message id: they never fold. */
  readonly openItems?: ReadonlySet<string> | undefined;
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

/** One step of the chat as shown: a message (`folded`: under an opened fold's line), or a fold's line. */
export type Step =
  | {
      readonly kind: "item";
      readonly item: ChatItem;
      readonly n: number;
      readonly folded?: boolean;
      readonly parts?: readonly string[] | undefined;
    }
  /** `at`: when the message it sits at was written. */
  | {
      readonly kind: "fold";
      readonly fold: ChatFold;
      readonly open: boolean;
      readonly at: string;
    };

/**
 * The messages in the order they show, with the folds' lines. A fold's line goes where its message is; opened, the
 * order's messages follow it, oldest first. In a lens nothing folds, and only the lens's order shows.
 */
export function stepsOf(items: readonly ChatItem[], tags: Tags, isMine: (item: ChatItem) => boolean): Step[] {
  const lens = tags.lens;
  if (lens !== undefined) {
    return items.flatMap((item, n): Step[] => {
      if (!isAbout(item, lens)) return [];
      const parts = lensParts(item, lens);
      return [{ kind: "item", item, n, ...(parts === undefined ? {} : { parts }) }];
    });
  }
  const folds = new Map<string, ChatFold>();
  for (const item of items) {
    const f = item.message?.fold;
    if (f !== undefined) folds.set(f.workstreamId, f);
  }
  if (folds.size === 0) return items.map((item, n) => ({ kind: "item", item, n }));
  const lastLead = items.findLastIndex((i) => i.author === "lead");
  const folding = (item: ChatItem, n: number): string | undefined => {
    if (item.kind === "secret" || item.kind === "gated" ? tags.openItems?.has(item.id) === true : false) return undefined;
    // Yours with nothing from the lead after it: still waiting, so in sight.
    if (isMine(item) && n > lastLead) return undefined;
    const about = aboutOf(item);
    if (about !== undefined) return folds.has(about) ? about : undefined;
    // About several orders: it folds only once every one of them has.
    const orders = partOrders(item);
    return orders.length > 0 && orders.every((o) => folds.has(o)) ? orders.at(-1) : undefined;
  };
  const groups = new Map<string, Step[]>();
  const into = items.map((item, n) => {
    const order = folding(item, n);
    if (order !== undefined) {
      const g = groups.get(order) ?? [];
      g.push({ kind: "item", item, n, folded: true });
      groups.set(order, g);
    }
    return order;
  });
  const out: Step[] = [];
  items.forEach((item, n) => {
    const f = item.message?.fold;
    if (f !== undefined && folds.get(f.workstreamId) === f) {
      const open = tags.opened?.has(f.workstreamId) === true;
      out.push({ kind: "fold", fold: f, open, at: item.at });
      if (open) out.push(...(groups.get(f.workstreamId) ?? []));
    }
    if (into[n] === undefined) out.push({ kind: "item", item, n });
  });
  return out;
}
