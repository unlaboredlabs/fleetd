// @vitest-environment happy-dom
// A project's Max agents: whether it is its own or the default, the way back to the default, and an Undo that goes
// back to the default it left rather than setting the number the default was then.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AgentsPanel } from "./Agents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Settings search reads the platform when it loads, before any test runs.
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const storefront = { machineId: "devbox", projectId: "storefront" };
const billing = { machineId: "devbox", projectId: "billing" };
const slots: SlotState = {
  cap: 12,
  fleetCap: 12,
  used: 8,
  queued: 0,
  perProject: [
    { projectRef: storefront, maxAgents: 6, own: true, running: 6, queued: 0 },
    { projectRef: billing, maxAgents: 12, own: false, running: 2, queued: 0 },
  ],
};

let host: HTMLDivElement;
let root: Root;
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

const render = async (projectRef: typeof storefront) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ ok: true, output: { slots } });
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
          <AgentsPanel projectRef={projectRef} slots={slots} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    await Promise.resolve();
  });
};

const button = (text: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = (el: HTMLElement) =>
  act(async () => {
    el.click();
    await Promise.resolve();
  });

it("says a project's own max is its own, and goes back to the default", async () => {
  await render(storefront);
  expect(host.textContent).toContain("Set for this project. The default is 12.");
  await click(button("Use the default"));
  expect(calls).toEqual([{ tool: "cap_set", input: { project: { projectRef: storefront, followDefault: true } } }]);
  expect(host.textContent).toContain("Max agents, the default: 12, was 6.");
});

it("goes back to the default on Undo of a change from it", async () => {
  vi.useFakeTimers();
  await render(billing);
  expect(host.textContent).toContain("Follows the default: the whole fleet's cap.");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Use the default")).toBe(false);
  const thumb = host.querySelector<HTMLElement>("[role='slider']");
  if (thumb === null) throw new Error("no slider");
  await act(async () => {
    thumb.focus();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(calls).toEqual([{ tool: "cap_set", input: { project: { projectRef: billing, maxAgents: 11 } } }]);
  await click(button("Undo"));
  expect(calls[1]).toEqual({ tool: "cap_set", input: { project: { projectRef: billing, followDefault: true } } });
});
