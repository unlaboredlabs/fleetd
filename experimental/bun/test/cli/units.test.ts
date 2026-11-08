// The systemd unit fleetd init writes, against the Rust tree's own snapshot (crates/fleetd/src/cli/setup/snapshots/
// node.service), and a unit from any version read back and rewritten from today's template (units.rs tests).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownUnit, parseSystemdUnit, refreshSystemdUnit, renderSystemdUnit, type ServiceSpec } from "../../src/cli/setup/units.ts";

const fresh = readFileSync(join(import.meta.dir, "../../../../crates/fleetd/src/cli/setup/snapshots/node.service"), "utf8");

const spec = (): ServiceSpec => ({
  role: "node",
  description: "fleetd node",
  program: ["/home/a b/.fleetd/bin/fleetd", "node", "run", "--home", "/home/a b/.fleetd/node", "100%", "$HOME"],
  env: [
    ["HOME", "/home/a b"],
    ["PATH", "/usr/bin:/a&b"],
  ],
  envFile: "/home/a b/.fleetd/hub.env",
  workingDirectory: "/home/a b",
  logPath: "/home/a b/.fleetd/logs/node.log",
});

test("the node's unit is the Rust binary's, OOM lines and all", () => {
  expect(renderSystemdUnit(spec())).toBe(fresh);
});

test("an older unit is rewritten from today's template; a hand-edited one is left alone", () => {
  expect(parseSystemdUnit(fresh, "node")).toEqual(spec());
  expect(refreshSystemdUnit(fresh, "node")).toBeUndefined();
  const older = fresh.replace("OOMPolicy=continue\nOOMScoreAdjust=-900\nManagedOOMPreference=avoid\n", "");
  expect(refreshSystemdUnit(older, "node")).toBe(fresh);
  const { envFile: _, ...noEnvFile } = spec();
  const hub = renderSystemdUnit({ ...noEnvFile, role: "hub" });
  expect(hub).toContain("\nOOMScoreAdjust=-900\nManagedOOMPreference=avoid\nRestart=always\n");
  expect(hub).not.toContain("OOMPolicy");
  expect(refreshSystemdUnit(hub.replace("OOMScoreAdjust=-900\nManagedOOMPreference=avoid\n", ""), "hub")).toBe(hub);
  // A value with `$$` keeps it outside ExecStart, where systemd reads it as is.
  const dollars: ServiceSpec = { ...spec(), env: [["A", 'x$$y "q" \\']] };
  expect(parseSystemdUnit(renderSystemdUnit(dollars), "node")).toEqual(dollars);
  expect(refreshSystemdUnit(fresh.replace("RestartSec=5\n", "RestartSec=5\nMemoryMax=4G\n"), "node")).toBeUndefined();
  expect(refreshSystemdUnit("[Service]\nType=simple\n", "node")).toBeUndefined();
});

test("ownUnit: the service under the user's manager, not an agent's scope or a system unit", () => {
  expect(ownUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node.service\n")).toBe("fleetd-node.service");
  expect(ownUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n")).toBeUndefined();
  expect(ownUnit("0::/system.slice/fleetd-node.service\n")).toBeUndefined();
  expect(ownUnit("0::/user.slice/user-1000.slice/user@1000.service\n")).toBeUndefined();
  expect(ownUnit("")).toBeUndefined();
});
