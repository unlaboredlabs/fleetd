// The tagged chat (a project's trial, `chatTags`), in storefront's chat on the typical hub, as Sam sees it on a hub
// Dana shares: three orders open (Apple Pay, Search speed, Price filter) and one closed (the receipts' VAT number,
// folded into its landing line, with its approval card). A lead message covers two orders, one bubble each; a
// quick answer is about none. `tags-one-order`: the same with Apple Pay alone open, so no tag names an order.
// `tags-off`: the trial off on the same chat, as every chat is today (the hub then tags nothing).
import { commandApproval, firstProject, writeChat, type Draft, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import type { JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

const SAM = { personId: "p_aaaaaaaa", name: "Sam Rivera" };
const DANA = { personId: "p_dddddddd", name: "Dana Park" };

const VAT = { workstreamId: "W11", title: "Receipts show the VAT number" };
const PAY = { workstreamId: "W12", title: "Apple Pay" };
const SEARCH = { workstreamId: "W13", title: "Search speed" };
const FILTER = { workstreamId: "W14", title: "Price filter" };

type About = typeof VAT;

/** What the hub adds with the trial on: the order a message is about. */
const about = (o: About | undefined): JsonObject => (o === undefined ? {} : { about: { ...o } });

const dana = (minutesAgo: number, text: string, o?: About): Draft => ({ author: "human", text, minutesAgo, extra: { person: { ...DANA }, ...about(o) } });
const sam = (minutesAgo: number, text: string, o?: About): Draft => ({ author: "human", text, minutesAgo, extra: { person: { ...SAM }, ...about(o) } });
const lead = (minutesAgo: number, text: string, to: typeof SAM, o?: About, more: JsonObject = {}): Draft => ({
  author: "lead",
  text,
  minutesAgo,
  extra: { for: { ...to }, ...about(o), ...more },
});
/** A lead message about two orders, a bubble each: the hub stripped each bubble's `[W12]` and tagged the bubble. */
const split = (minutesAgo: number, to: typeof SAM, ...bubbles: ReadonlyArray<readonly [About, string]>): Draft => {
  let text = "";
  const parts: JsonObject[] = [];
  for (const [o, words] of bubbles) {
    if (text !== "") text += "\n\n";
    parts.push({ start: text.length, end: text.length + words.length, about: { ...o } });
    text += words;
  }
  return { author: "lead", text, minutesAgo, parts, extra: { for: { ...to } } };
};

const chat = (f: Fixture): Draft[] => [
  dana(52, "Receipts should show the store’s VAT number.", VAT),
  lead(51, "Small fix, one writer on it. Old receipts need a backfill on prod, so there’s an approval below.", DANA, VAT),
  { author: "lead", text: "", minutesAgo: 50, item: commandApproval("ran", f), extra: { for: { ...DANA }, ...about(VAT) } },
  sam(44, "Can we add Apple Pay to the checkout?", PAY),
  lead(43, "On it: one writer at checkout.\n\nKeep card entry as the fallback? Rec: yes, half our shoppers don’t have Apple Pay set up.", SAM, PAY),
  dana(40, "Search feels slow on my phone, can you look?", SEARCH),
  lead(39, "Looking: an agent is timing search on a phone screen.", DANA, SEARCH),
  sam(36, "yes, keep card entry", PAY),
  dana(33, "Add a price filter to search too", FILTER),
  split(32, DANA, [FILTER, "On it: two writers, the filter and keeping it in the link."], [SEARCH, "Search is slow because product images are 2 MB each on phones."]),
  lead(20, "Receipts show the VAT number now, and the old ones are backfilled. It’s live.", DANA, VAT, { fold: { ...VAT, state: "done", count: 4 } }),
  sam(12, "how much of checkout do our tests cover?"),
  lead(11, "71% of checkout’s lines, least in the payment step (48%).", SAM),
  lead(3, "Found it: resize the images on upload, or lazy-load them? Rec: resize, it also cuts bandwidth.", DANA, SEARCH),
];

/** The chat as the hub serves it with the trial off: no order on anything. */
const untagged = (drafts: ReadonlyArray<Draft>): Draft[] =>
  drafts.map((d) => {
    const { about: _a, fold: _f, ...extra } = d.extra ?? {};
    return { ...d, extra, ...(d.parts === undefined ? {} : { parts: d.parts.map(({ about: _p, ...p }) => p) }) };
  });

/** An open order on the board, its card as the hub reads it. */
const card = (f: Fixture, ref: Ref, o: About, minutesAgo: number, phaseDetail: string): JsonObject => ({
  workstreamId: o.workstreamId,
  title: o.title,
  projectRef: { ...ref },
  createdAt: at(f.now, -minutesAgo * 60_000),
  updatedAt: at(f.now, -60_000),
  phase: "working",
  phaseDetail,
  state: "open",
  lanes: [],
  prs: [],
  needsYou: 0,
  settled: 0,
  total: 1,
});

function tagged(base: Fixture, name: string, note: string, opts: { on: boolean; open: ReadonlyArray<About> }): Fixture {
  const f = Fixture.from(base, name, note);
  const ref = firstProject(f);
  // The project with its trial on (or not), and the lead at rest: nothing in the band but what the chat says.
  for (const p of arr(f.snapshot?.["projects"])) {
    const project = obj(p);
    if (project["projectId"] !== ref.projectId) continue;
    if (opts.on) project["chatTags"] = true;
    else delete project["chatTags"];
  }
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true, me: { ...SAM, role: "owner", createdAt: "2026-09-01T08:00:00.000Z" }, people: 2 });
  f.answer("people_list", undefined, {
    people: [
      { ...SAM, role: "owner", createdAt: "2026-09-01T08:00:00.000Z" },
      { ...DANA, role: "member", createdAt: "2026-10-02T08:00:00.000Z" },
    ],
    devices: [],
    invites: [],
    me: SAM.personId,
  });
  const phases: Record<string, string> = { W12: "1 working · #233 in review", W13: "1 working", W14: "2 working" };
  const minutes: Record<string, number> = { W12: 44, W13: 40, W14: 33 };
  const own = opts.open.map((o) => card(f, ref, o, minutes[o.workstreamId] ?? 30, phases[o.workstreamId] ?? "1 working"));
  f.update("orders_board", (out, input) => {
    const scope = obj(input)["projectRef"];
    if (obj(input)["includeDoneSince"] !== undefined || (scope !== undefined && obj(scope)["projectId"] !== ref.projectId)) return out;
    const kept = arr(obj(out)["orders"]).filter((o) => obj(obj(o)["projectRef"])["projectId"] !== ref.projectId);
    return { ...obj(out), orders: [...kept, ...own] };
  });
  for (const o of own) f.answer("order_get", { workstreamId: o["workstreamId"] ?? "" }, { order: o, doneLanes: [], requests: [] });
  // A move (About…) the hub answers with the message moved; the app also takes its chat.message event.
  const drafts = opts.on ? chat(f) : untagged(chat(f));
  const messages = writeChat(f, ref, drafts);
  f.answer("chat_about_set", undefined, { message: { ...obj(messages[5]), about: { ...FILTER }, updatedAt: f.now } });
  // No agents at work in it: the band says only what the chat does.
  f.live = f.live.map((frame) => ({ ...frame, lanes: arr(frame["lanes"]).filter((l) => obj(obj(l)["projectRef"])["projectId"] !== ref.projectId) }));
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    tagged(base("typical"), "tags-busy", "Sam and Dana's tagged chat: three orders open, one folded into its landing line, a message about two orders.", {
      on: true,
      open: [PAY, SEARCH, FILTER],
    }),
    tagged(base("typical"), "tags-one-order", "The tagged chat with only Apple Pay open: no tag names an order; the closed one still folds.", { on: true, open: [PAY] }),
    tagged(base("typical"), "tags-off", "The same chat with the trial off: as every chat is today.", { on: false, open: [PAY, SEARCH, FILTER] }),
  ],
});
