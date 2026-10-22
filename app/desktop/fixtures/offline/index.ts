// Offline (proposal item 7): an earlier launch's disk cache (src/renderer/src/data/cache.ts) holds the project list
// and storefront's chat, with one message written after the link dropped, waiting to go.
// - offline-held: the saved hub doesn't answer. The app shows the cache marked offline as of its time, and the
//   banner has Retry now. QA types another message offline, which joins the queue, and presses Retry now, which
//   starts an attempt that keeps running (qa/registry.ts).
// - offline-reread: the hub answers again, but storefront's chat hasn't been read on this connection yet: it stays
//   marked as last known, never as current.
// - offline-reread-failed: that read failed, so the chat says why, with Retry.
import { firstProject } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { heldCache } from "./held.ts";
import { OFFLINE_SENDS } from "./sends.ts";

/** When the reconnect's snapshot lands: after the window has shown the cache, as when the hub comes back later. */
const BACK_MS = 1200;

/**
 * Back online: the snapshot (and the base's events and live frames after it) arrive BACK_MS after the window
 * subscribed, so the cache is on screen first, as the held chat of a reconnect; storefront's newest page then waits
 * on `history`.
 */
const reread = (base: Fixture, name: string, note: string, history: (f: Fixture, input: JsonObject) => void): Fixture => {
  const f = Fixture.from(base, name, note);
  const hub = f.state.phase === "live" ? f.state.hub : "";
  f.cache = heldCache(f, hub);
  const input = { projectRef: { ...firstProject(f) } };
  const snapshot = f.snapshot;
  if (snapshot !== undefined) f.later(BACK_MS, "snapshot", snapshot);
  for (const e of f.events) f.later(BACK_MS, "event", e);
  for (const l of f.live) f.later(BACK_MS, "live", l);
  f.snapshot = undefined;
  f.events = [];
  f.live = [];
  history(f, input);
  // The queued message goes on the reconnect and the hub takes it: it shows in the held chat as sent.
  const page = obj(f.output("chat_history", input));
  const last = arr(page["messages"]).filter((m) => obj(m)["seq"] !== undefined).at(-1);
  const seq = typeof obj(last)["seq"] === "number" ? (obj(last)["seq"] as number) + 1 : 1;
  f.answer("chat_send", { clientRequestId: "offline-1" }, {
    message: {
      messageId: `m${String(seq)}`,
      projectRef: input["projectRef"],
      seq,
      author: "human",
      text: OFFLINE_SENDS.queued,
      createdAt: f.now,
      state: "final",
      by: "laptop",
      clientRequestId: "offline-1",
      delivery: "turn",
    },
  });
  return f.settleAt(BACK_MS + 1300);
};

export default defineGroup({
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("chat-long"), "offline-held", "The hub doesn't answer; the last launch's cache holds the projects and storefront's chat, with one message queued.");
      const down = base("hub-unreachable").state;
      // The next attempt counted from this fixture's own clock, not the base's.
      f.state = down.phase === "retrying" ? { ...down, retryAt: Date.parse(f.now) + 8000 } : down;
      f.cache = heldCache(f, f.state.phase === "retrying" ? f.state.hub : "");
      return f;
    })(),
    reread(base("chat-long"), "offline-reread", "Back online; storefront's chat from the cache isn't read again yet, so it is marked as last known.", (f, input) => {
      const page = f.output("chat_history", input);
      // Longer than any QA run: the read is still out when the shot is taken.
      if (page !== undefined) f.answer("chat_history", input, page, 600_000);
    }),
    reread(base("chat-long"), "offline-reread-failed", "Back online; reading storefront's chat again failed, so it stays marked as last known, with why and Retry.", (f, input) => {
      f.fail("chat_history", input, { code: "timeout", message: "The hub didn't answer chat_history within 15 s." });
    }),
  ],
});
