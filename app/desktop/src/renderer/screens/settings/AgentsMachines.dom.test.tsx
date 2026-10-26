// @vitest-environment happy-dom
// Settings → Agents → Machines: each machine's number and where it comes from, the slider that sets it and the way
// back to auto; and a project's slider past its machine's cap, which says the machine holds it and raises it in a click.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AgentsSettings } from "./Agents";

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

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  let now = slots;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "cap_set") {
        calls.push({ tool, input });
        const machine = (input as { machine?: { machineId: string; maxAgents?: number; auto?: boolean } }).machine;
        if (machine !== undefined) now = setMachine(now, machine);
        return Promise.resolve({ ok: true, output: { slots: now } });
      }
      return Promise.resolve({ ok: true, output: { machineId: "devbox", projectId: "storefront", mediumAllowed: true } });
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
          <AgentsSettings />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshot);
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
  const machines = host.querySelector("section[aria-labelledby='agents-machines']");
  expect(machines?.textContent).toContain("Machines");
  const devbox = section("devbox");
  expect(devbox.querySelector("[role='slider']")?.getAttribute("aria-valuenow")).toBe("22");
  expect(devbox.querySelector("[role='slider']")?.getAttribute("aria-valuemax")).toBe("50");
  expect(devbox.textContent).toContain("Auto: memory 60 GB, about 2 GB an agent.");
  expect(devbox.textContent).toContain("22 agents running now.");
  expect([...devbox.querySelectorAll("button")].some((b) => b.textContent.trim() === "Use auto")).toBe(false);
  const builder = section("builder");
  expect(builder.querySelector("[role='slider']")?.getAttribute("aria-valuenow")).toBe("40");
  expect(builder.textContent).toContain("Set by you. Auto would be 28: 28 of 32 CPUs.");

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

it("takes a project's slider to the fleet cap, says when its machine holds it, and raises the machine in a click", async () => {
  await render();
  const project = section("storefront");
  const thumb = project.querySelector("[role='slider']");
  expect(thumb?.getAttribute("aria-valuenow")).toBe("30");
  expect(thumb?.getAttribute("aria-valuemax")).toBe("50");
  expect(project.textContent).toContain("devbox runs at most 22 agents at once, so this project runs 22 until you raise devbox.");

  await click(button(project, "Raise devbox to 30"));
  expect(calls).toEqual([{ tool: "cap_set", input: { machine: { machineId: "devbox", maxAgents: 30 } } }]);
  expect(section("storefront").textContent).not.toContain("runs at most");
  expect(section("devbox").querySelector("[role='slider']")?.getAttribute("aria-valuenow")).toBe("30");
});
