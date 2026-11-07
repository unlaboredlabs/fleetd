import { describe, expect, it } from "vitest";
import { stopVerdict } from "./stopProbe";

const refused = (code: string) => ({ ok: false as const, error: { code } });

describe("stopVerdict", () => {
  it("shows Stop when the hub has chat_stop for this key, which an empty input proves without stopping anything", () => {
    expect(stopVerdict(refused("invalid"))).toBe(true);
    expect(stopVerdict({ ok: true })).toBe(true);
  });

  it("hides it for a key that may not stop leads, and on a hub without the tool", () => {
    expect(stopVerdict(refused("forbidden"))).toBe(false);
    expect(stopVerdict(refused("not_found"))).toBe(false);
    expect(stopVerdict(refused("unsupported"))).toBe(false);
  });

  it("asks again after a link that dropped", () => {
    for (const code of ["timeout", "offline", "disconnected"]) expect(stopVerdict(refused(code))).toBeUndefined();
  });
});
