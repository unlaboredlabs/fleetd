// The lead chat's messages (A2), on the typical hub's first project:
// - chat-long: three pages of conversation, so scrolling up pages older ones in, with days, runs, code and lists;
// - chat-streaming: the lead mid-reply (its newest message still streaming);
// - chat-attachments: messages carrying files and pasted images;
// - chat-migrated: history from before the chat (old orders, a note, a steer, an outcome), then the chat itself.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

const PAGE = 50;

/** The first project of the base's snapshot, as the chat route names it. */
const firstProject = (f: Fixture): { machineId: string; projectId: string } => {
  const p = obj(arr(f.snapshot?.["projects"])[0]);
  return {
    machineId: typeof p["machineId"] === "string" ? p["machineId"] : "devbox",
    projectId:
      typeof p["projectId"] === "string" ? p["projectId"] : "storefront",
  };
};

interface Msg {
  readonly author: "human" | "lead" | "system";
  readonly text: string;
  readonly minutesAgo: number;
  readonly streaming?: boolean;
  readonly history?: string;
  readonly attachments?: readonly File[];
}

interface File {
  readonly attachmentId: string;
  readonly name: string;
  readonly mime: string;
  /** Standard base64; an image's bytes, answered by attachment_get. */
  readonly dataB64?: string;
  readonly bytes?: number;
}

// Two small generated PNGs: a phone page with a dark footer bar, and a pasted screenshot of one blue bar.
const PHONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAALQAAAFACAIAAACa28HeAAACWElEQVR42u3coQ0AIRBFQcpBIOm/EgSKIlA0sGiyZF5+BZdRF7JlS5eKTyA4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcEhyCQ3AIDsEhOASH4BAc+h/HmMssHBwGh8FhcBgcBofBYXAYHAaHwWEGh8FhcBgcBofBYXBYehxeSsoDY8EhOASH4BAcgkNwCA7BIcEhOASH4BAcgkNwCA7BITgkOASH4BAcgkNwCA7BITgEh+Q+hzneYnAYHAaHwWFwGBwGh7lDKr/PJTgEh+AQHIJDcAgOwSE4BIcEh+AQHIJDcAgOwSE4BIfgkOAQHIJDcAgOwSE4BIfgEByCQ4JDcAgOwSE4BIfgEByCQ3BIcAgOwSE4BIfgEByCQ3AIDgkOwSE4BIfgEByCQ3AIDsEhOCQ4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcgkOCQ3AIDsEhOASH4BAcgkNwSHAIDsEhOASH4BAcgkNwCA4JDsEhOASH4BAcgkNwCA7BITgkOASH4BAcgkNwCA7BITgEhwSH4BAcgkNwCA7BITgEh+CQ4BAcgkNwCA7BITgEh+AQHIJDgkNwCA7BITgEh+AQHIJDcEhwCA7BITj0AEdt3SwcHAaHwWFwGBwGh8FhcBgcBofBYQaHwWFwGBwGh8FhcBgcBofBYQaHwWFwGBwGh8FhcBgcBofBYQaHwWFwGBwGh8FhcBgcBofBYXCYwWFwGBwGh8FhcFiWHTDJ1O+dDd1WAAAAAElFTkSuQmCC";
const PASTED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAABPElEQVR42u3cQQ0AIAwEwapDExJrCMITEzwKTDIKLvu+GHPBM8IECBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0CJo/gm494ThBI2hBI2hBI2gQNIIWNIIWNIIWNIIGQSNoQSNoQSNoQSNoEDSCFjSCFjSCBkGDoBG0oBG0oBE0CBoEjaAFjaAFjaDh2qD9VeJOFwQNggZBI2gQNAgaBA2CRtAgaBA0CBoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkEjaBA0CBoEDYJG0CBoEDQIGgSNoEHQIGgQNAgaQYOgQdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0CBpBg6ChgA3CkBMdFaMDdwAAAABJRU5ErkJggg==";

