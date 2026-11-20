// The hub's own runner is no computer (W743): no join code is minted for its id, no computer enrolls as it with a code
// a person made, and it has no roles or max of its own to set, as machine_remove already refuses. Only the hub's own
// code, which hub/runner mints, enrolls a node as it.
import { expect, test } from "bun:test";
import { createEnrollToken } from "../src/cli/store.ts";
import { sha256 } from "../src/hub/auth/index.ts";
import { RUNNER_ID } from "../src/shared/sandbox.ts";
import { addMachine, caller, testHub } from "./screens_helpers.ts";

const KEY = "a".repeat(43);
const admin = caller("admin", { kind: "human" });
const message = (out: unknown) => {
  const o = out as { error?: { kind: string; error: { message: string } } };
  return o.error?.kind === "tool" ? o.error.error.message : undefined;
};

test("machine_join mints no code for hosted, and a code for another machine still works", async () => {
  const t = testHub();
  const out = await t.tools.call(t.hub, admin, "machine_join", { machineId: RUNNER_ID, rejoin: true });
  expect(message(out)).toBe("Hosted sandboxes are the hub's own, not a computer of the team's: nothing joins as them.");
  expect(t.hub.auth.nodes.openEnrollTokens()).toEqual([]);
  expect(() => t.hub.auth.nodes.createEnrollToken(RUNNER_ID, "test")).toThrow("nothing joins as them");
  expect(() => createEnrollToken(t.hub.db, RUNNER_ID)).toThrow("nothing joins as them");
  const code = t.hub.auth.nodes.createEnrollToken("devbox", "test").token;
  expect(t.hub.auth.nodes.enrollNode(code, "devbox", KEY)).toBe("devbox");
  t.done();
});

test("a named code for hosted made before this guard enrolls nothing; the hub's own runner's code does", () => {
  const t = testHub();
  // As main minted it for Repair's line: a row naming hosted.
  const old = "fle_oldhostedcode";
  t.hub.db.conn.query("INSERT INTO enroll_tokens (hash, machine_id, expires_ms) VALUES (?, ?, ?)").run(sha256(old), RUNNER_ID, t.clock.now() + 60_000);
  expect(() => t.hub.auth.nodes.enrollNode(old, RUNNER_ID, KEY)).toThrow("hosted is the hub's own runner");
  expect(t.hub.auth.nodes.nodePubKey(RUNNER_ID)).toBeUndefined();
  // The runner's own code is listed under hosted, works for no other id, and enrolls the runner.
  const own = t.hub.auth.nodes.createRunnerEnrollToken().token;
  expect(t.hub.auth.nodes.openEnrollTokens().map((c) => c.machineId)).toContain(RUNNER_ID);
  expect(() => t.hub.auth.nodes.enrollNode(own, "devbox", "b".repeat(43))).toThrow("for machine hosted, not devbox");
  expect(t.hub.auth.nodes.enrollNode(own, RUNNER_ID, KEY)).toBe(RUNNER_ID);
  expect(t.hub.auth.nodes.nodePubKey(RUNNER_ID)).toBe(KEY);
  // A new code of its own replaces its open one.
  const first = t.hub.auth.nodes.createRunnerEnrollToken().token;
  t.hub.auth.nodes.createRunnerEnrollToken();
  expect(() => t.hub.auth.nodes.enrollNode(first, RUNNER_ID, KEY)).toThrow("unknown, replaced or revoked");
  t.done();
});

test("machine_roles_set and cap_set refuse hosted, and still change a computer", async () => {
  const t = testHub();
  addMachine(t.hub, RUNNER_ID, { runner: true });
  addMachine(t.hub, "devbox");
  const roles = await t.tools.call(t.hub, admin, "machine_roles_set", { machineId: RUNNER_ID, roles: ["sessions"] });
  expect(message(roles)).toBe("Hosted sandboxes are the hub's own, not a computer of the team's: they have no roles to change.");
  const cap = await t.tools.call(t.hub, admin, "cap_set", { machine: { machineId: RUNNER_ID, maxAgents: 4 } });
  expect(message(cap)).toBe("Hosted sandboxes are the hub's own, not a computer of the team's: boat.dev's limit is how many run at once.");
  const auto = await t.tools.call(t.hub, admin, "cap_set", { machine: { machineId: RUNNER_ID, auto: true } });
  expect(message(auto)).toContain("boat.dev's limit");
  expect(message(await t.tools.call(t.hub, admin, "machine_roles_set", { machineId: "devbox", roles: ["agents"] }))).toBeUndefined();
  expect(message(await t.tools.call(t.hub, admin, "cap_set", { machine: { machineId: "devbox", maxAgents: 4 } }))).toBeUndefined();
  t.done();
});
