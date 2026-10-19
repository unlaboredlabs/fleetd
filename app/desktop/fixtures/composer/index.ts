// The chat composer's fixture (A3): storefront's lead chat, the lead mid-turn, and chat_send answers that leave a
// message refused, cut off by the link, unanswered, sent to a lead that can't take it yet, still sending, or unsent
// for want of a hub. QA types each (qa/registry.ts, CHAT_SENDS).
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { arr, obj } from "../kit/stress.ts";
import { asText, type JsonObject } from "../kit/json.ts";
import { CHAT_SENDS } from "./sends.ts";

const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" } as const;

function composerSends(f: Fixture): void {
  const t = (s: number) => at(f.now, -s * 1000);
  const msg = (seq: number, author: "human" | "lead", text: string, s: number, over: JsonObject = {}): JsonObject => ({
    messageId: `m${seq}`,
    projectRef: STOREFRONT,
    seq,
    author,
    text,
    createdAt: t(s),
    state: "final",
    ...(author === "human" ? { by: "laptop", clientRequestId: `seed-${seq}`, delivery: "turn" } : {}),
    ...over,
  });
  const messages = [
    msg(1, "human", "Make the share card show this week’s usage, and a public link for it.", 600),
    msg(
      2,
      "lead",
      "On it. Two calls first:\n\n1. Public link without a login? I recommend yes, read-only.\n2. Headline: the literal number, or a rounded one? I recommend literal.",
      560,
    ),
    msg(3, "human", "1 yes, 2 literal", 500, { delivery: "steer" }),
    msg(4, "lead", "Building it: the card, the public route, and tests. I’ll say when there’s a PR.", 480),
  ];
  const state = { projectRef: STOREFRONT, lastSeq: 4, leadWorking: true, needsYou: false, lastMessageAt: t(480) };
  f.answer("chat_history", { projectRef: STOREFRONT }, { messages, moreBefore: false, moreAfter: false, state });
  // The lead is mid-turn on the live feed too, so the box reads as a steer.
  f.live = f.live.map((frame) => ({
    ...frame,
    lanes: arr(frame["lanes"]).map((l) => (asText(obj(l)["laneId"]).startsWith(`lead:${STOREFRONT.machineId}/${STOREFRONT.projectId}`) ? { ...obj(l), status: "working" } : l)),
  }));

  const sent = (seq: number, text: string): JsonObject => msg(seq, "human", text, 0, { clientRequestId: `qa-${seq}`, delivery: "queued" });
  f.fail("chat_send", { text: CHAT_SENDS.refused }, { code: "forbidden", message: "This key can read the fleet but can’t send to its leads." });
  f.fail("chat_send", { text: CHAT_SENDS.cutOff }, { code: "disconnected", message: "The app disconnected from the hub." });
  f.fail("chat_send", { text: CHAT_SENDS.unanswered }, { code: "timeout", message: "The hub didn’t answer chat_send within 15 s." });
  f.fail("chat_send", { text: CHAT_SENDS.offline }, { code: "offline", message: "Not connected to the hub." });
  f.answer("chat_send", { text: CHAT_SENDS.waiting }, { message: sent(5, CHAT_SENDS.waiting), leadWaiting: "devbox is offline; it starts when devbox is back." });
  f.answer("attachment_put", undefined, { attachmentId: "att-qa-1", bytes: 68, sha256: "0".repeat(64) });
  // Still on its way when the shot is taken; the screen doesn't wait for it.
  f.answer("chat_send", { text: CHAT_SENDS.sending }, { message: sent(6, CHAT_SENDS.sending) }, 600_000);
  f.settleAt(f.settleMs ?? 0);
}

export default defineGroup({
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("typical"), "composer-sends", "storefront's lead chat with the lead mid-turn, and a chat_send answer for every way a message can fail to reach it.");
      composerSends(f);
      return f;
    })(),
    (() => {
      // The same, apart: a message the hub took for a lead that can't take it yet shows why only as your latest.
      const f = Fixture.from(base("typical"), "composer-waiting", "storefront's lead chat; the next message is stored, but the lead's machine is offline.");
      composerSends(f);
      return f;
    })(),
  ],
});
