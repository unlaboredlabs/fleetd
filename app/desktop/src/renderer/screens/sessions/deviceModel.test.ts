// The device around a phone screen's picture (W859): the right body for the model and the picture, how it stands
// (which Duo panel is lit, its hinge, its turn), and where the picture lies on it, so it fills the display exactly.
import { describe, expect, it } from "vitest";
import { bodyOf, DUO_COVER_PX, DUO_INNER_PX, flatOf, HALF_OPEN, MM_PER_PX, placeShown, poseOf, radiiShown, shownPanel, uvOf, type Body } from "./deviceModel";
import { railOf, textSizeWord } from "./strip";

const duo = bodyOf("ios", "iPhone Duo", undefined) as Extract<Body, { kind: "duo" }>;
const cover = { width: DUO_COVER_PX.width, height: DUO_COVER_PX.height };
const inner = { width: DUO_INNER_PX.width, height: DUO_INNER_PX.height };
const turn = (s: { width: number; height: number }) => ({ width: s.height, height: s.width });

describe("bodyOf", () => {
  it("puts a Duo around a Duo, even from an older node that names no model (F1391's replay)", () => {
    expect(duo.kind).toBe("duo");
    expect(bodyOf("ios", undefined, cover)?.kind).toBe("duo");
    expect(bodyOf("ios", undefined, { width: 700, height: 1018 })?.kind).toBe("duo");
    expect(bodyOf("ios", undefined, turn(inner))?.kind).toBe("duo");
    expect(bodyOf("ios", undefined, { width: 1206, height: 2622 })?.kind).toBe("phone");
  });

  it("builds an iPhone's display from the picture's shape at its model's size, whatever the picture was scaled to", () => {
    const pro = bodyOf("ios", "iPhone 17 Pro", { width: 552, height: 1200 });
    expect(pro?.kind).toBe("phone");
    if (pro?.kind !== "phone") return;
    expect(pro.screen.height).toBeCloseTo(2622 * MM_PER_PX, 3);
    expect(pro.screen.width / pro.screen.height).toBeCloseTo(552 / 1200, 5);
    expect(pro.island).toBeDefined();
    expect(pro.depth).toBe(8.75);
    const air = bodyOf("ios", "iPhone Air", undefined);
    expect(air?.kind === "phone" && air.depth).toBe(5.64);
    const e = bodyOf("ios", "iPhone 17e", undefined);
    expect(e?.kind === "phone" && e.island).toBe(undefined);
  });

  it("gives an Android a plain phone and anything else no device", () => {
    const android = bodyOf("android", undefined, { width: 412, height: 915 });
    expect(android?.kind === "phone" && android.island).toBe(undefined);
    expect(bodyOf("linux_desktop", undefined, undefined)).toBeUndefined();
    expect(bodyOf(undefined, undefined, undefined)).toBeUndefined();
  });

  it("gives the Duo's cover its square corners on the hinge's side", () => {
    expect(duo.cover.radii[0]).toBeLessThan(duo.cover.radii[1]);
    expect(duo.cover.radii[3]).toBeLessThan(duo.cover.radii[2]);
  });
});

describe("poseOf", () => {
  it("stands a Duo by what its picture shows: the cover shut, the inner open, half open as a book, on its side as a laptop", () => {
    expect(poseOf(duo, "closed", "portrait", cover)).toEqual({ hinge: 0, panel: "cover", roll: 0, laptop: false });
    expect(poseOf(duo, "open", "portrait", inner)).toEqual({ hinge: 180, panel: "inner", roll: 0, laptop: false });
    expect(poseOf(duo, "half-open", "portrait", inner)).toEqual({ hinge: HALF_OPEN, panel: "inner", roll: 0, laptop: false });
    expect(poseOf(duo, "laptop", "landscape_left", turn(inner))).toEqual({ hinge: HALF_OPEN, panel: "inner", roll: 90, laptop: true });
  });

  it("believes the picture over a fold or a turn that came a moment before it", () => {
    // The session says open; the frame still shows the cover.
    expect(poseOf(duo, "open", "portrait", cover).panel).toBe("cover");
    // It says turned; the frame still stands.
    expect(poseOf(duo, "closed", "landscape_left", cover).roll).toBe(0);
    // It says upright; the frame lies on its side.
    expect(poseOf(duo, "closed", "portrait", turn(cover)).roll).toBe(90);
    expect(poseOf(duo, "closed", "landscape_right", turn(cover)).roll).toBe(-90);
  });

  it("goes by the fold and the turn before the first picture", () => {
    expect(poseOf(duo, undefined, undefined, undefined).panel).toBe("cover");
    expect(poseOf(duo, "open", "landscape_right", undefined)).toMatchObject({ panel: "inner", roll: -90 });
  });

  it("turns an iPhone with its picture", () => {
    const pro = bodyOf("ios", "iPhone 17 Pro", undefined) as Body;
    expect(poseOf(pro, undefined, "portrait", { width: 1206, height: 2622 }).roll).toBe(0);
    expect(poseOf(pro, undefined, "landscape_left", { width: 2622, height: 1206 }).roll).toBe(90);
    expect(poseOf(pro, undefined, "portrait_upside_down", { width: 1206, height: 2622 }).roll).toBe(180);
  });
});

