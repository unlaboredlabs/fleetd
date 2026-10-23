// The lead chat while you read back: chat-long, where three replies from the lead arrive once you've scrolled up far
// enough to read the second page before the newest (the first may load as the chat opens), so the way back down
// counts them.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { firstProject, PAGE } from "../kit/chat.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

const REPLIES = [
  "The share card is up for review, with this week’s usage.",
  "The public link is read-only and needs no login.",
  "Tests pass on both. Nothing needs you yet.",
];

function newBelow(f: Fixture): Fixture {
  const ref = firstProject(f);
  const projectRef = { ...ref };
  const newest = arr(obj(f.output("chat_history", { projectRef }))["messages"]).filter(isObject);
  const before = Number(newest[0]?.["seq"]) - PAGE;
  const last = Number(newest.at(-1)?.["seq"]);
  if (!Number.isFinite(before) || !Number.isFinite(last)) throw new Error(`${f.name}: storefront's chat has no newest page`);
  const frames = REPLIES.map((text, i) => {
    const seq = last + i + 1;
    const message: JsonObject = { messageId: `m${String(seq)}`, projectRef, seq, author: "lead", text, attachments: [], createdAt: at(f.now, -15_000 + i * 2_000), state: "final" };
    const event: JsonObject = {
      seq: 100_000 + i,
      at: message["createdAt"] ?? f.now,
      type: "chat.message",
      summary: "The lead in the chat",
      machineId: ref.machineId,
      projectId: ref.projectId,
      data: { projectRef, messageId: message["messageId"] ?? "", seq, author: "lead", state: "final", message },
    };
    return { ms: 200 + i * 100, kind: "event" as const, payload: event };
  });
  f.then("chat_history", { projectRef, before }, { frames });
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    newBelow(Fixture.from(base("chat-long"), "transcript-new", "storefront's long chat; three lead replies arrive once you've scrolled up to the page before the newest.")),
  ],
});
