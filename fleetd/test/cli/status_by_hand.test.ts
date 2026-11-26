// A workspace started by hand (fleetd workspace start, no fleetd init) has no setup.json: fleetd status said "<home> has
// no workspace set up" beside it while fleetd pair, which opens the database, worked. It reaches the one running there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

let fleet: Fleet;
beforeAll(async () => {
  fleet = new Fleet("status-by-hand", { tools: true });
  await fleet.startHub();
  rmSync(join(fleet.hubHome, "setup.json"));
});
afterAll(() => fleet?.stop());

test("status finds a workspace started by hand on this home", async () => {
  const status = await fleet.run(["status"]);
  expect(status.stderr).not.toContain("has no workspace set up");
  expect(status.code, status.stderr).toBe(0);
  expect(status.stdout).toContain("no bots yet");
});
