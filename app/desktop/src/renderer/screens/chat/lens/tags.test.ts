// The tagged chat's rows: tags over runs only while two or more orders are open, a closed order folded into its
// landing line (open items and your unanswered message kept out), the lens, and nothing of it with the trial off.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../../src/data/chat";
import type { ChatMessage } from "../../../src/data/chat-contract";
import { chatRows, type Row } from "../model";
import type { Tags } from "./tags";

const NOW = Date.UTC(2026, 9, 19, 18);
const ME = { personId: "p_sam", name: "Sam Rivera" };
const DANA = { personId: "p_dana", name: "Dana Park" };
const PAY = { workstreamId: "W2", title: "Apple Pay" };
const SEARCH = { workstreamId: "W3", title: "Search speed" };
const VAT = { workstreamId: "W1", title: "Receipts show the VAT number" };

let seq = 0;
/** A message the hub has, `over` its fields; a minute after the one before. */
const msg = (author: "human" | "lead", over: Partial<ChatMessage> = {}, kind: ChatItem["kind"] = "message"): ChatItem => {
  seq += 1;
  const at = new Date(NOW - (100 - seq) * 60_000).toISOString();
  const message: ChatMessage = { messageId: `m${String(seq)}`, projectRef: { machineId: "devbox", projectId: "shop" }, seq, author, text: `text ${String(seq)}`, createdAt: at, state: "final", ...over };
  return { id: message.messageId, author, kind, text: message.text, at, attachments: [], state: "sent", message };
};

const rows = (items: ChatItem[], tags: Tags | undefined) => chatRows({ items, hasOlder: false, loadingOlder: false, nowMs: NOW, timeZone: "UTC", me: ME.personId, tags });

/** Each row as a word: a message's id with its line over it (`who · order`), a fold's line. */
const shown = (r: readonly Row[]): string[] =>
  r.flatMap((x) => {
    if (x.kind === "fold") return [`fold:${x.fold.title}${x.open ? " (open)" : ""}`];
    if (x.kind === "inline") return [`card:${x.item.id}`];
    if (x.kind !== "message") return [];
    const line = [x.tag?.to === undefined ? undefined : `to ${x.tag.to}`, x.tag?.order?.title].filter((w) => w !== undefined).join(" · ");
    return [line === "" ? x.item.id : `${x.item.id} [${line}]`];
  });

const busy = () => {
  seq = 0;
  return [
    msg("human", { person: DANA, about: VAT }),
    msg("lead", { for: DANA, about: VAT }),
    msg("lead", { for: DANA, about: VAT, item: { kind: "command_approval", requestId: "Q1", machineId: "devbox", state: "open" } as never }, "gated"),
    msg("human", { person: ME, about: PAY }),
    msg("lead", { for: ME, about: PAY }),
    msg("human", { person: DANA, about: SEARCH }),
    msg("lead", { for: DANA, about: SEARCH }),
    msg("lead", { for: DANA, about: VAT, fold: { ...VAT, state: "done", count: 4 } }),
    msg("lead", { for: ME }),
  ];
};

describe("the tagged chat", () => {
  it("is today's chat with the trial off, whatever the messages carry", () => {
    const items = busy();
    const off = rows(items, undefined);
    expect(off.some((r) => r.kind === "fold" || (r.kind === "message" && r.tag !== undefined))).toBe(false);
    expect(shown(off)).toEqual(["m1", "m2", "card:m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  it("names each run's order and whom the lead writes to, never you, and folds the closed order where it landed", () => {
    expect(shown(rows(busy(), { named: true, openItems: new Set() }))).toEqual([
      "m4 [Apple Pay]",
      // To you: only the order.
      "m5 [Apple Pay]",
      "m6 [Search speed]",
      "m7 [to Dana · Search speed]",
      // Where m8, its landing, was.
      "fold:Receipts show the VAT number",
      "m9",
    ]);
  });

  it("keeps an approval still open, and your message the lead hasn't answered, out of the fold", () => {
    const items = busy();
    items.push(msg("human", { person: ME, about: VAT }));
    const r = shown(rows(items, { named: true, openItems: new Set(["m3"]) }));
    expect(r).toContain("card:m3");
    expect(r.at(-1)).toBe("m10 [Receipts show the VAT number]");
    expect(r.indexOf("card:m3")).toBeLessThan(r.indexOf("fold:Receipts show the VAT number"));
  });

  it("opens a fold under its line, oldest first, without naming the order it already names", () => {
    const r = shown(rows(busy(), { named: true, opened: new Set(["W1"]) }));
    expect(r.slice(r.indexOf("fold:Receipts show the VAT number (open)"))).toEqual(["fold:Receipts show the VAT number (open)", "m1", "m2 [to Dana]", "card:m3", "m8 [to Dana]", "m9"]);
  });

  it("names no order while fewer than two are open, nor whom the lead writes to", () => {
    expect(shown(rows(busy(), { named: false }))).toEqual(["m4", "m5", "m6", "m7", "fold:Receipts show the VAT number", "m9"]);
  });

  it("shows one order in a lens, its name off the tags, and of a message about two orders only its bubble", () => {
    const items = busy();
    const split = msg("lead", {
      for: DANA,
      text: "one\n\ntwo",
      parts: [
        { start: 0, end: 3, about: PAY },
        { start: 5, end: 8, about: SEARCH },
      ],
    });
    items.push(split);
    const r = rows(items, { named: true, lens: "W3" });
    // Whom the lead writes to, once while it stays the same.
    expect(shown(r)).toEqual(["m6", "m7 [to Dana]", "m10"]);
    expect(r.find((x) => x.kind === "message" && x.item.id === "m10")).toMatchObject({ parts: ["1"] });
    // No fold in a lens: a closed order's messages all show.
    expect(shown(rows(busy(), { named: true, lens: "W1" }))).toEqual(["m1", "m2 [to Dana]", "card:m3", "m8"]);
  });

  it("takes a send from a lens into the lens before the hub has it", () => {
    seq = 0;
    const sending: ChatItem = { id: "c1", author: "human", kind: "message", text: "and on the cart", at: new Date(NOW).toISOString(), attachments: [], state: "pending", about: "W2" };
    expect(shown(rows([msg("human", { person: ME, about: PAY }), sending], { named: true, lens: "W2" }))).toEqual(["m1", "c1"]);
  });

  it("starts a new run when the order changes, even from the same author a minute on", () => {
    seq = 0;
    const r = rows([msg("lead", { about: PAY }), msg("lead", { about: PAY }), msg("lead", { about: SEARCH })], { named: true });
    expect(r.flatMap((x) => (x.kind === "message" ? [x.run] : []))).toEqual([true, false, true]);
  });
});
