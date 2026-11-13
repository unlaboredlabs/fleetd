import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aboutChoices, foldCount, isFold, openOrdersOf, ordersOf, reveal, sendAbout, tagOf, taggedItems, type FoldLine, type TagView } from "./chatTags";
import { sameRow, threadRows, type ThreadRow } from "./chatView";
import { chatItems, emptyChat, type ChatItem, type ChatMessage, type OrderCard } from "./desktop";
import { fakeHub } from "./hub/fake";
import { Session } from "./session";

const REF = { machineId: "m1", projectId: "shop" };
const KEY = "m1/shop";
const AT = "2026-10-28T10:00:00Z";
const ME = "p_sam";
const DANA = { personId: "p_dana", name: "Dana Park" };
const SAM = { personId: ME, name: "Sam Rivera" };

const APPLE = { workstreamId: "W1", title: "Apple Pay" };
const SEARCH = { workstreamId: "W2", title: "Search speed" };
const VAT = { workstreamId: "W3", title: "Receipts show the VAT number" };

const at = (seq: number): string => new Date(Date.parse(AT) + seq * 1_000).toISOString();

const message = (seq: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${String(seq)}`,
  projectRef: REF,
  seq,
  author: "lead",
  text: `Message ${String(seq)}`,
  state: "final",
  createdAt: at(seq),
  ...extra,
});

const items = (messages: readonly ChatMessage[]): readonly ChatItem[] => chatItems({ ...emptyChat, messages, loaded: true }, []);

const card = (workstreamId: string, title: string, extra: Partial<OrderCard> = {}): OrderCard =>
  ({
    workstreamId,
    title,
    state: "open",
    projectRef: REF,
    createdAt: AT,
    updatedAt: AT,
    lanes: [],
    needsYou: 0,
    phase: "working",
    prs: [],
    settled: 0,
    total: 1,
    ...extra,
  }) as OrderCard;

const view = (extra: Partial<TagView> = {}): TagView => ({ show: true, me: ME, lens: undefined, ...extra });

const ids = (out: readonly (ChatItem | FoldLine)[]): string[] => out.map((x) => (isFold(x) ? `${x.id}${x.open ? "+" : ""}` : x.id));

const none = { lens: undefined, opened: new Set<string>(), me: ME, sendAbout: new Map<string, string>() };

describe("openOrdersOf", () => {
  it("is the project's open orders, oldest first, with their phase line", () => {
    const orders = [
      card("W2", "Search speed", { createdAt: "2026-10-28T09:00:00Z", phaseDetail: "1 working" }),
      card("W1", "Apple Pay", { createdAt: "2026-10-28T08:00:00Z" }),
      card("W9", "Elsewhere", { projectRef: { machineId: "m1", projectId: "other" } }),
      card("W3", "Done already", { state: "done" }),
    ];
    expect(openOrdersOf(orders, KEY)).toEqual([
      { workstreamId: "W1", title: "Apple Pay", phaseDetail: undefined },
      { workstreamId: "W2", title: "Search speed", phaseDetail: "1 working" },
    ]);
  });
});

describe("ordersOf", () => {
  it("is the message's order, or each of its bubbles' once", () => {
    expect(ordersOf(message(1))).toEqual([]);
    expect(ordersOf(message(1, { about: APPLE }))).toEqual(["W1"]);
    const parts = [
      { start: 0, end: 3, about: APPLE },
      { start: 4, end: 6, about: SEARCH },
      { start: 7, end: 9, about: APPLE },
    ];
    expect(ordersOf(message(1, { parts }))).toEqual(["W1", "W2"]);
  });
});

describe("tagOf", () => {
  const lead = (extra: Parameters<typeof message>[1]) => items([message(1, extra)])[0]!;

  it("shows nothing unless lines are on", () => {
    expect(tagOf(lead({ about: APPLE }), view({ show: false }))).toBeUndefined();
  });

  it("names the order and who the lead's message is for, never you", () => {
    expect(tagOf(lead({ about: SEARCH, for: DANA }), view())).toMatchObject({ who: "to Dana", order: SEARCH });
    expect(tagOf(lead({ about: SEARCH, for: SAM }), view())).toMatchObject({ who: undefined, order: SEARCH });
    expect(tagOf(lead({ for: DANA }), view())).toMatchObject({ who: "to Dana", order: undefined });
    expect(tagOf(lead({}), view())).toBeUndefined();
  });

  it("names another person over their message, and only the order over yours", () => {
    expect(tagOf(lead({ author: "human", person: DANA, about: SEARCH }), view())).toMatchObject({ who: "Dana Park", order: SEARCH });
    expect(tagOf(lead({ author: "human", person: SAM, about: SEARCH }), view())).toMatchObject({ who: undefined, order: SEARCH });
    expect(tagOf(lead({ author: "human", person: SAM }), view())).toBeUndefined();
  });

  it("names an agent over its own message", () => {
    expect(tagOf(lead({ author: "agent", by: "T12", about: APPLE }), view())).toMatchObject({ who: "T12", order: APPLE });
  });

  it("drops the lens's own order, keeping who it is for", () => {
    expect(tagOf(lead({ about: SEARCH, for: DANA }), view({ lens: "W2" }))).toMatchObject({ who: "to Dana", order: undefined });
    expect(tagOf(lead({ about: SEARCH }), view({ lens: "W2" }))).toBeUndefined();
  });

  it("takes a message about several orders by its first bubble's", () => {
    const parts = [
      { start: 0, end: 3, about: SEARCH },
      { start: 4, end: 9, about: APPLE },
    ];
    expect(tagOf(lead({ parts }), view())?.order).toEqual(SEARCH);
  });
});

describe("taggedItems: the lens", () => {
  it("shows only its order's messages, your sends from it, and a reply still streaming", () => {
    const chat = { ...emptyChat, messages: [message(1, { about: APPLE }), message(2, { about: SEARCH }), message(3)], streams: { m9: { text: "Look", at: at(9) } }, loaded: true };
    const sends = [
      { clientRequestId: "c1", text: "Also the cart", attachments: [], at: at(4), state: { t: "sending" as const }, about: "W1" },
      { clientRequestId: "c2", text: "Elsewhere", attachments: [], at: at(5), state: { t: "sending" as const } },
    ];
    const out = taggedItems(chatItems(chat, sends), { ...none, lens: "W1", sendAbout: sendAbout(sends) });
    expect(ids(out)).toEqual(["m1", "m9", "c1"]);
  });

  it("keeps only the lens's bubbles of a message about several, the same copy each time", () => {
    const parts = [
      { start: 0, end: 3, about: SEARCH },
      { start: 4, end: 9, about: APPLE },
    ];
    const m = message(1, { text: "Two things", parts });
    const once = taggedItems(items([m]), { ...none, lens: "W1" });
    const again = taggedItems(items([m]), { ...none, lens: "W1" });
    const first = once[0] as ChatItem;
    expect(first.message?.parts).toEqual([parts[1]]);
    expect((again[0] as ChatItem).message).toBe(first.message);
    // The message itself is left as it was.
    expect(m.parts).toHaveLength(2);
  });
});

describe("taggedItems: folds", () => {
  const fold = { ...VAT, state: "done" as const, count: 3 };
  const thread = [message(1, { author: "human", person: DANA, about: VAT }), message(2, { about: APPLE }), message(3, { about: VAT }), message(4, { about: VAT, fold }), message(5, { about: APPLE })];

  it("leaves a chat with no closed order as it is", () => {
    const list = items([message(1, { about: APPLE })]);
    expect(taggedItems(list, none)).toBe(list);
  });

  it("folds a closed order's messages into one line where it landed", () => {
    expect(ids(taggedItems(items(thread), none))).toEqual(["m2", "fold:W3", "m5"]);
  });

  it("opens them together under the line, in order, once tapped", () => {
    expect(ids(taggedItems(items(thread), { ...none, opened: new Set(["W3"]) }))).toEqual(["m2", "fold:W3+", "m1", "m3", "m4", "m5"]);
  });

  it("never folds a card still waiting, nor your own message the lead hasn't answered", () => {
    const card = message(2, { about: VAT, item: { kind: "command_approval", requestId: "r1", state: "open" } as never });
    const mine = message(6, { author: "human", person: SAM, about: VAT, fold });
    const list = items([message(1, { about: VAT }), card, message(3, { about: VAT }), message(5, { about: APPLE }), mine]);
    expect(ids(taggedItems(list, none))).toEqual(["m2", "m5", "fold:W3", "m6"]);
  });

  it("folds your own message once the lead wrote after it", () => {
    const list = items([message(1, { author: "human", person: SAM, about: VAT }), message(2, { about: VAT, fold })]);
    expect(ids(taggedItems(list, none))).toEqual(["fold:W3"]);
  });

  it("keeps whole, in its place, a message also about an open order", () => {
    const parts = [
      { start: 0, end: 3, about: VAT },
      { start: 4, end: 9, about: APPLE },
    ];
    const list = items([message(1, { about: VAT }), message(2, { text: "Both of them", parts, fold })]);
    expect(ids(taggedItems(list, none))).toEqual(["fold:W3", "m2"]);
  });

  it("shows everything of the lens's order, folding nothing", () => {
    expect(ids(taggedItems(items(thread), { ...none, lens: "W3" }))).toEqual(["m1", "m3", "m4"]);
  });
});

describe("reveal", () => {
  const fold = { ...VAT, state: "done" as const, count: 2 };
  const thread = items([message(1, { about: VAT }), message(2, { about: VAT, fold }), message(3, { about: APPLE }), message(4)]);

  it("leaves a message that shows, or isn't there, as it is", () => {
    expect(reveal(thread, "m3", none)).toBeUndefined();
    expect(reveal(thread, "m9", none)).toBeUndefined();
    expect(reveal(thread, "m3", { ...none, lens: "W1" })).toBeUndefined();
  });

  it("opens the fold a message is in", () => {
    const r = reveal(thread, "m1", none);
    expect(r?.lens).toBeUndefined();
    expect([...(r?.opened ?? [])]).toEqual(["W3"]);
    expect(ids(taggedItems(thread, { ...none, opened: r!.opened }))).toContain("m1");
  });

  it("closes a lens the message isn't in, opening its fold too when it is folded", () => {
    expect(reveal(thread, "m4", { ...none, lens: "W1" })).toEqual({ lens: undefined, opened: none.opened });
    expect([...(reveal(thread, "m2", { ...none, lens: "W1" })?.opened ?? [])]).toEqual(["W3"]);
  });
});

describe("threadRows in a tagged chat", () => {
  const tags = (i: ChatItem) => tagOf(i, view());
  const tagged = (rows: readonly ThreadRow[]) => rows.flatMap((r) => (r.t === "item" ? [`${r.id}:${r.first ? "first" : "-"}:${r.tag?.order?.title ?? ""}`] : [r.t]));

  it("puts the tag over the first bubble of each run, a new tag starting a run", () => {
    const list = items([message(1, { about: APPLE }), message(2, { about: APPLE }), message(3, { about: SEARCH })]);
    expect(tagged(threadRows(list, undefined, undefined, { timeZone: "UTC" }, tags))).toEqual(["day", "m1:first:Apple Pay", "m2:-:", "m3:first:Search speed"]);
  });

  it("tags the next message when it goes back to an order after one about several", () => {
    const parts = [
      { start: 0, end: 3, about: APPLE },
      { start: 4, end: 9, about: SEARCH },
    ];
    const list = items([message(1, { text: "Two things", parts }), message(2, { about: APPLE }), message(3, { about: APPLE })]);
    expect(tagged(threadRows(list, undefined, undefined, { timeZone: "UTC" }, tags))).toEqual(["day", "m1:first:Apple Pay", "m2:first:Apple Pay", "m3:-:"]);
    // Ending on the order the next one is about, it goes on the same run.
    const back = items([message(1, { text: "Two things", parts: [...parts].reverse() }), message(2, { about: APPLE })]);
    expect(tagged(threadRows(back, undefined, undefined, { timeZone: "UTC" }, tags))).toEqual(["day", "m1:first:Search speed", "m2:-:"]);
  });

  it("is as before with no tags", () => {
    const list = items([message(1, { about: APPLE }), message(2, { about: SEARCH })]);
    expect(tagged(threadRows(list, undefined, undefined, { timeZone: "UTC" }))).toEqual(["day", "m1:first:", "m2:-:"]);
  });

  it("draws a fold line as its own row, the bubbles after it a new run", () => {
    const fold = { ...VAT, state: "done" as const, count: 2 };
    const list = taggedItems(items([message(1, { about: APPLE }), message(2, { about: VAT }), message(3, { about: VAT, fold }), message(4, { about: APPLE })]), none);
    const rows = threadRows(list, undefined, undefined, { timeZone: "UTC" }, tags);
    expect(tagged(rows)).toEqual(["day", "m1:first:Apple Pay", "fold", "m4:first:Apple Pay"]);
    const line = rows.find((r) => r.t === "fold");
    expect(line).toMatchObject({ t: "fold", id: "fold:W3", line: { fold, open: false } });
  });

  it("draws a row again when its tag or its fold changes", () => {
    const [a] = items([message(1, { about: APPLE })]);
    const row = (tag: ReturnType<typeof tagOf>): ThreadRow => ({ t: "item", id: "m1", item: a!, side: "them", first: true, ...(tag === undefined ? {} : { tag }) });
    expect(sameRow(row(tagOf(a!, view())), row(tagOf(a!, view())))).toBe(true);
    expect(sameRow(row(tagOf(a!, view())), row(undefined))).toBe(false);
    const line = (open: boolean, count: number): ThreadRow => ({ t: "fold", id: "fold:W3", line: { t: "fold", id: "fold:W3", at: AT, fold: { ...VAT, state: "done", count }, open } });
    expect(sameRow(line(false, 2), line(false, 2))).toBe(true);
    expect(sameRow(line(false, 2), line(true, 2))).toBe(false);
    expect(sameRow(line(false, 2), line(false, 3))).toBe(false);
  });
});

describe("words", () => {
  it("counts a fold's messages", () => {
    expect(foldCount(1)).toBe("1 message");
    expect(foldCount(6)).toBe("6 messages");
  });

  it("lists the open orders for About…, the current ticked, then Nothing", () => {
    const open = [
      { workstreamId: "W1", title: "Apple Pay", phaseDetail: undefined },
      { workstreamId: "W2", title: "Search speed", phaseDetail: undefined },
    ];
    expect(aboutChoices(open, "W2")).toEqual([
      { label: "Apple Pay", workstreamId: "W1", current: false },
      { label: "Search speed", workstreamId: "W2", current: true },
      { label: "Nothing", workstreamId: undefined, current: false },
    ]);
    expect(aboutChoices(open, undefined).at(-1)).toEqual({ label: "Nothing", workstreamId: undefined, current: true });
  });
});

describe("Session in a tagged chat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  const setup = () => {
    const hub = fakeHub();
    let id = 0;
    const session = new Session({ hub: "http://devbox:4790", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT), newId: () => `c${String(++id)}` });
    session.start();
    hub.ready();
    hub.link.frame({
      t: "snapshot",
      cursor: 1,
      attention: [],
      machines: [],
      projects: [{ machineId: "m1", projectId: "shop", title: "storefront", workspaceRoot: "/home/devbox/shop", lastActivityAt: AT, threads: { running: 0, waiting: 0, failed: 0, idle: 0 }, chatTags: true }],
      chats: [{ projectRef: REF, lastSeq: 1, leadWorking: false, needsYou: false }],
    });
    return { hub, session };
  };

  it("sends from a lens with its order, and keeps it for a resend", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", { messages: [], moreBefore: false, moreAfter: false });
    await flush();
    session.send(KEY, "Also the cart", { about: "W1" });
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "chat_send", input: { text: "Also the cart", about: "W1" } });
    hub.fail("chat_send", "invalid", "Too long.");
    await flush();
    session.resend(KEY, "c1");
    expect(hub.sentOf("call").filter((c) => c.tool === "chat_send").map((c) => (c.input as { about?: string }).about)).toEqual(["W1", "W1"]);
  });

  it("sends no order outside a lens", async () => {
    const { hub, session } = setup();
    session.send(KEY, "Hi");
    await flush();
    expect(hub.sentOf("call").at(-1)?.input).not.toHaveProperty("about");
  });

  it("moves a message to another order, showing the hub's copy at once", async () => {
    const { hub, session } = setup();
    session.openChat(KEY);
    hub.answer("chat_history", { messages: [message(1, { about: SEARCH })], moreBefore: false, moreAfter: false });
    await flush();
    const moved = session.retag(KEY, "m1", "W1");
    expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "chat_about_set", input: { projectRef: REF, messageId: "m1", workstreamId: "W1" } });
    hub.answer("chat_about_set", { message: message(1, { about: APPLE, updatedAt: at(9) }) });
    expect((await moved).ok).toBe(true);
    expect(session.state.chats[KEY]?.messages[0]?.about).toEqual(APPLE);
  });

  it("moves one to Nothing without an order, and says why when the hub refuses", async () => {
    const { hub, session } = setup();
    const moved = session.retag(KEY, "m1", undefined);
    expect(hub.sentOf("call").at(-1)?.input).toEqual({ projectRef: REF, messageId: "m1" });
    hub.fail("chat_about_set", "invalid", "The chat's tags are off.");
    const r = await moved;
    expect(r.ok ? undefined : r.error.message).toBe("The chat's tags are off.");
  });

  it("keeps the open orders from the board", async () => {
    const { hub, session } = setup();
    hub.link.frame({ t: "event", seq: 2, type: "workstream.updated", at: AT, data: {} });
    await flush();
    hub.answer("orders_board", { orders: [card("W1", "Apple Pay")] });
    await flush();
    expect(openOrdersOf(session.state.orders, KEY)).toEqual([{ workstreamId: "W1", title: "Apple Pay", phaseDetail: undefined }]);
  });
});
