import { describe, expect, it } from "vitest";
import type { HubError } from "./desktop";
import { memoryPins, Pins, type PinCall } from "./pins";
import { hubPinStore, parsePrefs, pinsOf, reducePrefs, type PrefsAction } from "./prefs";

const ref = (key: string) => ({ machineId: "m1", projectId: key.slice(3) });

/** A hub that holds each call until the test answers it. */
const fakeCalls = () => {
  const calls: Array<{ tool: string; input: unknown; answer: (r: unknown) => void }> = [];
  const call = ((tool: string, input: unknown) => new Promise<unknown>((answer) => calls.push({ tool, input, answer }))) as PinCall;
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Answers the oldest call still waiting. */
  const next = async (tool: string, r: { output: unknown } | { error: Partial<HubError> }) => {
    const c = calls.shift();
    expect(c?.tool).toBe(tool);
    c?.answer("output" in r ? { ok: true, output: r.output } : { ok: false, error: { message: "", fix: "", ...r.error } });
    await settle();
    return c?.input;
  };
  return { calls, call, next, settle };
};

/** Pins the hub has said its list for: `onHub`, which this phone's copy then is. */
const readPins = async (hub: ReturnType<typeof fakeCalls>, store = memoryPins(), onHub: string[] = []) => {
  const pins = new Pins(hub.call, store);
  void pins.read();
  await hub.next("chat_pins_get", { output: { pins: onHub.map(ref), set: true } });
  return pins;
};

describe("Pins", () => {
  it("shows the hub's pins, in the person's order", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/old"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/b"), ref("m1/a")], set: true } });
    expect(store.saved()).toEqual(["m1/b", "m1/a"]);
    expect(hub.calls).toHaveLength(0);
  });

  it("sends up this phone's own pins to a hub that never had them, once", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a", "m1/b"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { output: { pins: [], set: false } });
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a"), ref("m1/b")] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b")] });
    expect(store.saved()).toEqual(["m1/a", "m1/b"]);
    // Nothing kept here: nothing to send.
    const empty = new Pins(hub.call, memoryPins());
    void empty.read();
    await hub.next("chat_pins_get", { output: { pins: [], set: false } });
    expect(hub.calls).toHaveLength(0);
  });

  it("shows a pin at once and sends one set at a time, the newest last", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = await readPins(hub, store);
    void pins.change(() => ["m1/a"]);
    void pins.change(() => ["m1/a", "m1/b"]);
    void pins.change(() => ["m1/b"]);
    expect(store.saved()).toEqual(["m1/b"]);
    // The first is on its way; the two after it go as one, the newest.
    expect(hub.calls).toHaveLength(1);
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/b")] } })).toEqual({ pins: [ref("m1/b")] });
    expect(hub.calls).toHaveLength(0);
    expect(store.saved()).toEqual(["m1/b"]);
  });

  it("keeps a pin made offline and sends it, over the hub's, when the link is back", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = await readPins(hub, store);
    void pins.change(() => ["m1/a"]);
    await hub.next("chat_pins_set", { error: { code: "offline" } });
    expect(store.saved()).toEqual(["m1/a"]);
    // The next live link sends it instead of reading.
    void pins.read();
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
    expect(hub.calls).toHaveLength(0);
  });

  it("keeps a pin whose set the link dropped or never answered, and sends it again", async () => {
    for (const code of ["disconnected", "timeout"]) {
      const hub = fakeCalls();
      const store = memoryPins();
      const pins = await readPins(hub, store);
      void pins.change(() => ["m1/a"]);
      await hub.next("chat_pins_set", { error: { code } });
      // The next live link sends it again rather than reading the hub's older pins over it.
      void pins.read();
      expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
      expect(hub.calls).toHaveLength(0);
      expect(store.saved()).toEqual(["m1/a"]);
    }
  });

  it("sends a pin made after a read the link dropped, when the link is back", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { error: { code: "disconnected" } });
    // Pinned while the link is down: the hub, asked first what they are, isn't reached.
    void pins.change(() => ["m1/a"]);
    expect(store.saved()).toEqual(["m1/a"]);
    await hub.next("chat_pins_get", { error: { code: "offline" } });
    expect(store.pending()).toBe(true);
    void pins.read();
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
    expect(store.saved()).toEqual(["m1/a"]);
  });

  it("keeps each hub's pins and pending change apart, and never sends one hub's chats to another", async () => {
    // One phone's prefs, as an older build left them: pinned on hub A, before the hubs kept pins.
    let prefs = parsePrefs({ pinned: ["a/one", "a/two"] });
    const get = () => prefs;
    const dispatch = (action: PrefsAction) => {
      prefs = reducePrefs(prefs, action);
    };
    const A = "http://a:4790";
    const B = "http://b:4790";
    const isA = (key: string) => key.startsWith("a/");
    const isB = (key: string) => key.startsWith("b/");

    // Hub B never had pins: none of A's chats go to it, and it has nothing to claim.
    const b = fakeCalls();
    void new Pins(b.call, hubPinStore(get, dispatch, B), isB).read();
    await b.next("chat_pins_get", { output: { pins: [], set: false } });
    expect(b.calls).toHaveLength(0);
    // Pinned on B: B's own.
    void new Pins(b.call, hubPinStore(get, dispatch, B), isB).change(() => ["b/x"]);
    await b.next("chat_pins_get", { error: { code: "offline" } });
    expect(pinsOf(prefs, B)).toEqual(["b/x"]);
    expect(prefs.pinsPending).toEqual([B]);

    // Hub A claims its own from the older build's, and its pins stay apart from B's.
    const a = fakeCalls();
    void new Pins(a.call, hubPinStore(get, dispatch, A), isA).read();
    await a.next("chat_pins_get", { output: { pins: [], set: false } });
    expect(await a.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [{ machineId: "a", projectId: "one" }, { machineId: "a", projectId: "two" }] });
    expect(pinsOf(prefs, A)).toEqual(["a/one", "a/two"]);
    expect(prefs.pinsPending).toEqual([B]);

    // Back on B (a new session, as after switching or a restart): its pending pin goes, not A's.
    const back = fakeCalls();
    void new Pins(back.call, hubPinStore(get, dispatch, B), isB).read();
    expect(await back.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [{ machineId: "b", projectId: "x" }] });
    expect(prefs.pinsPending).toEqual([]);
  });

  it("keeps them on this phone alone with a hub that doesn't keep them", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { error: { code: "not_found" } });
    expect(store.saved()).toEqual(["m1/a"]);
    void pins.change(() => ["m1/a", "m1/b"]);
    await hub.settle();
    expect(store.saved()).toEqual(["m1/a", "m1/b"]);
    expect(hub.calls).toHaveLength(0);
  });
});

