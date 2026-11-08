// Machines down over an in-memory hub and a fake push relay (never the real one): a machine offline past 10 minutes
// pushes once to the admins and once more when it is back; one back sooner, one an update restarts, and a cloud machine
// asleep push nothing. Ports crates/fleetd/src/hub/outage/tests.rs.
import { afterAll, expect, test } from "bun:test";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { Follow, step, type PushPayload } from "../src/hub/push/index.ts";
import { sweep } from "../src/hub/outage/index.ts";
import { sweep as sweepOf } from "../src/hub/sweep/index.ts";
import { updates } from "../src/hub/update/tools.ts";
import { pool } from "../src/hub/pool/tools.ts";
import { newSlot, type State } from "../src/hub/pool/ledger.ts";
import { people } from "../src/hub/people/store.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import type { Machine, MachineStatus, UpdateRun } from "../src/shared/contracts.ts";
import { testHub } from "./people-kit.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;
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

async function world() {
  const home = tempHome();
  homes.push(home.done);
  const kit = testHub({ home: home.dir, url: "http://devbox:4790" });
  const { hub, clock, call, device } = kit;
  const owner = device(undefined, people(hub).list(false)[0]?.personId, "desk");
  const ada = device(undefined, people(hub).create("Ada", "member").personId, "ada-desk");
  const phone = async (who: Caller, token: string) => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await call(who, "push_device_register", { platform: "ios", token, publicKey: Buffer.from(publicKeyOf(secret)).toString("base64"), name: token });
    return secret;
  };
  const ownerKey = await phone(owner, "aa11");
  await phone(ada, "bb22");
  await call(owner, "push_relay_set", { url: RELAY });
  const follow = new Follow(RELAY);
  let cursor = events(hub).head();
  const set = (status: MachineStatus, kind: string) => {
    const at = isoMs(clock.now());
    const stored = store(hub).machineGet("devbox") ?? ({ machineId: "devbox", name: "devbox", status: "online", lastSeenAt: at, nodeVersion: "1.0.0" } as Machine);
    store(hub).machineUpsert({ ...stored, status, lastSeenAt: status === "offline" ? stored.lastSeenAt : at });
    events(hub).append({ at, type: kind, machineId: "devbox", summary: `devbox ${kind}` });
  };
  /** Time passes; the sweep looks each 30 s of it. */
  const wait = (ms: number) => {
    for (let left = ms; left > 0; left -= 30_000) {
      clock.advance(Math.min(left, 30_000));
      sweep(hub);
    }
  };
  const logged = (type: string) => events(hub).page(0, [type]).events.length;
  /** What reached the phones since the last look: the pushes' tokens. */
  const pushed = async () => {
    const before = got.length;
    for (;;) {
      const out = await step(hub, follow, cursor);
      cursor = out.cursor;
      if (!out.more) break;
    }
    return got.slice(before).map((p) => p.token);
  };
  const lastBody = () => {
    const p = JSON.parse(new TextDecoder().decode(openSealed(ownerKey, Buffer.from(got.at(-1)?.ciphertext ?? "", "base64")) as Uint8Array)) as PushPayload;
    return [p.kind, p.body];
  };
  set("online", "machine.online");
  return { hub, clock, set, wait, logged, pushed, lastBody };
}

