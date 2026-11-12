import { expect, test } from "bun:test";
import { ExecutorError } from "../src/hub/executor/error.ts";
import { short, stamp } from "../src/hub/leads/zone_text.ts";
import { PortError, portError, requestId, StartError, withPending, workspaceOf } from "../src/hub/tasks/launch.ts";
import { ToolError } from "../src/shared/errors.ts";

test("a task's worktree becomes the session's workspace: a writer's on its branch, a review's detached at its PR's head", () => {
  const none = () => undefined;
  expect(workspaceOf({ baseRef: "main", branch: "b", from: "s1" }, none)).toEqual({ type: "worktree", baseRef: "main", branch: "b", fromSession: "s1" });
  expect(workspaceOf({ baseRef: "main", pr: "https://github.com/a/b/pull/1" }, () => "abc")).toEqual({
    type: "detached",
    baseRef: "main",
    pr: "https://github.com/a/b/pull/1",
    head: "abc",
  });
  expect(workspaceOf({ baseRef: "main", pr: "" }, () => "never")).toEqual({ type: "detached", baseRef: "main" });
  expect(() => workspaceOf({ baseRef: "" }, none)).toThrow("a worktree needs a base ref");
  expect(() => workspaceOf({ baseRef: "main", branch: "" }, none)).toThrow("a worktree needs a branch");
});

test("why a start failed, and the ids a task's writes carry", () => {
  expect(portError(ExecutorError.notConnected("m")).offline).toBe(true);
  expect(portError(new Error("boom"))).toMatchObject({ offline: false, message: "boom" });
  expect(StartError.of(new PortError(true, "gone")).offline).toBe(true);
  expect(StartError.of(new ToolError("machine_offline", "off")).offline).toBe(true);
  expect(StartError.of("x")).toMatchObject({ offline: false, message: "x" });
  expect(requestId({ taskId: "T3", createdAt: "2026-01-01T00:00:00Z" } as never, ["2"])).toBe(`fleetd-task:T3:${Date.parse("2026-01-01T00:00:00Z")}:2`);
  expect(withPending("brief", "and then this")).toBe("brief\n\nand then this");
  expect(withPending(undefined, undefined)).toBe("");
});

test("an instant on a person's clock, with how their zone was chosen", () => {
  const at = Date.parse("2026-11-03T17:05:00Z");
  expect(short({ tz: "Europe/Berlin", source: "device" }, at)).toBe("Tue 3 Nov, 18:05");
  expect(stamp({ tz: "UTC", source: "hub" }, at)).toBe("Tue 3 Nov 2026, 17:05 UTC, the hub machine's zone: theirs isn't known yet");
});