const decodedBytes = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) -
  (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
const fileRef = (a: File): JsonObject => ({
  attachmentId: a.attachmentId,
  name: a.name,
  mime: a.mime,
  bytes: a.bytes ?? (a.dataB64 ? decodedBytes(a.dataB64) : 0),
});

const HUMAN = [
  "Make the receipt dates use the customer's locale.",
  "1 go, 2 rec",
  "do it",
  "Why is the checkout total off by a cent on refunds?",
  "nvm, ship it as is",
  "Can you check the share card on a narrow phone?",
];
const LEAD = [
  "On it. Two writers: one for the formatting, one for the tests. I'll come back when the PRs are in review.",
  "Both PRs are in review. CI is green on the first; the second waits for a rebase.",
  "Found it: refunds round each line, then sum. I changed it to sum, then round once.\n\n```ts\nconst total = round(lines.reduce((s, l) => s + l.amount, 0));\n```",
  "Two things before I go on:\n\n1. Keep the old date format behind a setting? **Rec:** no, nobody asked for it.\n2. Backfill old receipts? **Rec:** no, only new ones.\n\nReply like `1 no, 2 rec`.",
  "Merged. The train took both PRs in order; nothing is left on this.",
];

function message(f: Fixture, ref: JsonObject, seq: number, m: Msg): JsonObject {
  const created = at(f.now, -m.minutesAgo * 60_000);
  return {
    messageId: `m${String(seq)}`,
    projectRef: ref,
    seq,
    author: m.author,
    text: m.text,
    createdAt: created,
    state: m.streaming === true ? "streaming" : "final",
    ...(m.attachments ? { attachments: m.attachments.map(fileRef) } : {}),
    ...(m.history ? { history: m.history } : {}),
    ...(m.author === "human" ? { by: "your console", delivery: "turn" } : {}),
  };
}

/** Answers chat_history for the newest page and every older page, as the hub pages (oldest first in each). */
function withChat(
  f: Fixture,
  msgs: readonly Msg[],
  state: Partial<JsonObject> = {},
): Fixture {
  const ref = firstProject(f) as unknown as JsonObject;
  const all = msgs.map((m, i) => message(f, ref, i + 1, m));
  const chatState = {
    projectRef: ref,
    lastSeq: all.length,
    leadWorking: false,
    needsYou: false,
    ...(all.length > 0
      ? { lastMessageAt: all.at(-1)?.["createdAt"] as JsonValue }
      : {}),
    ...state,
  };
  const page = (end: number): JsonObject => {
    const from = Math.max(0, end - PAGE);
    return {
      messages: all.slice(from, end),
      moreBefore: from > 0,
      moreAfter: end < all.length,
      state: chatState,
    };
  };
  f.answer("chat_history", { projectRef: ref, limit: PAGE }, page(all.length));
  for (const a of msgs.flatMap((m) => m.attachments ?? []))
    if (a.dataB64 !== undefined)
      f.answer(
        "attachment_get",
        { projectRef: ref, attachmentId: a.attachmentId },
        { ...fileRef(a), dataB64: a.dataB64 },
      );
  for (let end = all.length - PAGE; end > 0; end -= PAGE)
    f.answer(
      "chat_history",
      { projectRef: ref, before: end + 1, limit: PAGE },
      page(end),
    );
  return f;
}

function longChat(n: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) {
    const minutesAgo = (n - i) * 47;
    if (i % 9 === 4)
      out.push({
        author: "system",
        text: `#${String(200 + i)} merged: receipt dates use the customer's locale`,
        minutesAgo,
      });
    else if (i % 2 === 0)
      out.push({
        author: "human",
        text: HUMAN[i % HUMAN.length] ?? "",
        minutesAgo,
      });
    else
      out.push({
        author: "lead",
        text: LEAD[i % LEAD.length] ?? "",
        minutesAgo,
      });
  }
  return out;
}

export default defineGroup({
  fixtures: (base) => [
    withChat(
      Fixture.from(
        base("typical"),
        "chat-long",
        "The lead chat with three pages of history: days, runs, code, lists, merge one-liners.",
      ),
      longChat(130),
    ),
    withChat(
      Fixture.from(
        base("typical"),
        "chat-streaming",
        "The lead mid-reply: its newest message is still streaming.",
      ),
      [
        {
          author: "human",
          text: "Why is the checkout total off by a cent on refunds?",
          minutesAgo: 4,
        },
        {
          author: "lead",
          text: "Looking. The refund path rounds each line first, then sums them, so the totals",
          minutesAgo: 1,
          streaming: true,
        },
      ],
      { leadWorking: true },
    ),
    withChat(
      Fixture.from(
        base("typical"),
        "chat-attachments",
        "Messages carrying files and pasted images.",
      ),
      [
        {
          author: "human",
          text: "Here's the footer on my phone; it's cut. The log is attached too.",
          minutesAgo: 30,
          attachments: [
            {
              attachmentId: "F11",
              name: "footer-on-phone.png",
              mime: "image/png",
              dataB64: PHONE_PNG,
            },
            {
              attachmentId: "F12",
              name: "checkout-refunds.log",
              mime: "text/plain",
              bytes: 18_432,
            },
          ],
        },
        {
          author: "lead",
          text: "Got it. The footer clips at 360 px; the writer wraps it and adds a test at that width.",
          minutesAgo: 28,
        },
        {
          author: "human",
          text: "",
          minutesAgo: 10,
          attachments: [
            {
              attachmentId: "F13",
              name: "pasted-1.png",
              mime: "image/png",
              dataB64: PASTED_PNG,
            },
          ],
        },
      ],
    ),
    withChat(
      Fixture.from(
        base("typical"),
        "chat-migrated",
        "History from before the chat (old orders, a note, a steer, an outcome), then the chat.",
      ),
      [
        {
          author: "human",
          text: "Add a share card to the console: tokens in the last 7 days.",
          minutesAgo: 3000,
          history: "order",
        },
        {
          author: "lead",
          text: "Froze the brief: a share card with a public snapshot link. Two writers started.",
          minutesAgo: 2990,
          history: "lead_message",
        },
        {
          author: "human",
          text: "Keep the headline literal; no prorated variant.",
          minutesAgo: 2980,
          history: "steer",
        },
        {
          author: "system",
          text: "Share card on the console: finished, both PRs merged.",
          minutesAgo: 2900,
          history: "order_outcome",
        },
        {
          author: "human",
          text: "Now make the receipt dates use the customer's locale.",
          minutesAgo: 20,
        },
        {
          author: "lead",
          text: "On it. I'll come back when the PR is in review.",
          minutesAgo: 18,
        },
      ],
    ),
  ],
});
