// A hub over a fresh home under $TMPDIR with one project, for the hub-work tests. Never the live hub's home.
import { Hub } from "../src/hub/api/hub.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ProjectRef, ProjectSummary, Role } from "../src/shared/contracts.ts";
import { openHubDb, tempHome } from "./helpers.ts";

export const PROJECT: ProjectRef = { machineId: "lab-a", projectId: "p1" };

export type ManualClock = { ms: number; now(): number };

export function testHub(at = Date.parse("2026-11-08T10:00:00Z")) {
  const home = tempHome();
  const clock: ManualClock = { ms: at, now: () => clock.ms };
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, openHubDb(home.dir), clock);
  store(hub).projectsUpsertMany(PROJECT.machineId, [
    {
      machineId: PROJECT.machineId,
      projectId: PROJECT.projectId,
      title: "Shop",
      workspaceRoot: "/srv/shop",
      lastActivityAt: new Date(at).toISOString(),
      threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
    } as unknown as ProjectSummary,
  ]);
  const done = () => {
    hub.shutdown.abort();
    hub.db.close();
    home.done();
  };
  return { hub, clock, home: home.dir, done };
}

export const caller = (role: Role, human = false, person?: { personId: string; name: string }): Caller => ({
  keyId: human ? "key_h" : "key_a",
  name: human ? "Ada's phone" : "agent",
  prefix: "fld_abcdef",
  grants: [{ role, machines: "*" }],
  createdAt: new Date(0).toISOString(),
  ...(human ? { kind: "human" as const } : {}),
  ...(person ? { person } : {}),
});
