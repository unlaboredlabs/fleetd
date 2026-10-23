import { describe, expect, it } from "vitest";
import { fixtureRequest } from "./fixture";

describe("fixtureRequest", () => {
  it("takes FLEETD_FIXTURE in a development build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, false)).toEqual({ kind: "fixture", name: "board-busy" });
    expect(fixtureRequest({}, false)).toEqual({ kind: "none" });
    expect(fixtureRequest({ FLEETD_FIXTURE: "" }, true)).toEqual({ kind: "none" });
  });

  it("ignores FLEETD_FIXTURE in a release build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, true).kind).toBe("ignored");
  });
});