test("a machine offline past ten minutes pages its admins once and says when it is back", async () => {
  const w = await world();
  w.set("offline", "machine.offline");
  w.wait(9 * MINUTE);
  expect(w.logged("machine.down")).toBe(0);
  expect(await w.pushed()).toEqual([]);
  w.wait(2 * MINUTE);
  // The owner's phone only: a member isn't an admin.
  expect(await w.pushed()).toEqual(["aa11"]);
  const [kind, body] = w.lastBody();
  expect(kind).toBe("alert");
  expect(body).toStartWith("devbox has been offline for 10m");
  // However long it stays down: once.
  w.wait(60 * MINUTE);
  expect(w.logged("machine.down")).toBe(1);
  expect(await w.pushed()).toEqual([]);
  w.set("online", "machine.online");
  w.wait(MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
  expect(w.lastBody()[1]).toBe("devbox is back online after 1h11m");
  w.wait(10 * MINUTE);
  expect(w.logged("machine.back")).toBe(1);
  // A new outage is paged again.
  w.set("offline", "machine.offline");
  w.wait(11 * MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
});

test("a machine back within ten minutes pages nobody, back degraded too", async () => {
  const w = await world();
  w.set("offline", "machine.offline");
  w.wait(9 * MINUTE);
  w.set("degraded", "machine.degraded");
  w.wait(30 * MINUTE);
  expect([w.logged("machine.down"), w.logged("machine.back")]).toEqual([0, 0]);
  expect(await w.pushed()).toEqual([]);
});

const updateRun = (state: string): UpdateRun =>
  ({
    id: "u1",
    channel: "edge",
    startedAt: "2026-10-19T10:00:00.000Z",
    parts: [
      { part: "hub", name: "the hub", from: "1.0.0", state: "done" },
      { part: "node", machineId: "devbox", name: "devbox", from: "1.0.0", state },
    ],
  }) as UpdateRun;

test("a machine away for an update restart pages nobody until the update gives up on it", async () => {
  const w = await world();
  updates(w.hub).driveForTest(updateRun("restarting"));
  w.set("offline", "machine.offline");
  w.wait(15 * MINUTE);
  expect(w.logged("machine.down")).toBe(0);
  expect(await w.pushed()).toEqual([]);
  // The update rolled it back and its node still isn't here: that is an outage.
  updates(w.hub).driveForTest(updateRun("rolled_back"));
  w.wait(MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
});

test("an update restart back in time pages nobody", async () => {
  const w = await world();
  updates(w.hub).driveForTest(updateRun("restarting"));
  w.set("offline", "machine.offline");
  w.wait(3 * MINUTE);
  w.set("online", "machine.online");
  updates(w.hub).driveForTest(updateRun("done"));
  w.wait(20 * MINUTE);
  expect(await w.pushed()).toEqual([]);
});

test("a cloud machine asleep pages nobody and a broken one does", async () => {
  const w = await world();
  const m = store(w.hub).machineGet("devbox") as Machine;
  store(w.hub).machineUpsert({ ...m, cloud: true });
  const putSlot = (state: State) => pool(w.hub).ledger.put({ ...newSlot("devbox", 0), state });
  putSlot("asleep");
  w.set("offline", "machine.offline");
  w.wait(30 * MINUTE);
  expect(await w.pushed()).toEqual([]);
  putSlot("broken");
  w.wait(MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
});

test("a removed machine pages nobody", async () => {
  const w = await world();
  w.set("offline", "machine.offline");
  store(w.hub).machineRemove("devbox");
  w.wait(30 * MINUTE);
  expect(await w.pushed()).toEqual([]);
});

test("a busy machine down pages once, from its first offline", async () => {
  const w = await world();
  const at = isoMs(w.clock.now());
  store(w.hub).threadUpsert({
    thread: { machineId: "devbox", threadId: "t1", projectId: "app", title: "T1", status: "running", headline: "", latestMessageTail: "", lastProgressAt: at, stale: false, asOf: at } as never,
  });
  w.set("offline", "machine.offline");
  w.wait(5 * MINUTE);
  // The hub's own 5-minute sweep says nothing of it, and a hub restart marking it offline again doesn't move when the
  // outage began.
  await sweepOf(w.hub).runOnce();
  w.set("offline", "machine.offline");
  expect(await w.pushed()).toEqual([]);
  w.wait(5 * MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
  expect(w.lastBody()[1]).toStartWith("devbox has been offline for 10m");
  w.wait(20 * MINUTE);
  await sweepOf(w.hub).runOnce();
  w.set("online", "machine.online");
  w.wait(MINUTE);
  expect(await w.pushed()).toEqual(["aa11"]);
  expect(w.lastBody()[1]).toBe("devbox is back online after 30m00s");
});
