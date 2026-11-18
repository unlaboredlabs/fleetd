// A bot's pick of its agents' computer on the hub (src/hub/projects/settings.ts, D571): its settings list each real
// machine it may have, provider and exact size together, only of what the team has; a pick is one of them exactly,
// kept, and the slot board places the bot's agents by it; a pick whose provider went stays shown, saying why.
import { expect, test } from "bun:test";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/server.ts";
import { computers } from "../src/hub/project_lead/store.ts";
import { slots } from "../src/hub/slots/index.ts";
import { events } from "../src/hub/store/events.ts";
import { key, kit, project } from "./work-kit.ts";

const GIB = 2 ** 30;

function bot(vms: "on" | "off" | "by choice" = "on") {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r, { title: "App" });
  k.hub.db.conn.run("INSERT INTO machines (machine_id, data) VALUES ('devbox', '{\"machineId\":\"devbox\",\"name\":\"devbox\",\"nodeVersion\":\"1\",\"status\":\"online\",\"lastSeenAt\":\"x\"}')");
  Object.assign(executors(k.hub), {
    isConnected: () => true,
    call: async (_m: string, _op: string, call: Record<string, unknown>) => {
      if (call.op === "project_worktrees") return { kind: "project_worktrees", dir: "/w", worktrees: [] };
      if (call.op === "project_image") return { kind: "project_image", image: { state: "none" } };
      throw new Error(`unexpected ${String(call.op)}`);
    },
  });
  Object.assign(link(k.hub), { can: () => true });
  const sandbox =
    vms === "on" ? { kind: "microvm" as const } : vms === "off" ? { kind: "process" as const, why: "no /dev/kvm" } : { kind: "process" as const, why: "turned off", expected: true as const };
  slots(k.hub).observeMachine("devbox", "devbox", { cpus: 16, load1: 0, memTotalBytes: 32 * GIB, sandbox });
  const connect = (p: string) => k.hub.db.conn.run("INSERT INTO sandbox_providers (provider, sealed, max_agents) VALUES (?1, x'00', 3)", [p]);
  const get = async () => (await k.ok(key("read"), "project_settings_get", r)).settings;
  return { k, r, connect, get };
}

test("the choices are each real machine the bot can have: its machine's Local VM sizes that fit, then each connected provider's", async () => {
  const { connect, get } = bot();
  connect("e2b");
  const s = await get();
  expect(s.computer).toBeUndefined();
  expect(s.computers.map((c: { label: string }) => c.label)).toEqual([
    "Local VM · 2 vCPU / 4 GB",
    "Local VM · 4 vCPU / 8 GB",
    "Local VM · 8 vCPU / 16 GB",
    "E2B · 2 vCPU / 4 GB",
    "E2B · 4 vCPU / 8 GB",
    "E2B · 8 vCPU / 8 GB",
  ]);
  expect(s.computers.every((c: { unavailable?: string }) => c.unavailable === undefined)).toBe(true);
});

test("VMs that can't run now say why on each; VMs off by choice aren't offered; a repo's read has no choices", async () => {
  const off = bot("off");
  expect((await off.get()).computers).toEqual([
    { kind: "vm", cpu: 2, memGb: 4, label: "Local VM · 2 vCPU / 4 GB", unavailable: "devbox runs no VMs now: no /dev/kvm" },
    { kind: "vm", cpu: 4, memGb: 8, label: "Local VM · 4 vCPU / 8 GB", unavailable: "devbox runs no VMs now: no /dev/kvm" },
    { kind: "vm", cpu: 8, memGb: 16, label: "Local VM · 8 vCPU / 16 GB", unavailable: "devbox runs no VMs now: no /dev/kvm" },
  ]);
  const chosen = bot("by choice");
  expect((await chosen.get()).computers).toEqual([]);
});

