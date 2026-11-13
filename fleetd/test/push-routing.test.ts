// Questions, cards and their pushes reach the person they are for (threads-design, "Needs-you is per person"): on a
// hub with two people, the order's starter or the person the lead was answering, not whoever wrote last.
import { afterAll, expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { chat } from "../src/hub/chat/index.ts";
import { showRequest } from "../src/hub/chat/flow.ts";
import { people } from "../src/hub/people/store.ts";
import { Follow, step } from "../src/hub/push/index.ts";
import { events } from "../src/hub/store/events.ts";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import type { PersonRef } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";
import { testHub } from "./people-kit.ts";

/** A fake push relay that keeps what it got. Never the real relay. */
const got: { token: string; ciphertext: string }[] = [];
const relayServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    got.push((await req.json()) as { token: string; ciphertext: string });
    return Response.json({ status: "sent" });
  },
});
const RELAY = `http://127.0.0.1:${relayServer.port}`;
const homes: (() => void)[] = [];
afterAll(() => {
  relayServer.stop(true);
  for (const done of homes) done();
});

const r = { machineId: "devbox", projectId: "p1" };

/** A hub with Sam (its owner) and Dana, each with a phone, a lead for project p1, and Dana's order W3. */
async function rig() {
  const home = tempHome();
  homes.push(home.done);
  const kit = testHub({ home: home.dir, url: "http://devbox:4790" });
  const { hub, call, device } = kit;
  const owner = people(hub).list(false)[0]!;
  const sam: PersonRef = { personId: owner.personId, name: owner.name };
  const d = people(hub).create("Dana Park", "member");
  const dana: PersonRef = { personId: d.personId, name: d.name };
  const phones = new Map<string, Uint8Array>();
  for (const [who, token] of [[sam, "tok-sam"], [dana, "tok-dana"]] as const) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    phones.set(token, secret);
    await call(device(undefined, who.personId, "phone"), "push_device_register", {
      platform: "ios",
      token,
      publicKey: Buffer.from(publicKeyOf(secret)).toString("base64"),
      name: "iPhone",
    });
  }
  await call(device(undefined, sam.personId), "push_relay_set", { url: RELAY });
  const c = hub.db.conn;
  c.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'lead-1', 'x', 1)");
  c.run("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (3, 'devbox', 'p1', 'open', ?1)", [
    JSON.stringify({ workstreamId: "W3", projectRef: r, title: "Search speed", source: { channel: "lead" }, startedBy: dana }),
  ]);
  const t0 = kit.clock.now();
  // The lead's run before this one ended at t0.
  c.run("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, 'thread.completed', 'devbox', ?2)", [
    t0,
    JSON.stringify({ type: "thread.completed", machineId: "devbox", threadId: "lead-1", data: { threadId: "lead-1" } }),
  ]);
  const write = (who: PersonRef, text: string, ms: number, replyTo?: string) =>
    chat(hub).add(r, { author: "human", text, person: who, delivery: "queued", createdMs: ms, ...(replyTo ? { replyTo: { messageId: replyTo, part: 0 } } : {}) })
      .message;
  /** Who each push since the last call went to, by phone, with what it said. */
  const pushed = async (cursor: number) => {
    got.length = 0;
    await step(hub, new Follow(RELAY), cursor);
    return got.map((g) => {
      const plain = openSealed(phones.get(g.token)!, Buffer.from(g.ciphertext, "base64"))!;
      const p = JSON.parse(new TextDecoder().decode(plain)) as { kind: string; body: string };
      return [g.token, p.kind, p.body];
    });
  };
  return { ...kit, sam, dana, t0, write, pushed };
}

