// A bot's safety settings changed by a teammate (an admin: only admins may, #2228) say who changed them in the workspace's log: its approvals, who merges
// and how, its max agents and its automations (artifact enterprise-sweep-selfhosted, bug 2).
import { expect, test } from "bun:test";
import { people } from "../src/hub/people/store.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { eventsOf, testHub } from "./people-kit.ts";

test("an admin's change to a bot's approvals, merges, max agents and automations names them", async () => {
  const { hub, call, device, clock } = testHub();
  const r = { machineId: "devbox", projectId: "p1" };
  const at = new Date(clock.now()).toISOString();
  store(hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: at } as never);
  store(hub).projectsUpsertMany("devbox", [
    { ...r, title: "acme-web", workspaceRoot: "/srv/p1", lastActivityAt: at, threads: { failed: 0, idle: 0, running: 0, waiting: 0 } } as never,
  ]);
  const bea = people(hub).create("Bea Admin", "admin");
  const laptop = device([{ role: "admin", machines: "*" }], bea.personId, "bea-laptop");

  await call(laptop, "project_approvals_set", { ...r, mode: "yolo" });
  await call(laptop, "project_settings_set", { ...r, merges: "fleetd" });
  await call(laptop, "cap_set", { project: { projectRef: r, maxAgents: 3 } });
  await call(laptop, "automation_create", { projectRef: r, name: "Nightly", prompt: "Check the build.", schedule: { at: "2026-12-01T09:00", tz: "Europe/Amsterdam" }, clientRequestId: "c1" });

  const said = [...eventsOf(hub, "project.settings"), ...eventsOf(hub, "agents.cap"), ...eventsOf(hub, "automation.changed")].map((e) => e.summary);
  expect(said).toContain("acme-web's approvals: yolo, by Bea Admin");
  expect(said).toContain("fleetd merges acme-web's PRs now, by Bea Admin");
  expect(said.some((s) => s.startsWith("Max agents") && s.endsWith(" By Bea Admin."))).toBe(true);
  expect(said).toContain("Automation “Nightly” created, by Bea Admin");
  const merged = eventsOf(hub, "project.settings").find((e) => e.summary.startsWith("fleetd merges"));
  expect((merged?.data as { by?: unknown }).by).toEqual({ name: "Bea Admin", personId: bea.personId });
});
