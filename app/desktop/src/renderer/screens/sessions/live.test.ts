import { describe, expect, it, vi } from "vitest";
import type { DataLayer } from "../../src/data/queries";
import type * as ui from "../../ui";
import { toast } from "../../ui";
import { addressOf, framePoint, isPaste, keyInput, modifiersOf, setControl } from "./live";

vi.mock("../../ui", async (actual) => ({ ...(await actual<typeof ui>()), toast: vi.fn() }));

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("a person's input to a page they took over", () => {
  it("is in the frame's own pixels, wherever the frame is drawn and at whatever size", () => {
    expect(framePoint(150, 90, { left: 100, top: 40, width: 320, height: 200 }, { width: 1280, height: 800 })).toEqual({ x: 200, y: 200 });
  });

  it("carries the modifiers as CDP counts them", () => {
    expect(modifiersOf({ ...keys, altKey: true, shiftKey: true })).toBe(9);
    expect(modifiersOf({ ...keys, ctrlKey: true, metaKey: true })).toBe(6);
  });

  it("takes ⌘V (Ctrl+V elsewhere) as a paste of this computer's clipboard, not as a key for the page", () => {
    const v = { key: "v", code: "KeyV" };
    expect(isPaste({ ...keys, ...v, metaKey: true }, "darwin")).toBe(true);
    expect(isPaste({ ...keys, ...v, ctrlKey: true }, "linux")).toBe(true);
    // An upper-case V, and a layout that types another letter on the V key.
    expect(isPaste({ ...keys, key: "V", code: "KeyV", ctrlKey: true }, "linux")).toBe(true);
    expect(isPaste({ ...keys, key: "м", code: "KeyV", metaKey: true }, "darwin")).toBe(true);
    // Not the other platform's modifier, not with Alt, not a plain v.
    expect(isPaste({ ...keys, ...v, ctrlKey: true }, "darwin")).toBe(false);
    expect(isPaste({ ...keys, ...v, metaKey: true, altKey: true }, "darwin")).toBe(false);
    expect(isPaste({ ...keys, ...v }, "linux")).toBe(false);
  });

  it("types a printable key's character, and nothing for a shortcut or a release", () => {
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "down")).toEqual({ kind: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    expect(keyInput({ ...keys, key: "v", code: "KeyV", metaKey: true }, "down")).toEqual({ kind: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
    expect(keyInput({ ...keys, key: "Enter", code: "Enter" }, "down")).not.toHaveProperty("text");
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "up")).not.toHaveProperty("text");
  });
});

describe("the address bar", () => {
  it("goes to an address as typed with its scheme, else over https", () => {
    expect(addressOf("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(addressOf("http://example.com")).toBe("http://example.com");
    expect(addressOf("  example.com/docs ")).toBe("https://example.com/docs");
  });

  it("goes to this machine's own over http", () => {
    expect(addressOf("localhost:5173")).toBe("http://localhost:5173");
    expect(addressOf("127.0.0.1/app")).toBe("http://127.0.0.1/app");
    expect(addressOf("localhost.example.com")).toBe("https://localhost.example.com");
  });

  it("goes nowhere for nothing, or words with spaces", () => {
    expect(addressOf("")).toBeUndefined();
    expect(addressOf("   ")).toBeUndefined();
    expect(addressOf("what is fleetd")).toBeUndefined();
  });
});

describe("taking a page over", () => {
  it("says the hub's reason when it refuses, not a generic line", async () => {
    const message = "devbox's node isn't connected, or is too old for takeover.";
    const layer = { call: () => Promise.resolve({ ok: false, error: { code: "machine_offline", message } }) } as unknown as DataLayer;
    expect(await setControl(layer, "B1", "human")).toBe(false);
    expect(toast).toHaveBeenCalledWith({ title: "Couldn’t take over", description: message, key: "control:B1" });
  });
});
