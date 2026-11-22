// The lines the apps build name Settings' admins' group as the hub on screen has it: Team on a fleetd cloud team, Hub
// on a self-hosted hub (shared/settingsPages.ts; the guard on every app line is shared/settingsPages.test.ts).
import { describe, expect, it } from "vitest";
import { holdsLink } from "./agentsModel";
import { placesOf } from "../setup/steps";

describe("a fleetd cloud team's Settings group in the apps' lines", () => {
  it("is Team in a bot's max agents link and the setup steps' Open, and Hub on a self-hosted hub", () => {
    const a = { machineCap: 4 } as Parameters<typeof holdsLink>[0];
    expect(holdsLink(a, "devbox", undefined, true).text).toBe("devbox's max in Team › Machines");
    expect(holdsLink(a, "devbox").text).toBe("devbox's max in Hub › Machines");
    const step = { id: "machines", place: "machines" } as Parameters<typeof placesOf>[0];
    expect(placesOf(step, false, true).map((p) => p.label)).toEqual(["Open Team › Machines"]);
    expect(placesOf(step).map((p) => p.label)).toEqual(["Open Hub › Machines"]);
  });
});
