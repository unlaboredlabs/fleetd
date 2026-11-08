import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeFirstUse, guides, hostOf, matchesCheck, q, read, requiredLeft } from "../src/hub/setup/index.ts";
import type { DoctorCheck, HubSetupStep } from "../src/shared/contracts.ts";

/** The app's setup fixture: the Rust hub's own guides for http://devbox:4790 (hub/setup/fixtures.rs writes it). */
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../../app/desktop/fixtures/setup/steps.json"), "utf8")) as {
  hub: string;
  guides: HubSetupStep[];
};

const check = (id: string, status: DoctorCheck["status"], message = id, fix?: DoctorCheck["fix"]): DoctorCheck => ({
  id,
  scope: id.startsWith("hub/") ? "hub" : "machine",
  status,
  message,
  ...(fix ? { fix } : {}),
});

test("every step's guide is the Rust hub's own, word for word", () => {
  expect(JSON.parse(JSON.stringify(guides(fixture.hub, "0.0.0")))).toEqual(fixture.guides);
});

test("values are computed for this hub, and an address only this machine reaches says so", () => {
  expect(hostOf("http://devbox.tail1234.ts.net:4790")).toBe("devbox");
  expect(hostOf("http://100.64.0.1:4790")).toBe("hub");
  expect(hostOf("http://[::1]:4790/")).toBe("hub");
  const local = guides("http://127.0.0.1:4790");
  const address = local.find((s) => s.id === "address");
  expect(address?.parts[0]?.values?.[0]?.note).toStartWith("Only this machine can reach the hub");
  const machines = local.find((s) => s.id === "machines");
  expect(machines?.parts[0]?.values?.[1]?.note).toStartWith("The hub is only at http://127.0.0.1:4790");
  expect(guides("http://devbox:4790", "0.6.0").find((s) => s.id === "mac")?.parts[1]?.values?.[0]?.value).toEndWith(
    "--machine-id mac --mac --version 0.6.0",
  );
  expect(q("it's")).toBe("'it'\\''s'");
});

test("a step is to do until a check says otherwise; any one way done is enough, and it says which", () => {
  const steps = guides("http://devbox:4790");
  const fresh = read(steps, []);
  expect(fresh.every((s) => s.status === "todo")).toBe(true);
  expect(fresh.filter(requiredLeft).map((s) => s.id)).toEqual(["address", "machines", "claude"]);
  const claude = (checks: DoctorCheck[]) => read(steps, checks).find((s) => s.id === "claude");
  const logins = claude([check("hub/claude_key", "unknown"), check("devbox/claude_login", "ok", "claude is logged in")]);
  expect([logins?.status, logins?.way, logins?.said]).toEqual(["done", "each machine's own login", "claude is logged in"]);
  const failing = claude([
    check("devbox/claude_login", "fail", "devbox: claude is not logged in", { kind: "manual", label: "log in", command: "claude auth login", on: "devbox" } as never),
  ]);
  expect([failing?.status, failing?.failing, failing?.fix?.label]).toEqual(["look", true, "log in"]);
  expect(requiredLeft(failing as HubSetupStep)).toBe(true);
  const warn = claude([check("hub/claude_key", "warn", "the key's last test is old")]);
  expect([warn?.status, warn?.failing]).toEqual(["look", false]);
  expect(requiredLeft(warn as HubSetupStep)).toBe(false);
});

test("the Mac's step reads its own checks on any machine; the hub's never count", () => {
  expect(matchesCheck("*/online", "devbox/online")).toBe(true);
  expect(matchesCheck("*/online", "hub/online")).toBe(false);
  expect(matchesCheck("hub/people", "hub/people")).toBe(true);
  const mac = read(guides("http://devbox:4790"), [check("mac/mac_xcode", "fail", "no Xcode"), check("mac/mac_developer", "ok")]).find((s) => s.id === "mac");
  expect([mac?.status, mac?.said]).toEqual(["look", "no Xcode"]);
});

test("GitHub is to do, not failing, before any project can open a PR", () => {
  const gh = [check("hub/gh_auth", "fail", "gh is not logged in")];
  const before = read(guides("http://devbox:4790"), beforeFirstUse(gh, 0)).find((s) => s.id === "github");
  expect(before?.status).toBe("todo");
  const after = read(guides("http://devbox:4790"), beforeFirstUse(gh, 1)).find((s) => s.id === "github");
  expect([after?.status, after?.failing]).toEqual(["look", true]);
});

test("the setup tools are an admin's: admin on every machine", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { Registry } = await import("../src/hub/api/registry.ts");
  const { registerAll } = await import("../src/gen/areas.ts");
  const { HubDb } = await import("../src/hub/store/db.ts");
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 4790 } }, HubDb.memory(), { now: () => 0 });
  const tools = new Registry();
  registerAll(tools);
  const caller = { keyId: "k", name: "k", prefix: "fld_x", grants: [{ role: "admin" as const, machines: ["devbox"] }], createdAt: "x" };
  for (const tool of ["setup_list", "setup_test"]) {
    const out = await tools.call(hub, caller, tool, tool === "setup_test" ? { step: "address" } : {});
    expect(out).toMatchObject({
      error: { kind: "tool", error: { code: "forbidden", message: "The hub's setup is for its owners and admins: a key with admin on every machine." } },
    });
  }
});
