// The tagged chat, a trial behind a project's switch (ProjectSummary.chatTags): the hub tags each message with the
// order it is about (`about`, or each bubble's own when one message covers several). The phone draws a quiet line over
// a run of bubbles naming who and what, only while two or more of the project's orders are open; a closed order's
// messages stay where they were; a lens narrows the same chat to one order's bubbles. With the switch off none of this
// runs and the chat is as it was. Pure, so it is unit-tested; the desktop's chat follows the same rules.
import type { ChatItem, ChatMessage, ChatSend, OrderCard } from "./desktop";
import { keyOf, type Key } from "./projectKey";

/**
 * Who an agent message is from: another bot's lead texting this one ("Lead of Shop"), this bot's lead texting
 * another's ("Lead to Shop"), or the agent that wrote it.
 */
export const agentName = (m: ChatMessage | undefined): string =>
  m?.lead === undefined ? (m?.by ?? "Agent") : m.lead.to !== undefined ? `Lead to ${m.lead.to}` : `Lead of ${m.by ?? "another bot"}`;

export type ChatAbout = NonNullable<ChatMessage["about"]>;

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

/**
 * The quiet line over a run of bubbles: who (when it isn't you) and what. `key` tells two lines apart; `endKey` is the
 * line as the message's last bubble leaves it (a message about several orders shows each bubble's own), which the next
 * message's line is compared with.
 */
export interface Tag {
  readonly key: string;
  readonly endKey: string;
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
    who = agentName(m);
  } else {
    const to = m?.for;
    who = to !== undefined && to.personId !== view.me ? `to ${firstName(to.name)}` : undefined;
  }
  if (who === undefined && order === undefined) return undefined;
  const last = m?.about === undefined ? m?.parts?.findLast((p) => p.about !== undefined)?.about : undefined;
  const end = last === undefined || last.workstreamId === view.lens ? order : last;
  return { key: `${who ?? ""}|${order?.workstreamId ?? ""}`, endKey: `${who ?? ""}|${end?.workstreamId ?? ""}`, who, order };
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
 * The thread's items in a lens on `lens`: only its order's (and the person's own sends from it, and a reply streaming
 * in, not tagged till it ends); all of them with no lens. `sendAbout` is the order each unsent message was sent from a
 * lens on.
 */
export const taggedItems = (items: readonly ChatItem[], o: { readonly lens: string | undefined; readonly sendAbout: ReadonlyMap<string, string> }): readonly ChatItem[] => {
  const lens = o.lens;
  if (lens === undefined) return items;
  return items.flatMap((i): ChatItem[] => {
    if (i.message === undefined) return i.state === "streaming" || (i.clientRequestId !== undefined && o.sendAbout.get(i.clientRequestId) === lens) ? [i] : [];
    if (!ordersOf(i.message).includes(lens)) return [];
    const message = lensCopy(i.message, lens);
    return [message === i.message ? i : { ...i, message }];
  });
};

/** Whether a jump to a message (a search hit, a push, a tapped quote) must close the lens: it is in the chat, outside it. */
export const lensHides = (items: readonly ChatItem[], messageId: string, o: Parameters<typeof taggedItems>[1]): boolean => {
  const item = items.find((i) => i.message?.messageId === messageId);
  return item !== undefined && !taggedItems(items, o).includes(item);
};

/** The About… menu's choices: the open orders, the one it is about now ticked, then Nothing. */
export const aboutChoices = (open: readonly OpenOrder[], now: string | undefined): ReadonlyArray<{ readonly label: string; readonly workstreamId: string | undefined; readonly current: boolean }> => [
  ...open.map((o) => ({ label: o.title, workstreamId: o.workstreamId as string | undefined, current: o.workstreamId === now })),
  { label: "Nothing", workstreamId: undefined, current: now === undefined },
];
