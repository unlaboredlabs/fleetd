// What a lead chat says, apart from how the wire carries it (chat.ts maps these onto the contracts). Written as the
// spec's lead talks: short, state first, no ids, no time estimates; questions as numbered items with a
// recommendation each; replies as terse as people type them.

export type Speaker = "you" | "lead";
export interface Line {
  readonly from: Speaker;
  readonly text: string;
}

/** The lead's question, as numbered items with a recommendation each, and the terse reply it gets. */
export const QUESTION: ReadonlyArray<Line> = [
  {
    from: "lead",
    text: [
      "Share card is built. Two calls before I ship it:",
      "",
      "1. **Copy link**: publish a frozen PNG at a public, unguessable URL, or copy the image only?",
      "   Rec: public link. Only the image is exposed, never the console.",
      "2. **Headline**: \"$200/mo plan → $1,840 of usage this week\" as you wrote it, or prorate the plan to the week (\"$46 → $1,840, 40×\")?",
      "   Rec: as you wrote it. Prorating changes the number people quote.",
    ].join("\n"),
  },
  { from: "you", text: "1 go, 2 rec" },
  { from: "lead", text: "Done: public link, literal headline. Writer is on it; review starts when the PR is up." },
];

/** Replies people actually type, and what the lead makes of them. */
export const TERSE: ReadonlyArray<Line> = [
  { from: "lead", text: "Receipts still use the old date format in two emails. Fix those too?" },
  { from: "you", text: "do it" },
  { from: "lead", text: "On it. Same PR, one more file." },
  { from: "you", text: "actually nvm the second email, it's being deleted" },
  { from: "lead", text: "Dropped it. Only the invoice email changes." },
  { from: "you", text: "ship" },
  { from: "lead", text: "Merged. CI green on main." },
];

const TOPICS = [
  ["the receipt dates", "src/checkout/receipt/formatReceiptDate.ts"],
  ["the pricing headline", "site/pricing.md"],
  ["the nightly export", "jobs/export/nightly.ts"],
  ["the checkout summary", "src/checkout/summary/Summary.tsx"],
  ["the share card", "src/share/card.tsx"],
  ["the locale tests", "src/checkout/receipt/locales.test.ts"],
] as const;

/**
 * `n` messages of an ordinary working chat, oldest first: requests, the lead's short status, the odd code block and
 * list, terse replies. Varied lengths, so a virtual list can't assume one row height.
 */
export const longChat = (n: number): Array<Line> => {
  const out: Array<Line> = [];
  for (let i = 0; out.length < n; i++) {
    const [topic, file] = TOPICS[i % TOPICS.length] ?? TOPICS[0];
    const round = Math.floor(i / TOPICS.length) + 1;
    out.push({ from: "you", text: i % 5 === 0 ? `can you look at ${topic} again` : `next: ${topic}, round ${String(round)}` });
    out.push({
      from: "lead",
      text:
        i % 4 === 0
          ? `Looking. ${topic[0]?.toUpperCase() ?? ""}${topic.slice(1)} touches \`${file}\`; one writer, one reviewer.`
          : i % 4 === 1
            ? `Writer started on ${topic}.\n\n- tests first\n- then the change\n- review when the PR is up`
            : i % 4 === 2
              ? `Review asked for one change:\n\n\`\`\`ts\nexport const formatReceiptDate = (d: Date, locale: string) =>\n  new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);\n\`\`\`\n\nWriter is applying it.`
              : `Merged ${topic}. CI green.`,
    });
    if (i % 7 === 3) out.push({ from: "you", text: "ok" });
    if (i % 11 === 6) out.push({ from: "lead", text: "Nothing waiting on you. Two agents working." });
  }
  return out.slice(0, n);
};

/** The lead's message being written right now: what has streamed so far. */
export const STREAMING_SO_FAR = "Both reviews are in. The first one passed; the second wants the locale tests to cover en-GB and de-DE before";

/** What streams in after it, one append per frame; the message is still unfinished at the end. */
export const STREAMING_REST = [
  " it approves.",
  "\n\nThe writer is adding them now:\n\n",
  "- `en-GB`: 19 Oct 2026\n",
  "- `de-DE`: 19.10.2026\n",
  "\nCI runs again when they're in. Nothing needs you",
];

/** Orders from before the chat, as the migration shows them: what was asked, and how it ended. */
export const MIGRATED: ReadonlyArray<{ readonly asked: string; readonly outcome: string }> = [
  { asked: "Move invoice and receipt dates from moment to Intl, with tests for every locale we ship", outcome: "Done: 2 PRs merged." },
  { asked: "Rewrite the pricing headline from the copy review", outcome: "Done: 1 PR merged." },
  { asked: "Make the nightly export resumable after a crash", outcome: "Stopped by you; kept for later." },
];
