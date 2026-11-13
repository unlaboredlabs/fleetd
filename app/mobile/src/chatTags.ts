// The tagged chat, a trial behind a project's switch (ProjectSummary.chatTags): the hub tags each message with the
// order it is about (`about`, or each bubble's own when one message covers several), and a closed order's messages
// fold into its landing line (`fold`). The phone draws a quiet line over a run of bubbles naming who and what, only
// while two or more of the project's orders are open; a finished order is one line where it landed, which opens in
// place; a lens narrows the same chat to one order's bubbles. With the switch off none of this runs and the chat is as
// it was. Pure, so it is unit-tested; the desktop's chat follows the same rules.
import type { ChatItem, ChatMessage, ChatSend, OrderCard } from "./desktop";
import { keyOf, type Key } from "./projectKey";

export type ChatAbout = NonNullable<ChatMessage["about"]>;
export type ChatFold = NonNullable<ChatMessage["fold"]>;

/** A message on its way, sent from a lens: the order it is about (chat_send's `about`), kept for every resend. */
export type LensSend = ChatSend & { readonly about?: string };

/** The order each unsent message was sent from a lens on, by its clientRequestId. */
export const sendAbout = (sends: readonly LensSend[] | undefined): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const r of sends ?? []) if (r.about !== undefined) out.set(r.clientRequestId, r.about);
  return out;
};

/** An open order of the project, as the board has it: a tag's words, the lens's phase line, an About… choice. */
export interface OpenOrder {
  readonly workstreamId: string;
  readonly title: string;
  readonly phaseDetail: string | undefined;
}

/** The project's open orders, oldest first, as the About… menu lists them. */
export const openOrdersOf = (orders: readonly OrderCard[], key: Key): readonly OpenOrder[] =>
  orders
    .filter((o) => o.state === "open" && keyOf(o.projectRef) === key)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((o) => ({ workstreamId: o.workstreamId, title: o.title, phaseDetail: o.phaseDetail }));

/** The order ids a message is about: its own, or its bubbles' when it covers several; none for an untagged one. */
export const ordersOf = (message: ChatMessage | undefined): readonly string[] => {
  if (message === undefined) return [];
  if (message.about !== undefined) return [message.about.workstreamId];
  const ids: string[] = [];
  for (const p of message.parts ?? []) if (p.about !== undefined && !ids.includes(p.about.workstreamId)) ids.push(p.about.workstreamId);
  return ids;
};

/** What a message is about as its first bubble says it: the tag over its run. */
export const aboutOf = (message: ChatMessage | undefined): ChatAbout | undefined => message?.about ?? message?.parts?.find((p) => p.about !== undefined)?.about;

/** The quiet line over a run of bubbles: who (when it isn't you) and what. `key` tells two lines apart. */
export interface Tag {
  readonly key: string;
  /** "Dana Park" over another person's message, "to Dana" over the lead's to them, an agent's name over its own. */
  readonly who: string | undefined;
  readonly order: ChatAbout | undefined;
}

export interface TagView {
  /** The switch is on and two or more of the project's orders are open: lines show. */
  readonly show: boolean;
  /** This phone's person. */
  readonly me: string | undefined;
  /** The order a lens is on: its own name goes from the lines, as everything there is about it. */
  readonly lens: string | undefined;
}

const firstName = (name: string): string => name.trim().split(/\s+/u)[0] ?? name;

/** A message's tag line, or none: lines show only while `view.show`, and never say "you". */
export const tagOf = (item: Pick<ChatItem, "author" | "message">, view: TagView): Tag | undefined => {
  if (!view.show) return undefined;
  const m = item.message;
  const about = aboutOf(m);
  const order = about === undefined || about.workstreamId === view.lens ? undefined : about;
  let who: string | undefined;
  if (item.author === "human") {
    const person = m?.person;
    who = person !== undefined && person.personId !== view.me ? person.name : undefined;
  } else if (item.author === "agent") {
    who = m?.by ?? "Agent";
  } else {
    const to = m?.for;
    who = to !== undefined && to.personId !== view.me ? `to ${firstName(to.name)}` : undefined;
  }
  if (who === undefined && order === undefined) return undefined;
  return { key: `${who ?? ""}|${order?.workstreamId ?? ""}`, who, order };
};

/** A closed order's landing line, where its messages fold: `open` once tapped, with them under it. */
export interface FoldLine {
  readonly t: "fold";
  readonly id: string;
  readonly at: string;
  readonly fold: ChatFold;
  readonly open: boolean;
}

export const isFold = (x: ChatItem | FoldLine): x is FoldLine => (x as Partial<FoldLine>).t === "fold";

/** The fold line's words, after the order's title: "6 messages". */
export const foldCount = (n: number): string => (n === 1 ? "1 message" : `${String(n)} messages`);

