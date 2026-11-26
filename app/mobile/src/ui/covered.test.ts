import { describe, expect, it } from "vitest";
import { coveredIn, heldHub } from "./Covered";
import type { HubContextValue } from "../hubContext";

const routes = (...names: string[]) => ({ routes: names.map((name, i) => ({ key: `${name}-${String(i)}`, name })) });

describe("A covered screen", () => {
  it("is one with a screen over it that hides it whole, not a sheet", () => {
    expect(coveredIn(routes("Home", "Chat"), "Home-0")).toBe(true);
    expect(coveredIn(routes("Home", "Chat"), "Chat-1")).toBe(false);
    expect(coveredIn(routes("Home", "Chat", "ChatInfo"), "Chat-1")).toBe(true);
    // A sheet over the chat leaves it showing; the list under the chat stays covered.
    expect(coveredIn(routes("Home", "Chat", "ScreenList"), "Chat-1")).toBe(false);
    expect(coveredIn(routes("Home", "Chat", "ScreenList"), "Home-0")).toBe(true);
    expect(coveredIn(routes("Home", "NewProject"), "Home-0")).toBe(false);
    expect(coveredIn(undefined, "Home-0")).toBe(false);
  });

  it("reads the hub as it was while covered, and the live one again once it isn't", () => {
    const was = { state: { n: 1 } } as unknown as HubContextValue;
    const now = { state: { n: 2 } } as unknown as HubContextValue;
    expect(heldHub(was, now, true)).toBe(was);
    expect(heldHub(was, now, false)).toBe(now);
    // Covered before it ever read one: the live one.
    expect(heldHub(undefined, now, true)).toBe(now);
  });
});
