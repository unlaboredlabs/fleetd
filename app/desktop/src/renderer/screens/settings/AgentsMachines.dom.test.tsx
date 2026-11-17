// @vitest-environment happy-dom
// A machine's agents, on its page in Hub › Machines: how many at once (where that comes from in its hover, what runs now
// beside it), the slider that sets it and the way back to auto, and where they run (each in a VM, or as processes with
// why and the fix); the line a fleet cap the CLI set gets under What runs where's Agents; and Settings → Projects → Agents' project slider past
// its machine's cap, which says the machine holds it, with the way to that machine's page for an owner or admin and
// nothing more for anyone else.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AgentsSettings, MachineCap } from "./Agents";
import { WhatRunsWhere } from "./Places";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Settings search reads the platform when it loads, before any test runs.
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-26T10:00:00.000Z";
const storefront = { machineId: "devbox", projectId: "storefront" };
// devbox: 60 GB, whose memory term fits 22. builder: set to 40. storefront set to 30, under a fleet cap of 50.
const slots: SlotState = {
  cap: 50,
  fleetCap: 50,
  used: 22,
  queued: 8,
  perMachine: [
    { machineId: "devbox", cap: 22, auto: 22, running: 22, why: "memory 60 GB, about 2 GB an agent" },
    { machineId: "builder", cap: 40, maxAgents: 40, auto: 28, running: 0, why: "28 of 32 CPUs" },
  ],
  perProject: [{ projectRef: storefront, maxAgents: 30, own: true, running: 22, queued: 8 }],
};

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [
      {
        machineId: "devbox",
        projectId: "storefront",
        title: "storefront",
        workspaceRoot: "/home/w/src/storefront",
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
        lastActivityAt: AT,
      },
    ],
    slots,
  },
};

/** The hub's slot state after a machine change, as cap_set answers it. */
function setMachine(now: SlotState, input: { machineId: string; maxAgents?: number; auto?: boolean }): SlotState {
  const perMachine = (now.perMachine ?? []).map((m) => {
    if (m.machineId !== input.machineId) return m;
    if (input.auto === true) return { machineId: m.machineId, cap: m.auto, auto: m.auto, running: m.running, why: m.why };
    const n = input.maxAgents ?? m.cap;
    return { ...m, cap: n, maxAgents: n };
  });
  return { ...now, perMachine };
}

let host: HTMLDivElement;
let root: Root;
/** The cap_set calls, in turn; the page's reads aside. */
let calls: { tool: string; input: unknown }[];

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null });
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `page`: each machine's cap as its page shows it, or storefront's Settings → Projects › Agents. `admin`: what hub_info
 * says of the key. */
const render = async (page: "hub" | "settings" = "hub", admin?: boolean, start: SlotState = slots) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  let now = start;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "cap_set") {
        calls.push({ tool, input });
        const machine = (input as { machine?: { machineId: string; maxAgents?: number; auto?: boolean } }).machine;
        if (machine !== undefined) now = setMachine(now, machine);
        return Promise.resolve({ ok: true, output: { slots: now } });
      }
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], ...(admin === undefined ? {} : { admin }) } });
      if (tool === "project_get") return Promise.resolve({ ok: true, output: { machineId: "devbox", projectId: "storefront", profiles: ["high"] } });
      // The rest of a project's Agents page (profiles, MCP servers, skills) finds a hub without them.
      return Promise.resolve({ ok: false, error: { code: "not_found", message: `${tool} isn't faked` } });
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
          {page === "hub" ? (
            <>
              <WhatRunsWhere />
              {["devbox", "builder"].map((id) => (
                <section key={id} aria-label={id}>
                  <MachineCap machineId={id} name={id} />
                </section>
              ))}
            </>
          ) : (
            <AgentsSettings route={{ tab: "agents", prompt: null, for: "devbox/storefront" }} />
          )}
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ ...snapshot, snapshot: { ...snapshot.snapshot, slots: start } });
    await Promise.resolve();
  });
};

const section = (label: string) => {
  const el = host.querySelector<HTMLElement>(`section[aria-label='${label}']`);
  if (el === null) throw new Error(`no section ${label}`);
  return el;
};
const button = (within: HTMLElement, text: string) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = (el: HTMLElement) =>
  act(async () => {
    el.click();
    await Promise.resolve();
  });

it("shows each machine's number, where it comes from, and a slider to change it", async () => {
  await render();
  const devbox = section("devbox");
  expect(devbox.querySelector("[role='slider']")?.getAttribute("aria-valuenow")).toBe("22");
  expect(devbox.querySelector("[role='slider']")?.getAttribute("aria-valuemax")).toBe("50");
  // Where the number comes from is the row's hover; what runs now sits beside the number.
  expect(devbox.querySelector("[data-hint]")?.textContent).toBe("Auto: memory 60 GB, about 2 GB an agent.");
  expect(devbox.textContent).toContain("22 running22");
  expect([...devbox.querySelectorAll("button")].some((b) => b.textContent.trim() === "Use auto")).toBe(false);
  const builder = section("builder");
  expect(builder.querySelector("[role='slider']")?.getAttribute("aria-valuenow")).toBe("40");
  expect(builder.querySelector("[data-hint]")?.textContent).toBe("Set by you. Auto would be 28: 28 of 32 CPUs.");
  expect(builder.textContent).toContain("At once");
  // No whole-fleet slider; the fleet cap of 50, below the machines' 62, is said with how to change it.
  expect(host.textContent).not.toContain("Whole fleet");
  expect(host.querySelector("[data-fleet-cap]")?.textContent).toContain("All machines together run at most 50 agents");

  await click(button(builder, "Use auto"));
  expect(calls).toEqual([{ tool: "cap_set", input: { machine: { machineId: "builder", auto: true } } }]);
  expect(section("builder").textContent).toContain("Auto: 28 of 32 CPUs.");
  expect(section("builder").textContent).toContain("builder, auto: 28, was 40.");
});

