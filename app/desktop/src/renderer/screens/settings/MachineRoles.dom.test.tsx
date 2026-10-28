// @vitest-environment happy-dom
// Hub › Machines' roles: each machine's roles, session slots and what it can host, read from machine_roles; a role
// change goes out as machine_roles_set and the hub's line about it shows under the row.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { MachineRoles } from "./MachineRoles";

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
    { host: "ios", ready: false, detail: "iOS simulators need macOS" },
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
  hosts: [{ host: "ios", ready: true, detail: "Xcode with 6 iOS simulators" }],
};

const machine = (id: string) => ({ machineId: id, name: id, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [] });

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
          ? { machines: [devbox, mac1] }
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
          <MachineRoles />
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

it("shows each machine's roles, sessions and what it can host in plain words", async () => {
  await render();
  const box = row("devbox");
  expect(pressed(box)).toBe("Both");
  expect(box?.textContent).toContain("1 of 4 screens now (auto: 8 CPUs, 16 GB)");
  expect(box?.textContent).toContain("Chrome at /usr/bin/google-chrome");
  expect(box?.textContent).toContain("but no /dev/kvm: the emulator needs KVM");
  const hosts = [...(box?.querySelectorAll("ul li") ?? [])].map((li) => li.firstElementChild?.textContent);
  expect(hosts).toEqual(["Browser", "Desktop", "Android emulator", "iOS simulator"]);
  expect(pressed(row("mac1"))).toBe("Screens");
  expect(row("mac1")?.textContent).toContain("Xcode with 6 iOS simulators");
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
