import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { TOOLS } from "../src/hub/api/tool_roles.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { systemClock } from "../src/shared/clock.ts";
import type { Role } from "../src/shared/contracts.ts";

const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), systemClock);
const caller = (role: Role, kind?: "human"): Caller => ({
  keyId: "key_t",
  name: "t",
  prefix: "fld_abcdef",
  grants: [{ role, machines: "*" }],
  createdAt: new Date(0).toISOString(),
  ...(kind ? { kind } : {}),
});

test("every tool in the contracts' table is registered, a stub until its module replaces it", async () => {
  const tools = new Registry();
  registerAll(tools);
  expect(tools.names().sort() as string[]).toEqual(Object.keys(TOOLS).sort());
  expect(Object.keys(TOOLS).length).toBeGreaterThan(150);
  // Before its module's register runs, a tool is the stub that names the module.
  const result = await new Registry().call(hub, caller("admin"), "fleetd_status", {});
  expect(result).toEqual({
    error: { kind: "tool", error: expect.objectContaining({ code: "failed", message: expect.stringContaining("src/hub/executor") }) },
  });
});

test("a module's handler replaces the stub, behind the tool's role", async () => {
  const tools = new Registry();
  tools.add("hub_info", () => ({ version: "x" }) as never);
  expect(await tools.call(hub, caller("read"), "hub_info", undefined)).toEqual({ output: { version: "x" } });
  // project_add needs operate.
  tools.add("project_add", () => ({}) as never);
  const refused = await tools.call(hub, caller("read"), "project_add", {});
  expect(refused).toEqual({
    error: { kind: "tool", error: expect.objectContaining({ code: "forbidden", message: "This key lacks the operate role." }) },
  });
});

test("unknown and removed tools", async () => {
  const tools = new Registry();
  expect(await tools.call(hub, caller("admin"), "frobnicate", {})).toEqual({ error: { kind: "unknown" } });
  expect(await tools.call(hub, caller("admin"), "telegram_pair", {})).toEqual({
    error: { kind: "tool", error: expect.objectContaining({ code: "not_found", message: "Telegram was removed from fleetd." }) },
  });
});

test("a crash is the generic failed, a person gets the person-facing fix", async () => {
  const tools = new Registry();
  tools.add("hub_info", () => {
    throw new Error("boom");
  });
  const quiet = console.error;
  console.error = () => {};
  const crashed = await tools.call(hub, caller("read"), "hub_info", {});
  console.error = quiet;
  expect(crashed).toEqual({
    error: { kind: "tool", error: expect.objectContaining({ code: "failed", message: "The hub failed to answer that request." }) },
  });
  const refused = await tools.call(hub, caller("operate", "human"), "hub_update", {});
  expect(refused).toEqual({
    error: { kind: "tool", error: expect.objectContaining({ code: "forbidden", fix: expect.stringContaining("fleetd pair") }) },
  });
});
