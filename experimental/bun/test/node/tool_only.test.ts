// The node core on the agents' Mac: its hello lists only a tool's calls, the areas' too (Rust's link `tool_only`), and
// what a runner would take comes back refused unopened (link.rs's agents_mac arms).
import { expect, test } from "bun:test";
import { CAPABILITIES } from "../../src/node/index.ts";
import { TOOL_ONLY } from "../../src/node/agents_mac/index.ts";
import { helloCapabilities, refusedOnMac } from "../../src/node/link/tool_only.ts";
import type { HubFrame } from "../../src/node/wire.ts";

test("a runner's hello lists the node core's calls then the areas'; the agents' Mac's lists only a tool's", () => {
  const areas = ["browser", "session_android", "agents_mac", "mac_tool"];
  expect(helloCapabilities(CAPABILITIES, areas, undefined)).toEqual([...CAPABILITIES, ...areas.filter((c) => !CAPABILITIES.includes(c as never))]);
  const mac = helloCapabilities(CAPABILITIES, areas, { tool: true });
  expect(mac[0]).toBe("agents_mac");
  expect(mac.at(-1)).toBe("mac_tool");
  expect(mac.filter((c) => c === "mac_tool" || c === "agents_mac")).toHaveLength(2);
  // Nothing that carries a secret, a claude, a Navi or a repo; an Android emulator isn't the Mac's to host.
  for (const gone of ["repos", "claude_install", "claude_login", "onepassword", "assistant", "session_android", "skills", "mcp_servers"])
    expect(mac).not.toContain(gone);
  for (const kept of ["self_update", "update_fetch", "update_hold", "link_deflate", "browser"]) expect(mac).toContain(kept);
  // Its tool off (not macOS): no mac_tool, whatever an area listed.
  expect(helloCapabilities(CAPABILITIES, areas, { tool: false })).not.toContain("mac_tool");
});

test("the agents' Mac refuses a secret, an approved command, a session's work and Claude's install, each in its reply kind", () => {
  const frame = (f: Record<string, unknown>) => f as HubFrame;
  expect(refusedOnMac(frame({ t: "secret_deliver", id: "s1", sink: "env", sealed: "x" }))).toEqual({ t: "secret_result", id: "s1", error: TOOL_ONLY });
  expect(refusedOnMac(frame({ t: "gated_run", id: "g1", argv: ["true"] }))).toEqual({ t: "gated_result", id: "g1", exitCode: null, outputTail: "", timedOut: false, error: TOOL_ONLY });
  expect(refusedOnMac(frame({ t: "session_call", id: "c1", call: { op: "launch" } }))).toMatchObject({
    t: "session_reply",
    id: "c1",
    result: { err: { code: "runner_unavailable", message: TOOL_ONLY } },
  });
  expect(refusedOnMac(frame({ t: "node_action", id: "a1", action: "claude_login" }))).toEqual({ t: "node_action_result", id: "a1", ok: false, message: TOOL_ONLY });
  // What every machine answers, and its updates, it takes.
  expect(refusedOnMac(frame({ t: "session_call", id: "c2", call: { op: "runner_info" } }))).toBeUndefined();
  expect(refusedOnMac(frame({ t: "session_call", id: "c3", call: { op: "project_remove" } }))).toBeUndefined();
  expect(refusedOnMac(frame({ t: "node_action", id: "a2", action: "update" }))).toBeUndefined();
  expect(refusedOnMac(frame({ t: "cmd_check", id: "k1" }))).toBeUndefined();
});