describe("where the picture lies", () => {
  it("fills the display corner to corner, upright or turned", () => {
    const panel = { width: 60, height: 120 };
    expect(uvOf(-30, 60, panel, 0)).toEqual([0, 1]);
    expect(uvOf(30, -60, panel, 0)).toEqual([1, 0]);
    // Turned a quarter anticlockwise: the device's top left is the picture's bottom left.
    expect(uvOf(-30, 60, panel, 90)).toEqual([0, 0]);
    expect(uvOf(30, 60, panel, -90)).toEqual([1, 0]);
  });

  it("is the picture's own shape: the shown display matches it, so nothing is letterboxed", () => {
    const pose = poseOf(duo, "laptop", "landscape_left", turn(inner));
    const shown = shownPanel(duo, pose);
    expect(shown.width / shown.height).toBeCloseTo(DUO_INNER_PX.height / DUO_INNER_PX.width, 2);
    const f = flatOf(duo, pose);
    expect(f.screenAspect).toBeCloseTo(DUO_INNER_PX.height / DUO_INNER_PX.width, 2);
    expect(f.crease).toBe("across");
    expect(flatOf(duo, poseOf(duo, "open", "portrait", inner)).crease).toBe("down");
  });

  it("turns the corners and the island with the device", () => {
    expect(radiiShown({ width: 1, height: 2, radii: [1, 2, 3, 4] }, 90)).toEqual([2, 3, 4, 1]);
    expect(radiiShown({ width: 1, height: 2, radii: [1, 2, 3, 4] }, -90)).toEqual([4, 1, 2, 3]);
    expect(radiiShown({ width: 1, height: 2, radii: [1, 2, 3, 4] }, 180)).toEqual([3, 4, 1, 2]);
    // An island at the display's top, the device turned its top to the left: along the left edge.
    const at = placeShown({ x: 0, y: 50, width: 20, height: 6 }, { width: 60, height: 120 }, 90);
    expect(at.left).toBeCloseTo(7 / 120, 5);
    expect(at.top).toBeCloseTo(0.5 - 10 / 60, 5);
    expect(at.width).toBeCloseTo(6 / 120, 5);
    expect(at.height).toBeCloseTo(20 / 60, 5);
  });

  it("marks the cover's camera only on the cover", () => {
    expect(flatOf(duo, poseOf(duo, "closed", "portrait", cover)).island).toBeDefined();
    expect(flatOf(duo, poseOf(duo, "open", "portrait", inner)).island).toBeUndefined();
  });
});

describe("the toolbar's groups", () => {
  it("shows home and rotate, the look with More behind it, and a Duo's postures, only what the machine says works", () => {
    const ios = ["rotate_left", "rotate_right", "shake", "home", "lock", "appearance", "text_size", "screenshot", "location", "fold"];
    expect(railOf(ios, ["closed", "half-open", "open", "laptop"])).toEqual({
      buttons: ["home", "rotate_left"],
      look: ["appearance", "text_size", "screenshot"],
      more: ["rotate_right", "lock", "shake", "location"],
      postures: ["closed", "half-open", "open", "laptop"],
    });
    expect(railOf(["rotate_left", "home", "back", "screenshot"], undefined)).toEqual({ buttons: ["home", "rotate_left"], look: ["screenshot"], more: ["back"], postures: [] });
    expect(railOf(["home"], ["closed", "flat"]).postures).toEqual([]);
  });

  it("names a text size, and none before it is read", () => {
    expect(textSizeWord("large")).toBe("Large (default)");
    expect(textSizeWord(undefined)).toBe("Text size");
  });
});
