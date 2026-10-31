import { describe, expect, it } from "vitest";
import type { HubError } from "./desktop";
import { memoryPins, Pins, type PinCall } from "./pins";

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
    const pins = new Pins(hub.call, store);
    void pins.set(["m1/a"]);
    void pins.set(["m1/a", "m1/b"]);
    void pins.set(["m1/b"]);
    expect(store.saved()).toEqual(["m1/b"]);
    // The first is on its way; the two after it go as one, the newest.
    expect(hub.calls).toHaveLength(1);
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/b")] } })).toEqual({ pins: [ref("m1/b")] });
    expect(hub.calls).toHaveLength(0);
    expect(store.saved()).toEqual(["m1/b"]);
  });

  it("drops a read that a pin made here overtook", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = new Pins(hub.call, store);
    void pins.read();
    void pins.set(["m1/a"]);
    // The read answers with what the hub had before the pin.
    await hub.next("chat_pins_get", { output: { pins: [], set: true } });
    expect(store.saved()).toEqual(["m1/a"]);
    await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } });
    expect(store.saved()).toEqual(["m1/a"]);
  });

  it("keeps a pin made offline and sends it, over the hub's, when the link is back", async () => {
    const hub = fakeCalls();
    const store = memoryPins();
    const pins = new Pins(hub.call, store);
    void pins.set(["m1/a"]);
    await hub.next("chat_pins_set", { error: { code: "offline" } });
    expect(store.saved()).toEqual(["m1/a"]);
    // The next live link sends it instead of reading.
    void pins.read();
    expect(await hub.next("chat_pins_set", { output: { pins: [ref("m1/a")] } })).toEqual({ pins: [ref("m1/a")] });
    expect(hub.calls).toHaveLength(0);
  });

  it("keeps them on this phone alone with a hub that doesn't keep them", async () => {
    const hub = fakeCalls();
    const store = memoryPins(["m1/a"]);
    const pins = new Pins(hub.call, store);
    void pins.read();
    await hub.next("chat_pins_get", { error: { code: "not_found" } });
    expect(store.saved()).toEqual(["m1/a"]);
    void pins.set(["m1/a", "m1/b"]);
    await hub.settle();
    expect(store.saved()).toEqual(["m1/a", "m1/b"]);
    expect(hub.calls).toHaveLength(0);
  });
});