test("a pick is one of the choices exactly, kept, and the slot board places the bot's agents by it; the default drops it", async () => {
  const { k, r, connect, get } = bot();
  connect("e2b");
  const before = events(k.hub).page(0).events.length;
  const out = await k.ok(key("operate"), "project_settings_set", { ...r, computer: { kind: "e2b", cpu: 4, memGb: 8 } });
  expect(out.settings.computer).toEqual({ kind: "e2b", cpu: 4, memGb: 8 });
  expect(out.next).toBe("Its agents start on E2B · 4 vCPU / 8 GB from now on; running ones keep theirs until they next start.");
  expect(computers(k.hub.db.conn)).toEqual([[r, { kind: "e2b", cpu: 4, memGb: 8 }]]);
  expect(events(k.hub).page(0).events.slice(before).map((e) => [e.type, e.data])).toEqual([["project.settings", { computer: { kind: "e2b", cpu: 4, memGb: 8 } }]]);
  // A size E2B doesn't give, a provider not connected, a VM bigger than the machine: refused, never rounded.
  expect(await k.refused(key("operate"), "project_settings_set", { ...r, computer: { kind: "e2b", cpu: 4, memGb: 6 } })).toBe("invalid");
  expect(await k.refused(key("operate"), "project_settings_set", { ...r, computer: { kind: "boat", cpu: 2, memGb: 4 } })).toBe("invalid");
  expect(await k.refused(key("operate"), "project_settings_set", { ...r, computer: { kind: "vm", cpu: 16, memGb: 32 } })).toBe("invalid");
  expect(await k.refused(key("read"), "project_settings_set", { ...r, computer: { kind: "vm", cpu: 2, memGb: 4 } })).toBe("forbidden");
  expect((await get()).computer).toEqual({ kind: "e2b", cpu: 4, memGb: 8 });
  // The board has it: the bot's agent goes to E2B at that size, though the machine has room.
  const grant = slots(k.hub).acquire({ holder: "T1", projectRef: r, priority: "work", hostable: true } as never);
  // Until the board has E2B's limit and the machine its key, the agent waits for E2B, not for the machine's slots.
  expect(grant).toEqual({ granted: false, reason: "its bot's computer is E2B · 4 vCPU / 8 GB, and E2B isn't connected: an admin connects it in Settings › Hub › Machines, or pick another on the bot's Computer page" });
  slots(k.hub).setHosted([{ provider: "e2b", max: 3 }]);
  expect(slots(k.hub).placeOf("T1")).toBeUndefined();
  slots(k.hub).observeMachine("devbox", "devbox", { cpus: 16, load1: 0, memTotalBytes: 32 * GIB, sandbox: { kind: "microvm" }, sandboxes: ["e2b"] });
  expect([slots(k.hub).placeOf("T1"), slots(k.hub).sizeOf("T1")]).toEqual(["e2b", { cpu: 4, memGb: 8 }]);
  // Back to the default: nothing kept, placed as before.
  const back = await k.ok(key("operate"), "project_settings_set", { ...r, computerDefault: true });
  expect(back.settings.computer).toBeUndefined();
  expect(computers(k.hub.db.conn)).toEqual([]);
  expect(await k.refused(key("operate"), "project_settings_set", { ...r, computer: { kind: "vm", cpu: 2, memGb: 4 }, computerDefault: true })).toBe("invalid");
});

test("a pick whose provider was disconnected stays shown, saying why, never as another size or provider", async () => {
  const { k, r, connect, get } = bot();
  connect("daytona");
  await k.ok(key("operate"), "project_settings_set", { ...r, computer: { kind: "daytona", cpu: 4, memGb: 8 } });
  k.hub.db.conn.run("DELETE FROM sandbox_providers WHERE provider = 'daytona'");
  const s = await get();
  expect(s.computer).toEqual({ kind: "daytona", cpu: 4, memGb: 8 });
  expect(s.computers.at(-1)).toEqual({
    kind: "daytona",
    cpu: 4,
    memGb: 8,
    label: "Daytona · 4 vCPU / 8 GB",
    unavailable: "Daytona isn't connected: an admin connects it in Settings › Hub › Machines",
  });
  expect(s.computers.filter((c: { kind: string }) => c.kind === "daytona")).toHaveLength(1);
});
