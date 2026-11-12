import { expect, test } from "bun:test";
import { ToolError } from "../src/shared/errors.ts";
import { ExecutorError } from "../src/hub/executor/error.ts";
import { fromExecutor, offline } from "../src/hub/link/node_errors.ts";

test("a session call's failure becomes the tool's error: offline when no node is linked, else the node's words", () => {
  const own = new ToolError("invalid", "no", "fix");
  expect(fromExecutor(own)).toBe(own);
  expect(fromExecutor(ExecutorError.notConnected("m1"))).toEqual(offline("m1"));
  expect(offline("m1").code).toBe("machine_offline");
  const failed = fromExecutor(ExecutorError.failed("m1", "read", "disk full", "Free some space."));
  expect([failed.code, failed.message, failed.fix]).toEqual(["failed", "the node on m1 refused or failed the read request: disk full", "Free some space."]);
  expect(fromExecutor(new Error("boom")).fix).toBe("Retry; if it keeps failing, check the machine with fleetd_status.");
  expect(fromExecutor("text").message).toBe("text");
});
