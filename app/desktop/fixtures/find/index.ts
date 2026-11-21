// The chat's search and pins (W773), on storefront's chat: find-search, a hub that serves both with nothing pinned, whose
// chat_find answers any words with the hits for "deploy" and "kiwi" with none; find-pin-one, one pinned message (the
// capsule opens the chat at it); find-pins, three (the capsule opens the panel's Pinned list).
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { type Draft, writeChat } from "../kit/chat.ts";
import { at } from "../kit/ids.ts";
import type { JsonObject } from "../kit/json.ts";
import { AGENT } from "../agents/route.ts";

const STOREFRONT = { machineId: AGENT.machineId, projectId: AGENT.projectId };
const ADA = { personId: "p_adaadaad", name: "Ada Okafor" };

// Short enough to fit the smallest window whole: nothing scrolls under the top row's banners.
const drafts: Draft[] = [
  { author: "human", text: "where do we deploy from these days?", minutesAgo: 60 * 24 * 40 },
  { author: "lead", text: "From main: a green CI there deploys to production in a few minutes.", minutesAgo: 60 * 24 * 40 - 1 },
  { author: "human", text: "the staging password rotates on Fridays", minutesAgo: 60 * 24 * 21 },
  { author: "lead", text: "Noted. Three things before launch: the live keys, one last deploy, a smoke test.", minutesAgo: 88 },
  { author: "human", text: "keys are in, go ahead", minutesAgo: 20 },
  { author: "lead", text: "On it. I deploy once the copy PR merges.", minutesAgo: 19 },
];

/** The hits for `word`: each message holding it, newest first, as chat_find shows them. */
const hitsFor = (messages: ReadonlyArray<JsonObject>, word: string): JsonObject[] =>
  messages
    .filter((m) => typeof m["text"] === "string" && (m["text"]).toLowerCase().includes(word))
    .toReversed()
    .map((m) => {
      const text = (m["text"] as string).replace(/\s+/gu, " ").trim();
      const marks: [number, number][] = [];
      const lower = text.toLowerCase();
      for (let i = lower.indexOf(word); i >= 0; i = lower.indexOf(word, i + word.length)) {
        if (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1] ?? "")) marks.push([i, i + word.length]);
      }
      return {
        messageId: m["messageId"],
        seq: m["seq"],
        createdAt: m["createdAt"],
        author: m["author"],
        ...(m["author"] === "human" ? { person: ADA } : {}),
        text: text.length > 160 ? `${text.slice(0, 159)}…` : text,
        marks,
      } as JsonObject;
    })
    .filter((h) => (h["marks"] as unknown[]).length > 0);

const pinOf = (m: JsonObject, minutesAgo: number, now: string): JsonObject => ({
  messageId: m["messageId"] as string,
  seq: m["seq"] as number,
  pinnedAt: at(now, -minutesAgo * 60_000),
  pinnedBy: ADA,
  author: m["author"] as string,
  ...(m["author"] === "human" ? { person: ADA } : {}),
  createdAt: m["createdAt"] as string,
  text: ((m["text"] as string).split("\n").find((l) => l.trim() !== "") ?? "").trim(),
});

const make = (base: Fixture, name: string, note: string, pinned: readonly number[]): Fixture => {
  const f = Fixture.from(base, name, note);
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "chat_find_pins"] };
  const messages = writeChat(f, STOREFRONT, drafts.map((d) => (d.author === "human" ? { ...d, extra: { person: ADA } } : d)));
  const hits = hitsFor(messages, "deploy");
  f.answer("chat_find", { projectRef: STOREFRONT }, { hits, more: false, count: hits.length });
  f.answer("chat_find", { projectRef: STOREFRONT, words: "kiwi" }, { hits: [], more: false, count: 0 });
  const pins = pinned.flatMap((i, n) => {
    const m = messages[i];
    return m === undefined ? [] : [pinOf(m, 30 + n * 600, f.now)];
  });
  f.answer("chat_message_pins", { projectRef: STOREFRONT }, { pins });
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    make(base("many-agents"), "find-search", "Search and pins: storefront's chat, searchable, nothing pinned; any words find the deploy messages, kiwi finds none.", []),
    make(base("many-agents"), "find-pin-one", "Search and pins: one pinned message, the lead's launch list.", [3]),
    make(base("many-agents"), "find-pins", "Search and pins: three pinned messages, newest pinned first.", [3, 2, 1]),
  ],
});
