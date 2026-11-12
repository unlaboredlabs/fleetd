import { expect, test } from "bun:test";
import { uuidFrom } from "../src/hub/executor/ids.ts";
import { launchCall, oldNodeLaunch } from "../src/hub/executor/launch_call.ts";

const input = { projectId: "p", prompt: "Do it.", profile: "high", runtimeMode: "full-access", clientRequestId: "r1" } as const;
const got = { title: "Do it", runner: "claude", rules: { allow: ["Bash"], deny: ["WebFetch"] }, skills: [], prompt: "Do it." } as never;

test("a launch's call names its session and run from the request, so a retry is the same session", () => {
  const call = launchCall("m1", input, {}, got);
  expect(call.sessionId).toBe(uuidFrom("session\nm1\nr1"));
  expect(call.runId).toBe(uuidFrom("run\nm1\nr1"));
  expect(call).toMatchObject({ projectId: "p", title: "Do it", runner: "claude", profile: "high", workspace: { type: "root" }, role: "plain" });
  expect(call.allowedTools).toEqual(["Bash"]);
  expect(call.disallowedTools).toEqual(["WebFetch"]);
  expect(launchCall("m1", input, {}, got)).toEqual(call);
});

test("a launch's options and profile shape the call; an older node reads only what it knows", () => {
  const chosen = { profile: "max", model: "claude-opus-5-5", effort: "xhigh", fast: true } as const;
  const call = launchCall("m1", input, { onlyTools: ["Read"], role: "worker", orderId: "W2", model: ["claude-sonnet-5-5", "low"] }, {
    ...(got as object),
    chosen,
  } as never);
  expect(call).toMatchObject({ profile: "max", model: "claude-sonnet-5-5", effort: "low", fast: true, allowedTools: ["Read"], allowedOnly: true, role: "worker", orderId: "W2" });
  expect(oldNodeLaunch(chosen)).toEqual({ profile: "high", model: "claude-opus-5-5", effort: "high", fast: false });
});
