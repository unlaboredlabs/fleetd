import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubEvent, MachineId } from "@fleetd/contracts";
import * as HttpApp from "@fleetd/hub/api/HttpApp.ts";
import * as AppSocket from "@fleetd/hub/api/AppSocket.ts";
import * as FleetApi from "@fleetd/hub/api/FleetApi.ts";
import { AT, makeTestHub } from "@fleetd/hub/api/testHub.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import * as Listen from "./listen.ts";

const event = (seq: number, machineId = "lab-a"): HubEvent => ({
  seq,
  at: AT,
  type: "thread.completed",
  machineId: machineId as MachineId,
  summary: `event ${seq}`,
});

const memoryCursor = (initial?: number) => {
  const writes: Array<number> = [];
  let value = initial;
  const store: Listen.CursorStore = { read: () => value, write: (seq) => void (writes.push(seq), (value = seq)) };
  return { store, writes, get: () => value };
};

/** A hub that serves `pages` in turn (each answering the cursor it is asked from), then waits forever. */
const scriptedHub = (pages: Array<Listen.WaitPage | "down">) => {
  const asked: Array<number | undefined> = [];
  const hub: Listen.Hub = {
    wait: (cursor) =>
      Effect.suspend(() => {
        asked.push(cursor);
        const next = pages.shift();
        if (next === undefined) return Effect.never;
        return next === "down" ? Effect.fail(new Listen.HubUnavailable({ message: "ECONNREFUSED" })) : Effect.succeed(next);
      }),
  };
  return { hub, asked };
};

const runTest = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

describe("listenLoop", () => {
  it("advances the cursor only past acknowledged events, retrying a failed one before any later event", () =>
    runTest(
      Effect.gen(function* () {
        const cursor = memoryCursor(10);
        const { hub, asked } = scriptedHub(["down", { events: [event(11), event(12, "lab-b"), event(13)], cursor: 15 }]);
        const tries: Array<number> = [];
        const script = [true, false, false, true];
        const deliver: Listen.Deliver = (e) => Effect.sync(() => (tries.push(e.seq), script.shift() ?? true));
        const fiber = yield* Effect.forkChild(listenLoop({ hub, deliver, cursor: cursor.store, machines: ["lab-a"] }));

        yield* TestClock.adjust("1 second"); // the hub was down once
        expect(asked).toEqual([10, 10]);
        expect(tries).toEqual([11, 13]);
        expect(cursor.get()).toBe(11); // 13 failed: the cursor stays before it
        yield* TestClock.adjust("1 second");
        expect(tries).toEqual([11, 13, 13]);
        expect(cursor.get()).toBe(11);
        yield* TestClock.adjust("5 seconds");
        expect(tries).toEqual([11, 13, 13, 13]);
        // lab-b's 12 is filtered out; the page end (15) is persisted after the last delivery.
        expect(cursor.writes).toEqual([11, 13, 15]);
        expect(asked).toEqual([10, 10, 15]);
        yield* Fiber.interrupt(fiber);
      }),
    ));

  it("re-delivers the event in flight after a restart, and none before it", () =>
    runTest(
      Effect.gen(function* () {
        const cursor = memoryCursor();
        const first = scriptedHub([{ events: [event(1), event(2)], cursor: 2 }]);
        const tries: Array<string> = [];
        const failing: Listen.Deliver = (e) => Effect.sync(() => (tries.push(`a${e.seq}`), e.seq === 1));
        const before = yield* Effect.forkChild(listenLoop({ hub: first.hub, deliver: failing, cursor: cursor.store }));
        yield* TestClock.adjust("0 seconds");
        yield* Fiber.interrupt(before); // stopped while retrying event 2
        expect(first.asked).toEqual([undefined]);
        expect(cursor.get()).toBe(1);

        const second = scriptedHub([{ events: [event(2), event(3)], cursor: 3 }]);
        const ok: Listen.Deliver = (e) => Effect.sync(() => (tries.push(`b${e.seq}`), true));
        const after = yield* Effect.forkChild(listenLoop({ hub: second.hub, deliver: ok, cursor: cursor.store }));
        yield* TestClock.adjust("0 seconds");
        expect(second.asked).toEqual([1, 3]);
        expect(tries).toEqual(["a1", "a2", "b2", "b3"]);
        expect(cursor.get()).toBe(3);
        yield* Fiber.interrupt(after);
      }),
    ));

  it("stops with ListenRefused when the hub refuses the key", () =>
    runTest(
      Effect.gen(function* () {
        const hub: Listen.Hub = { wait: () => Effect.fail(new Listen.ListenRefused({ message: "401" })) };
        const error = yield* Effect.flip(listenLoop({ hub, deliver: () => Effect.succeed(true), cursor: memoryCursor().store }));
        expect(error._tag).toBe("ListenRefused");
      }),
    ));
});

