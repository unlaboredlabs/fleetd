// A long lead reply streaming in (UX-1 [23]): storefront's lead writes a plan of headings, lists, code, a table and a
// quote, in many small deltas over the live chat feed, and is still writing at the last one. The chat redraws only the
// reply's last block per delta; this is the screen that must stay right while it does.
import { fromLines, firstProject, streamReply, writeChat } from "../kit/chat.ts";
import { QUESTION } from "../kit/chatText.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";

const REPLY = `Here's the plan for the receipts, step by step. Two agents are already on the first part.

## 1. Dates and totals

The receipt shows the date and the total on one line, and on a narrow screen the date wraps under the total. The writer is moving them onto two lines, with the total right-aligned so the amounts line up.

- en-GB: 19 Oct 2026
- de-DE: 19.10.2026
- ja-JP: 2026/10/19

Totals round the half cent the way the payment provider does, so a receipt never disagrees with the bank statement:

\`\`\`ts
export function roundTotal(cents: number): number {
  const whole = Math.floor(cents);
  const frac = cents - whole;

  // Half a cent goes to the even neighbour, as the provider rounds.
  if (frac === 0.5) return whole % 2 === 0 ? whole : whole + 1;
  return Math.round(cents);
}
\`\`\`

## 2. Discounts

Discounts use the same rounding. Today they round each line first and then add, which can be a cent off on a long order. After the change:

| Order | Before | After |
| --- | --- | --- |
| 3 × 0.335 | 1.02 | 1.01 |
| 7 × 1.125 | 7.91 | 7.88 |
| 12 × 0.005 | 0.12 | 0.06 |

1. Add the line amounts unrounded.

2. Round the sum once, with \`roundTotal\`.

3. Show each line rounded for display only.

> The reviewer asked whether old receipts change. They don't: a receipt keeps the total it was issued with, and only new orders use the new rounding.

## 3. Tests

The verifier runs the receipt tests in all three locales, on a phone-sized window and on a wide one, and checks the PDF export against the screen. If any of them fails I'll say which and what it saw.

Once both PRs are green they go in one after the other, dates first. Nothing needs you yet. I'll write again when the first PR is up, and when the verifier has the screenshots for you to look at`;

/** The reply in deltas of about the size a model streams: a few words each. */
const deltas = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const SO_FAR = 220;

export default defineGroup({
  fixtures: (base) => {
    const f = Fixture.from(base("chat-streaming"), "stream-long", "A long lead reply streams in over the live chat feed in small deltas, headings, lists, code, a table and a quote, and is still unfinished at the last one.");
    f.timeline = f.timeline.filter((t) => t.kind !== "chat_delta");
    f.settleMs = undefined;
    const ref = firstProject(f);
    writeChat(f, ref, [...fromLines(QUESTION), { author: "human", text: "sounds good, go ahead and tell me the plan" }, { author: "lead", text: REPLY.slice(0, SO_FAR), state: "streaming" }], { leadWorking: true });
    return [streamReply(f, ref, deltas(REPLY.slice(SO_FAR), 24), 25)];
  },
});
