import { describe, expect, it } from "vitest";
import { fixtureRequest } from "./fixture";

describe("fixtureRequest", () => {
  it("takes FLEETD_FIXTURE in a development build", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, false)).toEqual({ kind: "fixture", name: "board-busy" });
    expect(fixtureRequest({}, false)).toEqual({ kind: "none" });
    expect(fixtureRequest({ FLEETD_FIXTURE: "" }, true)).toEqual({ kind: "none" });
  });

  it("ignores a stray FLEETD_FIXTURE in a release build unless FLEETD_DEV_FIXTURES=1 is set too", () => {
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy" }, true).kind).toBe("ignored");
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy", FLEETD_DEV_FIXTURES: "yes" }, true).kind).toBe("ignored");
    expect(fixtureRequest({ FLEETD_FIXTURE: "board-busy", FLEETD_DEV_FIXTURES: "1" }, true)).toEqual({ kind: "fixture", name: "board-busy" });
  });
});