describe("A pin made before the hub has said what the pins are", () => {
  const pin = (key: string) => (keys: readonly string[]) => [...keys, key];
  const unpin = (key: string) => (keys: readonly string[]) => keys.filter((k) => k !== key);

  it("waits for the read on its way and is made on the hub's list, so a chat pinned on another phone stays", async () => {
    const hub = fakeCalls();
    // What this phone kept: b was pinned on the person's other phone since.
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    // Launch: the snapshot's read is on its way.
    void pins.read();
    void pins.change(pin("m1/c"));
    // Shown at once on what this phone has; nothing sent yet.
    expect(store.saved()).toEqual(["m1/a", "m1/c"]);
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_pins_get"]);
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/a"), ref("m1/b")], set: true } });
    expect(store.saved()).toEqual(["m1/a", "m1/b", "m1/c"]);
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b"), ref("m1/c")] });
    expect(store.pending()).toBe(false);
    expect(hub.calls).toHaveLength(0);
  });

  it("asks the hub itself when no read is on its way, and makes each change that waited, in order", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.change(pin("m1/c"));
    void pins.change(unpin("m1/a"));
    expect(store.saved()).toEqual(["m1/c"]);
    // One read for both.
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_pins_get"]);
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/b"), ref("m1/a")], set: true } });
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/b"), ref("m1/c")] });
    expect(store.saved()).toEqual(["m1/b", "m1/c"]);
    expect(hub.calls).toHaveLength(0);
  });

  it("asks again after a read the hub didn't answer, rather than send this phone's copy", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { error: { code: "timeout" } });
    void pins.change(pin("m1/c"));
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/a"), ref("m1/b")], set: true } });
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b"), ref("m1/c")] });
  });

  it("waits for the read a new link or another device's change started, and only for the newest", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = await readPins(hub, store, ["m1/a"]);
    // Back from a drop: the snapshot's read; then the other phone's pin is announced, and read too.
    void pins.read();
    void pins.read();
    void pins.change(pin("m1/c"));
    expect(store.saved()).toEqual(["m1/a", "m1/c"]);
    // The older read's answer, from before the other phone's pin, is not the one.
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/a")], set: true } });
    expect(hub.calls.map((c) => c.tool)).toEqual(["chat_pins_get"]);
    await hub.next("chat_pins_get", { output: { pins: [ref("m1/a"), ref("m1/b")], set: true } });
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b"), ref("m1/c")] });
  });

  it("is sent as changed here once the hub's list is this phone's: after a read, and after a set it took", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = await readPins(hub, store, ["m1/a"]);
    void pins.change(pin("m1/b"));
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b")] });
    void pins.change(pin("m1/c"));
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [ref("m1/a"), ref("m1/b"), ref("m1/c")] });
    expect(hub.calls).toHaveLength(0);
  });

  it("goes up with the pins an older build kept, to a hub that never had any", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    void pins.change(unpin("m1/a"));
    await hub.next("chat_pins_get", { output: { pins: [], set: false } });
    // Unpinned here before the hub said it had none: the hub is told there are none, so they aren't claimed again.
    expect(await hub.next("chat_pins_set", { output: { pins: [] } })).toEqual({ pins: [] });
    expect(store.saved()).toEqual([]);
  });

  it("stays on this phone alone when the hub doesn't keep pins", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.change(pin("m1/c"));
    await hub.next("chat_pins_get", { error: { code: "not_found" } });
    expect(store.saved()).toEqual(["m1/a", "m1/c"]);
    expect(store.pending()).toBe(false);
    expect(hub.calls).toHaveLength(0);
  });

  it("is made only to the pins of this hub's chats, as the list shows them", async () => {
    const hub = fakeCalls();
    // An older build's pins, another hub's chat among them.
    const store = memoryPins(["m1/a", "m2/x"]);
    const pins = new Pins(hub.call, store, (key) => key.startsWith("m1/"));
    void pins.read();
    await hub.next("chat_pins_get", { error: { code: "not_found" } });
    void pins.change(pin("m1/c"));
    expect(store.saved()).toEqual(["m1/a", "m1/c"]);
  });
});