/** An inline card still waiting (an approval, a secret) never folds, nor a person's own message the lead hasn't answered. */
const staysOut = (item: ChatItem, me: string | undefined, lastLeadSeq: number): boolean => {
  const inline = item.message?.item;
  if (inline !== undefined && inline.state === "open") return true;
  if (item.author !== "human") return false;
  const mine = item.message?.person === undefined || item.message.person.personId === me;
  return mine && (item.message?.seq ?? Infinity) > lastLeadSeq;
};

/**
 * A lens's copy of a message about several orders: only the lens's bubbles. The same copy each time for the same
 * message, so a row that didn't change doesn't draw again (chatView.ts sameRow).
 */
const lensed = new WeakMap<ChatMessage, { readonly lens: string; readonly message: ChatMessage }>();
const lensCopy = (message: ChatMessage, lens: string): ChatMessage => {
  if (message.about !== undefined || message.parts === undefined) return message;
  const known = lensed.get(message);
  if (known?.lens === lens) return known.message;
  const copy = { ...message, parts: message.parts.filter((p) => p.about?.workstreamId === lens) };
  lensed.set(message, { lens, message: copy });
  return copy;
};

/**
 * The thread's items with the trial's rules: in a lens, only its order's (and the person's own sends from it, and a
 * reply streaming in, not tagged till it ends); otherwise each closed order's messages as one line where it landed,
 * gathered under it once `opened`. `sendAbout` is the order each unsent message was sent from a lens on.
 */
export const taggedItems = (
  items: readonly ChatItem[],
  o: { readonly lens: string | undefined; readonly opened: ReadonlySet<string>; readonly me: string | undefined; readonly sendAbout: ReadonlyMap<string, string> },
): readonly (ChatItem | FoldLine)[] => {
  const lens = o.lens;
  if (lens !== undefined) {
    return items.flatMap((i): ChatItem[] => {
      if (i.message === undefined) return i.state === "streaming" || (i.clientRequestId !== undefined && o.sendAbout.get(i.clientRequestId) === lens) ? [i] : [];
      if (!ordersOf(i.message).includes(lens)) return [];
      const message = lensCopy(i.message, lens);
      return [message === i.message ? i : { ...i, message }];
    });
  }
  // Where each closed order folds: the message the hub put its fold on.
  const folds = new Map<string, { readonly holder: string; readonly fold: ChatFold }>();
  for (const i of items) if (i.message?.fold !== undefined) folds.set(i.message.fold.workstreamId, { holder: i.id, fold: i.message.fold });
  if (folds.size === 0) return items;
  let lastLeadSeq = -1;
  for (const i of items) if (i.author === "lead" && i.message !== undefined && i.message.seq > lastLeadSeq) lastLeadSeq = i.message.seq;
  // Which fold each message goes into: only a message all of whose orders are closed (one also about an open order
  // stays whole, in its place), into its first order's.
  const into = (i: ChatItem): string | undefined => {
    const ids = ordersOf(i.message);
    return ids.length > 0 && ids.every((id) => folds.has(id)) ? ids[0] : undefined;
  };
  const gathered = new Map<string, ChatItem[]>();
  const folded = new Set<string>();
  for (const i of items) {
    const ws = into(i);
    if (ws === undefined || staysOut(i, o.me, lastLeadSeq) || folds.get(ws)?.holder === i.id) continue;
    const group = gathered.get(ws);
    if (group === undefined) gathered.set(ws, [i]);
    else group.push(i);
    folded.add(i.id);
  }
  const out: (ChatItem | FoldLine)[] = [];
  for (const i of items) {
    const fold = i.message?.fold;
    if (fold !== undefined && folds.get(fold.workstreamId)?.holder === i.id) {
      const open = o.opened.has(fold.workstreamId);
      out.push({ t: "fold", id: `fold:${fold.workstreamId}`, at: i.at, fold, open });
      if (open) out.push(...(gathered.get(fold.workstreamId) ?? []));
      // Itself folded, unless it waits on someone or is also about an open order.
      if (open || staysOut(i, o.me, lastLeadSeq) || into(i) === undefined) out.push(i);
      continue;
    }
    if (!folded.has(i.id)) out.push(i);
  }
  return out;
};

/** The About… menu's choices: the open orders, the one it is about now ticked, then Nothing. */
export const aboutChoices = (open: readonly OpenOrder[], now: string | undefined): ReadonlyArray<{ readonly label: string; readonly workstreamId: string | undefined; readonly current: boolean }> => [
  ...open.map((o) => ({ label: o.title, workstreamId: o.workstreamId as string | undefined, current: o.workstreamId === now })),
  { label: "Nothing", workstreamId: undefined, current: now === undefined },
];