const listenLoop = Listen.listenLoop;

// Against the real hub MCP endpoint (fake executors) on an ephemeral port.
const closers: Array<() => Promise<void>> = [];
const dirs: Array<string> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const startHub = async () => {
  const hub = makeTestHub();
  const services = AppSocket.layer.pipe(Layer.provideMerge(FleetApi.layer), Layer.provideMerge(hub.layer));
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(HttpApp.layer({ host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(services)), scope),
  );
  closers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  hub.bind(context);
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
  return { hub, url: `http://127.0.0.1:${address.port}` };
};

describe("fleetd listen against a hub", () => {
  it("delivers each event exactly once to --exec across a restart", async () => {
    const { hub, url } = await startHub();
    const { key } = await hub.addKey("listener", [{ role: "read", machines: "*" }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-listen-"));
    dirs.push(dir);
    const out = path.join(dir, "out.jsonl");
    const cursor = Listen.fileCursor(path.join(dir, "listen", "lab.cursor"));
    cursor.write(0);

    let delivered = 0;
    const watchers: Array<{ count: number; resolve: () => void }> = [];
    const exec = Listen.execDeliver(`cat >> '${out}'`);
    const deliver: Listen.Deliver = (e) =>
      Effect.tap(exec(e), (ok) =>
        Effect.sync(() => {
          if (ok) delivered += 1;
          for (const w of watchers.filter((w) => delivered >= w.count)) w.resolve();
        }),
      );
    const deliveredCount = (count: number) => new Promise<void>((resolve) => (delivered >= count ? resolve() : watchers.push({ count, resolve })));
    const start = () => Effect.runFork(listenLoop({ hub: Listen.mcpHub(url, key, { types: ["thread.completed"] }), deliver, cursor }));
    const append = (seqHint: number) =>
      hub.append({ at: AT, type: "thread.completed", machineId: "lab-a" as MachineId, summary: `done ${seqHint}` });

    const first = start();
    await append(1);
    await deliveredCount(1);
    await Effect.runPromise(Fiber.interrupt(first));

    await append(2); // while the listener is down
    const second = start();
    await deliveredCount(2);
    await append(3);
    await deliveredCount(3);
    await Effect.runPromise(Fiber.interrupt(second));

    const seqs = fs.readFileSync(out, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as HubEvent).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(cursor.read()).toBe(3);
  });

  it("exits 78 when the hub refuses the key", async () => {
    const { hub, url } = await startHub();
    const { key, keyId } = await hub.addKey("listener", [{ role: "read", machines: "*" }]);
    await hub.revoke(keyId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-listen-"));
    dirs.push(dir);
    const keyFile = path.join(dir, "key");
    fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const stderr: Array<string> = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0;
    try {
      expect(await Listen.listenCommand(["--hub", url, "--key-file", keyFile, "--exec", "true", "--name", "t"])).toBe(78);
      expect(await Listen.listenCommand(["--hub", url, "--key-file", path.join(dir, "missing"), "--exec", "true"])).toBe(78);
      expect(await Listen.listenCommand(["--hub", url, "--key-file", keyFile, "--types", "thread.done", "--exec", "true"])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(stderr.join("")).toContain("refused the key (401)");
    expect(stderr.join("")).not.toContain(key);
  });
});
