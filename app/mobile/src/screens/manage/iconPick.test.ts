import { describe, expect, it } from "vitest";
import { pickOver, standing } from "./iconPick";

const JOY = { face: "joy", color: "sun" } as const;

describe("the icon sheet's pick", () => {
  it("stands while the picture is the one it was picked over", () => {
    expect(standing(null, undefined)).toBeNull();
    expect(standing(pickOver(JOY, undefined), undefined)).toEqual(JOY);
    // Over a picture: Done sends it, which takes the picture's place.
    expect(standing(pickOver(JOY, "a1b2c3d4e5f60718"), "a1b2c3d4e5f60718")).toEqual(JOY);
  });

  it("gives way to a photo saved after it, so Done never deletes that photo", () => {
    // A face tapped, then Choose Photo and Move and Scale's Choose: the summary names the new picture.
    expect(standing(pickOver(JOY, undefined), "0f1e2d3c4b5a6978")).toBeNull();
    expect(standing(pickOver(JOY, "a1b2c3d4e5f60718"), "0f1e2d3c4b5a6978")).toBeNull();
  });

  it("stays when the photo it was picked over is removed: the face is still the person's choice", () => {
    expect(standing(pickOver(JOY, "a1b2c3d4e5f60718"), undefined)).toEqual(JOY);
  });
});
