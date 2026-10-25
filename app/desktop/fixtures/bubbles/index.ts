// The chat as a messaging app (fixtures/bubbles), in storefront's chat on the typical hub (its PRs answer pr_get):
// a casual exchange whose lead replies the hub split into bubbles, a pause, and your reply to one of them; a chart, a
// bar chart and a table; a PR card with its diff; and the lead asking, with an approve-or-deny and a pick-one ask
// (answered) and a checklist. The typing bubble is chat-streaming's and stream-long's.
import { firstProject, writeChat, type Draft } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";

type Piece = string | JsonObject;

/** A lead message from its bubbles: words, or a block written as the lead writes it (a fleetd-block fence). */
const lead = (minutesAgo: number, ...pieces: Piece[]): Draft => {
  let text = "";
  const parts: JsonObject[] = [];
  for (const p of pieces) {
    if (text !== "") text += "\n\n";
    const start = text.length;
    text += typeof p === "string" ? p : `\`\`\`fleetd-block\n${JSON.stringify(p)}\n\`\`\``;
    parts.push({ start, end: text.length, ...(typeof p === "string" ? {} : { block: p }) });
  }
  return { author: "lead", text, minutesAgo, ...(parts.length > 1 || typeof pieces[0] !== "string" ? { parts } : {}) };
};
const you = (minutesAgo: number, text: string): Draft => ({ author: "human", text, minutesAgo });

const DAYS = ["Oct 6", "Oct 7", "Oct 8", "Oct 9", "Oct 10", "Oct 13", "Oct 14", "Oct 15", "Oct 16", "Oct 17", "Oct 20", "Oct 21", "Oct 22", "Oct 23"];

const CASUAL: Draft[] = [
  you(190, "morning! how did the nightly go?"),
  lead(189, "Morning.", "Nightly was green, all 214 tests.", "One flaky retry on checkout. It passed on the second run, and I opened a task to pin it down."),
  you(188, "nice"),
  lead(95, "The dates PR is up.", "Want me to start on discounts while it’s in review?"),
  you(94, "> Want me to start on discounts while it’s in review?\n\nyes, go ahead"),
  lead(93, "On it."),
  you(92, "🙌"),
  lead(3, "Discounts are done too.", "Both PRs are green and waiting on a review."),
];

const CHARTS: Draft[] = [
  you(40, "how have build times moved this month?"),
  lead(
    39,
    "Faster since the build cache landed on the 14th.",
    {
      v: 1,
      kind: "chart",
      chart: "line",
      title: "Build time, median",
      unit: "min",
      x: DAYS,
      series: [
        { name: "main", values: [9.4, 9.1, 9.6, 9.2, 9.8, 9.3, 6.2, 5.6, 5.4, 5.2, 5.3, 5.0, 5.1, 5.1] },
        { name: "PRs", values: [11.2, 10.8, 11.5, 11.0, 11.9, 10.9, 7.4, 6.8, 6.5, 6.1, 6.3, 6.0, 5.9, 6.0] },
      ],
    },
    "Median on main went from 9.4 to 5.1 minutes.",
  ),
  you(38, "and merges per week?"),
  lead(
    37,
    {
      v: 1,
      kind: "chart",
      chart: "bar",
      title: "PRs merged per week",
      unit: "PRs",
      x: ["Sep 22", "Sep 29", "Oct 6", "Oct 13", "Oct 20"],
      series: [{ name: "Merged", values: [14, 19, 17, 26, 31] }],
    },
    {
      v: 1,
      kind: "table",
      title: "Where the time went",
      columns: ["Step", "Before", "After", "Change"],
      rows: [
        ["Install", "2.1 min", "0.4 min", "−81%"],
        ["Build", "4.8 min", "2.9 min", "−40%"],
        ["Tests", "2.5 min", "1.8 min", "−28%"],
      ],
    },
  ),
];

const PATCH = [
  "@@ -12,9 +12,11 @@ export function ReceiptHeader({ order }: Props) {",
  "   return (",
  "     <header className={s.header}>",
  "-      <span>{formatDate(order.date)} · {formatTotal(order.total)}</span>",
  "+      <span className={s.date}>{formatDate(order.date, locale)}</span>",
  "+      <span className={s.total}>{formatTotal(order.total, locale)}</span>",
  "     </header>",
  "   );",
  " }",
].join("\n");

const PR: Draft[] = [
  you(30, "where are we with the receipt dates?"),
  lead(
    29,
    "The dates PR is ready for you.",
    { v: 1, kind: "pr", repo: "acme/storefront", number: 11, title: "Receipts: dates and totals on two lines" },
    {
      v: 1,
      kind: "diff",
      title: "The change that matters",
      files: [
        { path: "src/receipt/ReceiptHeader.tsx", hunks: [PATCH] },
        { path: "src/receipt/receipt.module.css", hunks: ["@@ -4,3 +4,11 @@\n .header {\n   display: flex;\n+  flex-direction: column;\n+  align-items: flex-end;\n }\n+.total {\n+  font-variant-numeric: tabular-nums;\n+}"] },
      ],
    },
    "It merges once a review lands.",
  ),
];

const ASK: Draft[] = [
  lead(50, { v: 1, kind: "ask", question: "Which goes first?", options: ["Dates", "Discounts"] }),
  you(49, "Dates"),
  lead(
    5,
    {
      v: 1,
      kind: "checklist",
      title: "Receipts",
      items: [
        { text: "Dates and totals on two lines", done: true },
        { text: "Rounding on discounts", done: true },
        { text: "PDF export matches the screen", done: false },
      ],
    },
    "Discounts change the rounding on old orders’ receipts in the PDF export.",
    { v: 1, kind: "ask", question: "Ship the rounding change to the PDF receipts too?" },
  ),
];

const chat = (base: Fixture, name: string, note: string, drafts: Draft[], opts: { needsYou?: boolean } = {}): Fixture => {
  const f = Fixture.from(base, name, note);
  writeChat(f, firstProject(f), drafts, opts);
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    chat(base("typical"), "bubbles-casual", "A casual exchange: lead replies split into bubbles, a pause, your reply to one bubble and an emoji.", CASUAL),
    chat(base("typical"), "bubbles-charts", "The lead answers with a line chart, a bar chart and a table.", CHARTS),
    chat(base("typical"), "bubbles-pr", "The lead shows a PR as a live card and the part of its diff that matters.", PR),
    chat(base("typical"), "bubbles-ask", "The lead asks you to approve, after a pick-one ask you answered, under a checklist.", ASK, { needsYou: true }),
  ],
});
