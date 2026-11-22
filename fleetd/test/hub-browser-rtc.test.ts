// The hub's half of screens peer to peer (src/hub/browser/app.ts `browser_rtc`): an offer goes on to the screen's
// node with whether its input may drive the screen, the answer comes back to the one app, a watch on its peer takes no
// frames through the hub and tells the node to send none while every watcher has one, and the peer ends with the
// app's socket or the node's link.
import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { live } from "../src/hub/browser/live.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { addMachine, addProject, agent, as, caller, fakeSocket, testHub } from "./screens_helpers.ts";

const S1 = "B11111111111111111111111111111111";
let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

async function setup(caps = ["browser", "session_end", "browser_rtc"]) {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox");
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", caps);
  await t.calls.call(agent("devbox", "p1"), {
    op: "browser_session",
    sessionId: S1,
    threadId: "t1",
    purpose: "check the page",
    state: "live",
    control: "agent",
    startedAt: "2026-11-08T12:00:00.000Z",
  });
  return t;
}

const of = (tag: string) => t.link.sent("devbox").filter((f) => f.t === tag);
const frame = (seq: number) => ({ t: "browser_frame", sessionId: S1, seq, jpegB64: "AAAA", width: 1, height: 1, control: "agent" });

test("an offer goes to the node and its answer back to that app; a watch on the peer gets no frames here", async () => {
  await setup();
  const person = caller("operate", { kind: "human" });
  const app = fakeSocket();
  const other = fakeSocket();
  await t.app.deliver(as(app, person), { t: "browser_watch", session: S1, acks: true, video: true });
  await t.app.deliver(as(other, person), { t: "browser_watch", session: S1, acks: true, video: true });
  await t.app.deliver(as(app, person), { t: "browser_rtc", session: S1, peer: "a1", offer: "v=0 offer" });
  const offer = of("browser_rtc").at(-1) as unknown as { peer: string };
  expect(offer as unknown).toEqual({ t: "browser_rtc", sessionId: S1, peer: offer.peer, offer: "v=0 offer", input: true });
  t.link.deliver("devbox", { t: "browser_rtc", sessionId: S1, peer: offer.peer, answer: "v=0 answer" });
  expect(app.sent.at(-1)).toEqual({ t: "browser_rtc", session: S1, peer: "a1", answer: "v=0 answer" });
  expect(other.sent).toEqual([]);

  // The app has its first frame on the peer: the same watch again, with `rtc`, only moves it there.
  const asked = of("browser_watch").length;
  await t.app.deliver(as(app, person), { t: "browser_watch", session: S1, acks: true, video: true, rtc: "a1" });
  // Another watcher still takes frames here: the node keeps sending them.
  expect(of("browser_watch").slice(asked)).toEqual([{ t: "browser_watch", sessionId: S1, on: true, video: true }]);
  t.link.deliver("devbox", frame(1));
  expect(app.sent.filter((f) => (f as { t: string }).t === "browser_frame")).toEqual([]);
  expect(other.sent.filter((f) => (f as { t: string }).t === "browser_frame")).toHaveLength(1);
  // The last watcher through the hub goes: the node sends no frames here.
  t.app.close(other);
  expect(of("browser_watch").at(-1)).toEqual({ t: "browser_watch", sessionId: S1, on: true, video: true, relay: false });
  expect(live(t.hub).watchers(S1)).toBe(1);

  // The peer stalls: the app takes its frames here again, from a whole picture, and the node sends them again.
  await t.app.deliver(as(app, person), { t: "browser_watch", session: S1, acks: true, video: true });
  expect(of("browser_watch").slice(-2)).toEqual([
    { t: "browser_watch", sessionId: S1, on: true, video: true },
    { t: "browser_watch", sessionId: S1, on: true, video: true, key: true },
  ]);
  t.link.deliver("devbox", frame(2));
  expect(app.sent.filter((f) => (f as { t: string }).t === "browser_frame")).toHaveLength(1);

  // The socket closes: the node closes the peer.
  t.app.close(app);
  expect(of("browser_rtc").at(-1)).toEqual({ t: "browser_rtc", sessionId: S1, peer: offer.peer });
});

test("a read key's peer carries no input; a node too old for peers is refused, and the app stays on the socket", async () => {
  await setup(["browser", "session_end"]);
  const app = fakeSocket();
  await t.app.deliver(as(app, caller("operate", { kind: "human" })), { t: "browser_rtc", session: S1, peer: "a1", offer: "o" });
  expect(app.sent.at(-1)).toMatchObject({ t: "browser_rtc", session: S1, peer: "a1", error: expect.stringContaining("too old") });
  expect(of("browser_rtc")).toEqual([]);

  t.link.link("devbox", ["browser", "browser_rtc"]);
  const reader = fakeSocket();
  await t.app.deliver(as(reader, caller("read", { kind: "human" })), { t: "browser_rtc", session: S1, peer: "r1", offer: "o" });
  expect(of("browser_rtc").at(-1)).toMatchObject({ input: false });
  const nobody = fakeSocket();
  await t.app.deliver(as(nobody, caller("read", { machines: ["elsewhere"] })), { t: "browser_rtc", session: S1, peer: "n1", offer: "o" });
  expect(nobody.sent.at(-1)).toMatchObject({ error: `No screen ${S1}.` });
});

test("the node's close reaches the app and takes its watch back through the hub; a relink ends the rest", async () => {
  await setup();
  const person = caller("operate", { kind: "human" });
  const app = fakeSocket();
  await t.app.deliver(as(app, person), { t: "browser_watch", session: S1 });
  await t.app.deliver(as(app, person), { t: "browser_rtc", session: S1, peer: "a1", offer: "o" });
  const peer = (of("browser_rtc").at(-1) as { peer: string }).peer;
  await t.app.deliver(as(app, person), { t: "browser_watch", session: S1, rtc: "a1" });
  expect(of("browser_watch").at(-1)).toMatchObject({ relay: false });
  // A person's input on the peer keeps the screen from going idle.
  t.clock.ms += 5_000;
  t.link.deliver("devbox", { t: "browser_rtc", sessionId: S1, peer, input: true });
  expect(live(t.hub).lastInput(S1)).toBe(t.clock.now());
  t.link.deliver("devbox", { t: "browser_rtc", sessionId: S1, peer, closed: true, error: "its connection failed" });
  expect(app.sent.at(-1)).toEqual({ t: "browser_rtc", session: S1, peer: "a1", error: "its connection failed" });
  expect(of("browser_watch").at(-1)).not.toMatchObject({ relay: false });
  t.link.deliver("devbox", frame(1));
  expect(app.sent.at(-1)).toMatchObject({ t: "browser_frame", seq: 1 });

  await t.app.deliver(as(app, person), { t: "browser_rtc", session: S1, peer: "a2", offer: "o" });
  t.link.link("devbox", ["browser", "browser_rtc"]);
  expect(app.sent.at(-1)).toMatchObject({ t: "browser_rtc", peer: "a2", error: expect.stringContaining("linked again") });
});
