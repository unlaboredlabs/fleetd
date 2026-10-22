// The disk cache (src/renderer/src/data/cache.ts's HubCache) an earlier launch left, made from a fixture's own data,
// for the fixtures that show what is held from before.
import { firstProject } from "../kit/chat.ts";
import type { Fixture } from "../kit/fixture.ts";
import { at } from "../kit/ids.ts";
import type { JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { OFFLINE_SENDS } from "./sends.ts";

/** The cache as the earlier launch left it, for `hub`: the link dropped 30 s before the fixture's now. */
export const heldCache = (f: Fixture, hub: string, queued = true): JsonObject => {
  const ref = firstProject(f);
  const key = `${ref.machineId}/${ref.projectId}`;
  const page = obj(f.output("chat_history", { projectRef: { ...ref } }));
  // The link dropped just after the lead's last message; the queued one was written after that.
  const asOf = at(f.now, -30_000);
  return {
    version: 1,
    hub,
    asOf,
    projects: arr(f.snapshot?.["projects"]),
    chatStates: arr(f.snapshot?.["chats"]),
    chats: [{ key, messages: arr(page["messages"]), hasOlder: page["moreBefore"] === true }],
    sends: queued
      ? { [key]: [{ clientRequestId: "offline-1", text: OFFLINE_SENDS.queued, attachments: [], at: at(asOf, 15_000), state: { t: "queued" } }] }
      : {},
  };
};
