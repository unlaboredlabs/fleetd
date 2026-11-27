// An approved command that didn't run, as the card says it: the second quality sweep read "not run on factory-a:
// could not start fly: spawn fly ENOENT" for a program the machine doesn't have.
import { expect, test } from "bun:test";
import { notRunWhy } from "../src/hub/approvals/index.ts";

test("a missing program says it isn't installed there; other failures keep the node's words", () => {
  expect(notRunWhy("factory-a", "could not start fly: spawn fly ENOENT")).toBe("fly isn't installed on factory-a, or isn't on the PATH fleetd runs commands with.");
  expect(notRunWhy("devbox", "could not start ./deploy.sh: spawn ./deploy.sh EACCES")).toBe("devbox doesn't let fleetd run ./deploy.sh: it isn't executable for fleetd's user.");
  expect(notRunWhy("devbox", "no workspace")).toBe("not run on devbox: no workspace");
});
