// @vitest-environment happy-dom
// A machine's role, on its page in Hub › Machines: read from machine_roles; a role change goes out as
// machine_roles_set and the hub's line about it shows under it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useToolQuery } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { MachineRole } from "./MachineRoles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-26T10:00:00.000Z";

const devbox: MachineRolesEntry = {
  machineId: "devbox",
  name: "devbox",
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 4,
  maxSessionsWhy: "auto: 8 CPUs, 16 GB",
  sessionsLive: 1,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome" },
    { host: "android", ready: false, detail: "Android SDK at /home/dev/Android/Sdk, but no /dev/kvm: the emulator needs KVM" },
    { host: "mac", ready: false, detail: "the Mac screen is a Mac's own: its agents session's screen", off: "unsupported" },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb" },
  ],
  hostsOthers: true,
};
const mac1: MachineRolesEntry = {
  ...devbox,
  machineId: "mac1",
  name: "mac1",
  roles: ["sessions"],
  sessionsLive: 0,
  hosts: [{ host: "mac", ready: true, detail: "the agents session is on the Mac's screen" }],
};

/** The agents' Mac: no roles to pick, its switch, and why agents can't use it now. */
const agentsMac: MachineRolesEntry = {
  ...mac1,
  machineId: "studio",
  name: "studio",
  mac: { on: true, ready: false, note: "studio's node doesn't offer the tool: it runs on macOS only." },
};

const machine = (id: string) => ({ machineId: id, name: id, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [] });

/** Each machine's role, as its page shows it, under its name. */
function Roles() {
  const machines = useToolQuery("machine_roles", {}).data?.machines ?? [];
  return machines.map((m) => (
    <section key={m.machineId} aria-labelledby={`machine-${m.machineId}-name`}>
      <span id={`machine-${m.machineId}-name`}>{m.name}</span>
      <MachineRole machine={m} />
    </section>
  ));
}

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const output =
        tool === "machine_roles"
          ? { machines: [devbox, mac1, agentsMac] }
          : tool === "machine_roles_set"
            ? { machine: { ...devbox, roles: ["agents"] }, next: "devbox takes no new agents: those running finish their work, and its projects' agents wait." }
            : {};
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Roles />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [machine("devbox"), machine("mac1")], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const row = (name: string) => host.querySelector<HTMLElement>(`section[aria-labelledby="machine-${name}-name"]`);
const pressed = (within: HTMLElement | null) => within?.querySelector('button[aria-pressed="true"]')?.textContent;

it("shows each machine's role in plain words", async () => {
  await render();
  const box = row("devbox");
  expect(pressed(box)).toBe("Both");
  // What it does as chosen is the row's title; the rest of it is the quiet line under.
  expect(box?.textContent).toContain("Runs agents and hosts screens");
  expect(box?.textContent).toContain("Its own agents' screens come first.");
  expect(pressed(row("mac1"))).toBe("Screens");
});

it("sets a machine's roles with machine_roles_set and says what follows", async () => {
  await render();
  const agentsOnly = [...(row("devbox")?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Agents");
  await act(async () => {
    agentsOnly?.click();
    await Promise.resolve();
  });
  await settle();
  expect(calls.find((c) => c.tool === "machine_roles_set")?.input).toEqual({ machineId: "devbox", roles: ["agents"] });
  expect(row("devbox")?.textContent).toContain("devbox takes no new agents");
});

it("gives the agents' Mac its switch instead of roles, and says why agents can't use it now", async () => {
  await render();
  const mac = row("studio");
  expect(pressed(mac)).toBeUndefined();
  expect(mac?.textContent).toContain("Agents may use this Mac");
  expect(mac?.textContent).toContain("Agents build iOS apps and run simulators here. It runs no agents itself.");
  expect(mac?.textContent).toContain("it runs on macOS only");
  const toggle = mac?.querySelector<HTMLButtonElement>('button[role="switch"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    toggle?.click();
    await Promise.resolve();
  });
  await settle();
  expect(calls.find((c) => c.tool === "machine_roles_set")?.input).toEqual({ machineId: "studio", macTool: false });
});