it("sets a machine with its slider, and Undo goes back to auto", async () => {
  vi.useFakeTimers();
  await render();
  const thumb = section("devbox").querySelector<HTMLElement>("[role='slider']");
  if (thumb === null) throw new Error("no slider");
  await act(async () => {
    thumb.focus();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(calls).toEqual([{ tool: "cap_set", input: { machine: { machineId: "devbox", maxAgents: 23 } } }]);
  expect(section("devbox").textContent).toContain("Set by you. Auto would be 22: memory 60 GB, about 2 GB an agent.");
  await click(button(section("devbox"), "Undo"));
  expect(calls[1]).toEqual({ tool: "cap_set", input: { machine: { machineId: "devbox", auto: true } } });
});

it("takes a project's slider to the fleet cap and says when its machine holds it, with no machine control in Settings", async () => {
  await render("settings", false);
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const project = section("Max agents");
  const thumb = project.querySelector("[role='slider']");
  expect(thumb?.getAttribute("aria-valuenow")).toBe("30");
  expect(thumb?.getAttribute("aria-valuemax")).toBe("50");
  expect(project.textContent).toContain("devbox runs at most 22 agents at once, so this project runs 22 until an admin raises devbox.");
  // A member sees the line only: no raise, no fleet or machine caps, nothing about admin keys.
  expect([...project.querySelectorAll("button")].map((b) => b.textContent.trim())).not.toContain("devbox's max in Hub › Machines");
  expect(host.textContent).not.toContain("admin key");
  expect(calls).toEqual([]);
});

it("gives an owner or admin the way to the machine's own page, where its cap is", async () => {
  await render("settings", true);
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  await click(button(section("Max agents"), "devbox's max in Hub › Machines"));
  expect(window.location.hash).toBe("#/settings/hub/machines/devbox");
});

it("says a fleet cap the CLI set below the machines' total, and nothing without one", async () => {
  await render("hub", true, { ...slots, cap: 30, fleetCap: 30 });
  expect(host.querySelector("[data-fleet-cap]")?.textContent).toBe(
    "All machines together run at most 30 agents: the hub's fleet cap. Change it with fleetd project set --fleet-cap <n>.",
  );
  act(() => root.unmount());
  root = createRoot(host);
  const { fleetCap: _, ...none } = slots;
  await render("hub", true, { ...none, cap: 62 });
  expect(host.querySelector("[data-fleet-cap]")).toBeNull();
});

it("says where each machine's agents run: a VM, or a process with why and its fix, and by design only in the hover", async () => {
  const fix = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0";
  await render("hub", true, {
    ...slots,
    perMachine: [
      { machineId: "devbox", cap: 22, auto: 22, running: 22, why: "memory 60 GB, about 2 GB an agent; each agent in a VM of its own", sandbox: { kind: "microvm" } },
      {
        machineId: "builder",
        cap: 40,
        maxAgents: 40,
        auto: 28,
        running: 0,
        why: `28 of 32 CPUs; agents run as plain processes: AppArmor blocks user namespaces. Fix: ${fix}`,
        sandbox: { kind: "process", why: "AppArmor blocks user namespaces", fix },
      },
    ],
  });
  const vm = (id: string) => section(id).querySelector<HTMLElement>("[data-vm]");
  expect(vm("devbox")?.getAttribute("data-vm")).toBe("on");
  expect(vm("devbox")?.textContent).toContain("A VM");
  // Its reason is the cap's alone: where its agents run is a row of its own.
  expect(section("devbox").querySelector("[data-hint]")?.textContent).toBe("Auto: memory 60 GB, about 2 GB an agent.");
  expect(vm("builder")?.getAttribute("data-vm")).toBe("off");
  expect(vm("builder")?.textContent).toContain("A process");
  expect(vm("builder")?.textContent).toContain("AppArmor blocks user namespaces. Run on builder:");
  expect(vm("builder")?.textContent).toContain(fix);

  act(() => root.unmount());
  root = createRoot(host);
  const why = "VMs need Linux with KVM; this machine runs macOS, so its agents run as plain processes.";
  await render("hub", true, {
    ...slots,
    perMachine: [{ machineId: "devbox", cap: 6, auto: 6, running: 0, why: `memory 16 GB, about 2 GB an agent; agents run as plain processes: ${why}`, sandbox: { kind: "process", why, expected: true } }],
  });
  // By the machine's design: nothing to fix, so nothing under the row; why is its hover.
  expect(vm("devbox")?.querySelector("[data-hint]")?.textContent).toBe(why);
  expect(vm("devbox")?.textContent.replace(why, "")).not.toContain("macOS");
  expect(vm("devbox")?.textContent).not.toContain("Run on");
});
