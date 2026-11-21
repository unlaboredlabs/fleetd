// The user's service manager coming back by itself (W781): systemd's user@.service has no Restart=, so a lingering
// user's manager that gets a SIGTERM stays down, the hub and node with it, until that user logs in. Setup writes a root
// drop-in where it may be root without a password, and else says the one command; the doctor checks both.
import { expect, test } from "bun:test";
import { keepManagerCommand, managerDropIn } from "../../src/cli/setup/units.ts";
import { type Facts, freshFacts, type MachineAddInput, parseFacts, planMachineAdd, probeCommand } from "../../src/cli/setup/machine_plan.ts";
import * as c from "../../src/hub/doctor/checks.ts";
import { matchesCheck } from "../../src/hub/setup/index.ts";

// The command tested in a throwaway systemd container (scripts/manager-restart.sh): after it, a SIGTERM to the user's
// manager has it, the hub and the node back within seconds.
const DEVBOX =
  `sudo sh -c "loginctl enable-linger wynn && mkdir -p /etc/systemd/system/user@1000.service.d && ` +
  `printf '[Service]\\nRestart=always\\nRestartSec=5\\n' > /etc/systemd/system/user@1000.service.d/fleetd.conf && systemctl daemon-reload"`;

test("the one command an admin pastes: linger and Restart=always on the user's manager, nothing else", () => {
  expect(keepManagerCommand("wynn", 1000)).toBe(DEVBOX);
  expect(managerDropIn(1000)).toBe("/etc/systemd/system/user@1000.service.d/fleetd.conf");
});

test("the probe asks for root only while linger or the restart is missing, and never for a password", () => {
  const line = probeCommand().split("\n").find((l) => l.includes("manager_restart"))!;
  expect(line).toContain('systemctl show "user@$(id -u).service" -p Restart --value');
  expect(line).toContain('if [ "${K}" != always ] || [ "${L}" != yes ]');
  expect(line).toContain("sudo -n true");
  const facts = parseFacts("home /home/dev\nos Linux\nlinger yes\nmanager_restart no\nroot sudo");
  expect([facts.linger, facts.managerRestart, facts.root]).toEqual(["yes", "no", "sudo"]);
});

const input: MachineAddInput = {
  machineId: "devbox",
  hubUrl: "http://devbox:4790",
  gitIdentity: { name: "Dev", email: "dev@example.com" },
  binaryDigest: "d",
  binaryTarget: ["linux", "x64"],
  version: "0.0.0",
  hubHasNodeKey: false,
  service: true,
  mac: false,
};
const facts = (over: Partial<Facts>): Facts => ({ ...freshFacts("dev", "x64"), ...over });
const plan = (over: Partial<Facts>, i: Partial<MachineAddInput> = {}) => planMachineAdd(facts(over), { ...input, ...i });
const keepStep = (p: ReturnType<typeof plan>) => p.steps.find((s) => s.title === "keep dev's service manager running by itself");

test("setup arranges it where it may be root, and else notes the command", () => {
  const sudo = plan({ managerRestart: "no", root: "sudo" });
  expect(keepStep(sudo)?.command).toBe(`sudo -n sh -c "${keepManagerCommand("dev", 1000).slice('sudo sh -c "'.length)}`);
  expect(sudo.notes.join("\n")).not.toContain("service manager");
  // The step comes before the node's start.
  expect(sudo.steps.indexOf(keepStep(sudo)!)).toBe(sudo.steps.length - 2);
  expect(keepStep(plan({ managerRestart: "no", root: "root" }))?.command).toStartWith('sh -c "loginctl enable-linger dev && ');

  const none = plan({ managerRestart: "no", root: "no" });
  expect(keepStep(none)).toBeUndefined();
  expect(none.notes).toContain(
    `if dev's service manager (systemd --user) stops, nothing starts it again until dev logs in, so the node stays down. Fix: ${keepManagerCommand("dev", 1000)}`,
  );
  // Linger off is the same command's to fix.
  expect(plan({ linger: "no", managerRestart: "no", root: "no" }).notes).toContain(
    `linger is no for dev, so the node stops when dev logs out. Fix: ${keepManagerCommand("dev", 1000)}`,
  );

  // Arranged already, or no service to keep: nothing.
  for (const p of [plan({ managerRestart: "always", root: "sudo" }), plan({ managerRestart: "no", root: "sudo" }, { service: false })]) {
    expect(keepStep(p)).toBeUndefined();
    expect(p.notes.join("\n")).not.toContain("service manager");
  }
});

test("the doctor's service_manager check: ok, the command while it's missing, nothing where there's nothing to tell", () => {
  const m = { user: "wynn", uid: 1000, linger: true, restarts: false };
  const node = c.serviceManager("devbox", "node", m)!;
  expect([node.id, node.status, node.message]).toEqual([
    "devbox/service_manager",
    "warn",
    "If wynn's service manager (systemd --user) stops, nothing starts it again until wynn logs in: the node stays down, and every agent with it.",
  ]);
  expect([node.fix?.label, node.fix?.command, node.fix?.on]).toEqual(["As an admin on devbox, once", DEVBOX, "machine"]);
  const hub = c.serviceManager("hub", "hub", { ...m, linger: false })!;
  expect([hub.id, hub.status, hub.fix?.command, hub.fix?.on]).toEqual(["hub/service_manager", "warn", DEVBOX, "hub"]);
  expect(hub.message).toBe("Linger is off for wynn: the hub stops when wynn logs out, and starts again only at their next login.");
  const ok = c.serviceManager("devbox", "node", { ...m, restarts: true })!;
  expect([ok.status, ok.fix]).toEqual(["ok", undefined]);
  expect(c.serviceManager("devbox", "node", undefined)).toBeUndefined();
  // The setup steps read them: the hub's under where it listens, each machine's under where agents run.
  expect(matchesCheck("*/service_manager", node.id)).toBe(true);
  expect(matchesCheck("hub/service_manager", hub.id)).toBe(true);
});
