// `fleetd mac`'s parsing and words (crates/fleetd/src/cli/mac_tool.rs's tests): `mac sim start` waits its turn in the
// Mac's line unless told not to, and says its place as it waits.
import { expect, test } from "bun:test";
import { answer, ordinal, shown, simStartArgs } from "../../src/cli/mac_tool.ts";

test("sim start waits its turn unless told not to", () => {
  expect(simStartArgs([])).toEqual([undefined, true]);
  expect(simStartArgs(["--no-wait"])).toEqual([undefined, false]);
  expect(simStartArgs(["--no-wait", "--device", "iPad Air 11-inch"])).toEqual(["iPad Air 11-inch", false]);
  expect(simStartArgs(["--device=iPad Air 11-inch", "--no-wait"])).toEqual(["iPad Air 11-inch", false]);
  expect(simStartArgs(["--wait"])).toBeInstanceOf(Error);
});

test("a waiting sim start says its place in line", () => {
  const queued = (place: number, secs: number | null, why: string) => shown({ step: "sim_queued", place, secs, why });
  expect(queued(2, 90, "the agents ahead of you get theirs first")).toBe(
    "2nd in line for a simulator, about 90 s: the agents ahead of you get theirs first\n",
  );
  expect(queued(1, null, "all 2 of the Mac's iOS simulators are in use by other agents")).toBe(
    "1st in line for a simulator: all 2 of the Mac's iOS simulators are in use by other agents\n",
  );
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "103rd"]);
  // `--no-wait`, or a Mac before the line: the Mac's refusal, as before.
  const refused = answer({
    t: "lead_result",
    id: "cli-1",
    error: {
      code: "failed",
      message: "All 2 of the Mac's iOS simulators are in use by other agents.",
      fix: "mac sim start without --no-wait waits its turn, or carry on without one",
    },
  });
  expect("code" in refused && refused.code).toBe(1);
  expect("text" in refused && refused.text.startsWith("mac: All 2 of the Mac's iOS simulators are in use")).toBe(true);
});
