// `fleetd status --watch` ends at once on SIGINT, mid long-poll (it selects each wait against the signal): against a
// hub on a scratch home.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Fleet } from "./golden.ts";

let fleet: Fleet;
beforeAll(async () => {
  fleet = new Fleet("status-watch");
  await fleet.startHub();
});
afterAll(() => fleet?.stop());

test("Ctrl-C ends the watch within a second, exit 0", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "status", "--watch"], {
    cwd: fleet.cwd,
    env: fleet.env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  // Its first rows, then it is inside the 50 s events_wait.
  const reader = proc.stdout.getReader();
  await reader.read();
  await Bun.sleep(500);
  const sent = performance.now();
  proc.kill("SIGINT");
  const code = await proc.exited;
  expect(performance.now() - sent).toBeLessThan(1000);
  expect(code).toBe(0);
});
