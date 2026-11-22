// A phone screen's control strip (D652): only what the device takes, in its groups, and the words and values it sends.
import { describe, expect, it } from "vitest";
import { appearanceWord, foldWord, latLon, otherAppearance, shotName, stripOf } from "./strip";

describe("stripOf", () => {
  it("shows only the controls the machine says work, in their groups", () => {
    const ios = ["screenshot", "location", "appearance", "shake", "lock", "home", "rotate_right", "rotate_left"];
    expect(stripOf(ios, undefined)).toEqual([["rotate_left", "rotate_right"], ["home", "lock"], ["shake", "appearance", "location"], ["screenshot"]]);
    expect(stripOf(["rotate_left", "rotate_right", "home", "back", "screenshot"], undefined)).toEqual([["rotate_left", "rotate_right"], ["home", "back"], ["screenshot"]]);
  });

  it("shows the fold only with the device's states, and nothing it doesn't know", () => {
    expect(stripOf(["fold", "home"], ["closed", "open"])).toEqual([["fold"], ["home"]]);
    expect(stripOf(["fold", "home"], [])).toEqual([["home"]]);
    expect(stripOf(["siri", "volume_up"], undefined)).toEqual([]);
  });
});

describe("the strip's words and values", () => {
  it("names the appearance it turns to", () => {
    expect(appearanceWord("dark")).toBe("Light appearance");
    expect(appearanceWord("light")).toBe("Dark appearance");
    expect(appearanceWord(undefined)).toBe("Dark appearance");
    expect(otherAppearance("dark")).toBe("light");
    expect(otherAppearance(undefined)).toBe("dark");
  });

  it("says a fold state in words", () => {
    expect(foldWord("half-open")).toBe("Half open");
    expect(foldWord("closed")).toBe("Closed");
    expect(foldWord("fully_open")).toBe("Fully open");
  });

  it("reads a typed location as the hub takes it", () => {
    expect(latLon("51.5072, -0.1276")).toBe("51.5072,-0.1276");
    expect(latLon(" 35.6764 139.65 ")).toBe("35.6764,139.65");
    expect(latLon("91, 0")).toBeNull();
    expect(latLon("0, 181")).toBeNull();
    expect(latLon("London")).toBeNull();
    expect(latLon("")).toBeNull();
  });

  it("names a screenshot by its device and time", () => {
    expect(shotName("iPhone", new Date(2026, 10, 22, 9, 5, 7))).toBe("iPhone 2026-11-22 at 09.05.07.png");
  });
});
