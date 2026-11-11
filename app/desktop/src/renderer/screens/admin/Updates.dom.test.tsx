// @vitest-environment happy-dom
// Hub › Machines' Updates: one status with its one button, and Update automatically, which says only why it holds
// back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetFlow } from "../updates/flow";
import { AutoUpdates } from "../updates/AutoUpdates";
import { Updates } from "./Updates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-11-07T10:00:00.000Z";
const OLD = "0.0.0-edge.202611071030+6d5a250";
const READY = "0.0.0-edge.202611071430+f893086";

const snapshot = {
  t: "snapshot",
  snapshot: { cursor: 1, attention: [], projects: [], machines: [{ machineId: "devbox", name: "devbox", status: "online", nodeVersion: OLD, lastSeenAt: AT }] },
} as unknown as HubFrame;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: Record<string, unknown> }>;
let auto: boolean;

const status = () => ({
  settings: { auto, drainMinutes: 2 },
  ready: READY,
  ...(auto ? { skipReason: "A person's update is still running." } : {}),
});

beforeEach(() => {
  calls = [];
  auto = true;
  resetFlow();
  // This app runs the hub's build, and the channel has a newer one: the hub has it ready.
  const app = { current: OLD, app: { kind: "current" }, release: { cli: READY, app: READY } };
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, updates: { subscribe: () => () => undefined, state: () => Promise.resolve(app), check: () => Promise.resolve(), install: () => Promise.resolve() } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (node: React.ReactNode, admin = true) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      const args = input as Record<string, unknown>;
      calls.push({ tool, input: args });
      if (tool === "hub_update_settings") auto = args["auto"] === true;
      const output =
        tool === "hub_info"
          ? { version: OLD, protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? "owner" : "member", createdAt: AT } }
          : tool === "hub_update_status" || tool === "hub_update_settings"
            ? status()
            : tool === "people_list"
              ? { people: [{ personId: "p_bbbbbbbb", name: "Ana", role: "owner", createdAt: AT }] }
              : undefined;
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output } as never);
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{node}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1, version: OLD } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const text = (within: ParentNode | null | undefined, selector: string) => within?.querySelector(selector)?.textContent;

it("shows one status with one button, and the switch with why it holds back", async () => {
  await render(<Updates />);
  const page = host.querySelector<HTMLElement>("[data-screen='settings.hub.updates']");
  expect(text(page, "[data-update-status='available']")).toBe("Update availablefleetd Edge · Nov 7, 14:30Update");
  // No machine to look at: no rows.
  expect(page?.querySelector("[data-update-machine]")).toBeNull();
  expect(text(page, "[data-auto-updates='on']")).toBe("Update automaticallyA person's update is still running.");

  // Off: the hub keeps it, and the switch says nothing more.
  await act(async () => {
    page?.querySelector<HTMLElement>("[role='switch']")?.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(calls.filter((c) => c.tool === "hub_update_settings").map((c) => c.input)).toEqual([{ auto: false }]);
  expect(text(page, "[data-auto-updates='off']")).toBe("Update automatically");

  // One click updates: no sheet, nothing to confirm.
  await act(async () => {
    page?.querySelector<HTMLElement>("[data-update-status] button")?.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(calls.filter((c) => c.tool === "hub_update").map((c) => c.input)).toEqual([{}]);
  // This hub refuses it (nothing faked): its words, and the way to press again.
  expect(text(page, "[data-update-status='failed']")).toBe("The update didn't startHub_update isn't faked.Try again");
  expect(document.querySelector("[role='dialog']")).toBeNull();
});

it("shows a member no switch", async () => {
  await render(<AutoUpdates />, false);
  expect(document.querySelector("[data-auto-updates]")).toBeNull();
  expect(document.querySelector("[role='switch']")).toBeNull();
});
