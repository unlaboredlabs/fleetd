// What there is to look at (fixtures/look): storefront's lead flagged its Machines page redesign and the German
// checkout to try for your look; the lead waits on nothing, so the line above the box says "2 to look at" and names
// the oldest.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject, writeChat } from "../kit/chat.ts";
import { arr, obj } from "../kit/stress.ts";

const LATER: ReadonlyArray<readonly ["human" | "lead", string]> = [
  ["lead", "The receipts change merged, it's on staging."],
  ["human", "Did the search fix go out with it?"],
  ["lead", "Yes, both in the same deploy."],
  ["human", "Nice. Can receipts show the shop's address too?"],
  ["lead", "Yes, from the shop settings. One writer, small."],
  ["human", "go"],
  ["lead", "On it."],
  ["human", "And the footer link to the returns page is broken on mobile."],
  ["lead", "Seen it: the link points at the old path. Folding it into the same writer's work."],
  ["human", "👍"],
  ["lead", "The address is on receipts in review, with the footer fix."],
  ["human", "Thanks. What's left for the checkout?"],
  ["lead", "Only the German and Dutch copy, which is the PR to try. Everything else is merged."],
];

const two = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "look-two", "storefront's lead flagged its Machines page redesign and #14 to try: 2 to look at, nothing waiting on you.");
  const ref = firstProject(f);
  const at = (minutesAgo: number) => new Date(Date.parse(f.now) - minutesAgo * 60_000).toISOString();
  const messages = writeChat(f, ref, [
    { author: "human", text: "How is the Machines page coming along?", minutesAgo: 52 },
    { author: "lead", text: "Almost there: the writer is on the last row's details.", minutesAgo: 50 },
    {
      author: "lead",
      text: "The Machines page redesign is up: a row per machine, its details a click away, and nothing pulsing. Have a look at #31 before it merges.",
      minutesAgo: 24,
    },
    { author: "lead", text: "#14's writer suggests trying #14: the checkout's buttons read differently in German and Dutch", minutesAgo: 12 },
    // The conversation went on since, so both are above what is on screen.
    ...LATER.map(([author, text], i) => ({ author, text, minutesAgo: 10 - i / 2 })),
  ]);
  const flag = (i: number, reason: string, minutesAgo: number) => {
    const m = obj(messages[i]);
    m["nudge"] = { reason, at: at(minutesAgo) };
    return { messageId: m["messageId"] ?? "", reason, at: at(minutesAgo) };
  };
  const nudges = [flag(2, "the Machines page redesign", 24), flag(3, "Try #14: the checkout's buttons read differently in German and Dutch", 12)];
  // The chat state the pages and the snapshot share.
  for (const c of arr(f.snapshot?.["chats"])) {
    const state = obj(c);
    if (obj(state["projectRef"])["projectId"] === ref.projectId) state["nudges"] = nudges;
  }
  // Seen or dismissed, each clears.
  f.answer("chat_nudge_clear", undefined, { ok: true });
  return f;
};

export default defineGroup({
  fixtures: (base) => [two(base("typical"))],
});
