import { expect, test } from "bun:test";
import { gatedRefusal, mayHaveRun } from "../src/hub/approvals/rules.ts";
import { kindRule, settled } from "../src/hub/approvals/request.ts";
import { stopLine } from "../src/hub/chat/lead_text.ts";
import { jsTake, nudgeWaiting } from "../src/hub/chat/rules.ts";
import { named } from "../src/hub/chat_sections/rules.ts";
import { item } from "../src/hub/info/state.ts";

test("a stop's line says what stopped, what still runs and what left the train", () => {
  expect(stopLine(true, 2, 0, [])).toEqual({ any: true, text: "Stopped the lead and 2 agents." });
  expect(stopLine(false, 0, 0, [])).toEqual({ any: false, text: "Nothing was running." });
  expect(stopLine(undefined, 1, 1, [7, 9]).text).toBe(
    "Stopped 1 agent. The lead's turn could not be stopped: its machine didn't answer. 1 agent could not be stopped and is still working. Left open, off the train: #7, #9.",
  );
});

test("chat limits: a cut never splits a pair, a nudge waits a day, a section list is checked", () => {
  expect(jsTake("ab😀", 3)).toBe("ab");
  const at = Date.parse("2026-01-01T00:00:00Z");
  expect(nudgeWaiting({ at: "2026-01-01T00:00:00Z" } as never, at + 1000)).toBe(true);
  expect(nudgeWaiting({ at: "2026-01-01T00:00:00Z" } as never, at + 25 * 3_600_000)).toBe(false);
  expect(named([{ id: "s1", name: "  Work ", chats: [] }])).toEqual([{ id: "s1", name: "Work", chats: [] }]);
  expect(() => named([{ id: "s1", name: "a", chats: [] }, { id: "s2", name: "a", chats: [] }])).toThrow("Two sections are named");
  expect(item("task", "  one\n two  ", { machineId: "m", projectId: "p" })).toMatchObject({ kind: "task", text: "one two" });
});

test("a gated command fleetd can store, a request's kind rule, and its words once settled", () => {
  const ok = { argv: ["git", "push"], class: "irreversible", reason: "ship", timeoutSec: 60 };
  expect(gatedRefusal(ok, "/repo")).toBeUndefined();
  expect(gatedRefusal({ ...ok, argv: [] }, "/repo")).toBe("argv holds 1 to 64 words");
  expect(gatedRefusal(ok, "repo")).toContain("absolute path");
  expect(gatedRefusal({ ...ok, class: "normal" }, "/repo")).toContain("class must be one of");
  expect(gatedRefusal({ ...ok, timeoutSec: 20_000 }, "/repo")).toBe("timeoutSec is 1 to 14400");
  expect(mayHaveRun("its node restarted", "m1")).toBe("interrupted, may have run: its node restarted; check on m1 whether it ran before you approve it again");
  expect(settled("Q1", "approved")).toContain("Q1");
  expect(kindRule({ kind: "secret", state: "ran" } as never)).toBeDefined();
});