test("the lead's question goes to the person it answered, and waits on her though someone else wrote last", async () => {
  const { hub, sam, dana, t0, write, pushed } = await rig();
  const cursor = events(hub).head();
  write(dana, "Search feels slow on my phone, can you look?", t0 + 1000);
  write(sam, "Add a price filter to search too", t0 + 1500);
  const question = chat(hub).add(r, { author: "lead", text: "Resize them on upload, or lazy-load them?", createdMs: t0 + 3000 }).message;
  expect(question.for).toEqual(dana);
  // Sam wrote last, about something else: the question still waits, and only on Dana.
  write(sam, "And keep the filter in the link", t0 + 4000);
  expect(chat(hub).state(r, false)).toMatchObject({ needsYou: true, needsYouFor: [dana.personId] });
  expect(await pushed(cursor)).toEqual([["tok-dana", "message", "Resize them on upload, or lazy-load them?"]]);
  // Her answer clears it; so would anyone's reply to the bubble.
  write(dana, "Resize", t0 + 5000);
  expect(chat(hub).state(r, false).needsYou).toBe(false);
});

test("anyone may answer a question meant for someone else by replying to it", async () => {
  const { hub, sam, dana, t0, write } = await rig();
  write(dana, "Search feels slow, can you look?", t0 + 1000);
  const question = chat(hub).add(r, { author: "lead", text: "Resize or lazy-load?", createdMs: t0 + 2000 }).message;
  write(sam, "Something else", t0 + 3000);
  expect(chat(hub).state(r, false).needsYou).toBe(true);
  write(sam, "Resize", t0 + 4000, question.messageId);
  expect(chat(hub).state(r, false).needsYou).toBe(false);
});

test("an approval card, its push and its order's landing go to the order's starter, not the last writer", async () => {
  const { hub, call, device, sam, dana, t0, write, pushed } = await rig();
  write(sam, "How much of checkout do our tests cover?", t0 + 1000);
  const cursor = events(hub).head();
  const request = approvals(hub).create({
    projectRef: r,
    workstreamId: "W3",
    kind: "approval",
    text: "Backfill the image sizes",
    gated: { argv: ["bin/resize-images", "--all"], cwd: "/srv/shop", class: "irreversible", reason: "Backfill the image sizes", timeoutSec: 600 },
    at: new Date(t0 + 2000).toISOString(),
    atMs: t0 + 2000,
  });
  await showRequest(hub, request.requestId);
  const card = chat(hub).bySource(r, `item:${request.requestId}`);
  expect(card?.for).toEqual(dana);
  const state = chat(hub).state(r, false);
  expect(state).toMatchObject({ needsYou: true, needsYouFor: [dana.personId], openItems: [{ for: dana.personId }] });
  // The open requests say whom each waits on, so an app marks only that person's.
  const listed = await call<{ requests: { requestId: string; for?: PersonRef }[] }>(device(undefined, sam.personId), "requests_list", { state: "open" });
  expect(listed.requests.map((q) => [q.requestId, q.for])).toEqual([[request.requestId, dana]]);
  events(hub).append({
    at: new Date(t0 + 3000).toISOString(),
    type: "workstream.done",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: "W3 is done: images resized on upload",
    data: { workstreamId: "W3", reason: "images resized on upload", by: "lead" },
  });
  const sent = await pushed(cursor);
  expect(sent.map(([token, kind]) => [token, kind])).toEqual([
    ["tok-dana", "approval"],
    ["tok-dana", "order"],
  ]);
});

test("a card of an order nobody started goes to the owner", async () => {
  const { hub, sam, dana, t0, write } = await rig();
  hub.db.conn.run("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (4, 'devbox', 'p1', 'open', ?1)", [
    JSON.stringify({ workstreamId: "W4", projectRef: r, title: "Dependency check", source: { channel: "lead" } }),
  ]);
  write(dana, "hi", t0 + 1000);
  const request = approvals(hub).create({
    projectRef: r,
    workstreamId: "W4",
    kind: "approval",
    text: "Bump deps",
    gated: { argv: ["pnpm", "up"], cwd: "/srv/shop", class: "irreversible", reason: "Bump deps", timeoutSec: 600 },
    at: new Date(t0 + 2000).toISOString(),
    atMs: t0 + 2000,
  });
  await showRequest(hub, request.requestId);
  expect(chat(hub).bySource(r, `item:${request.requestId}`)?.for).toEqual(sam);
});
