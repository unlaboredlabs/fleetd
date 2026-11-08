// @vitest-environment happy-dom
// Hub › Updates: where the hub and its machines stand with Update now, Update automatically with its last update, next
// check and why it holds back, and each one's version.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetFlow } from "../updates/flow";
import { AutoUpdates } from "../updates/AutoUpdates";
import { UpdatesPage } from "./UpdatesPage";

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
  settings: { auto, drainMinutes: 10 },
  ready: READY,
  ...(auto
    ? {
        lastAuto: { at: "2026-11-07T10:30:00.000Z", to: OLD, result: "partial", message: "mac1 didn't come back on it." },
        nextCheck: "2026-11-07T15:10:00.000Z",
        skipReason: "A person's update is still running.",
      }
    : {}),
});

beforeEach(() => {
  calls = [];
  auto = true;
  resetFlow();
  // This app runs the hub's build, and the channel has a newer one: the hub has it ready.
  const app = { current: OLD, app: { kind: "current" }, release: { changes: [], cli: READY, app: READY } };
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, updates: { subscribe: () => () => undefined, state: () => Promise.resolve(app) } });
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

const statusLines = (within: ParentNode) => [...within.querySelectorAll<HTMLElement>("[data-auto-status]")].map((l) => `${l.dataset["autoStatus"] ?? ""}: ${l.textContent}`);

it("shows Update now, the switch with its last update, next check and why it holds back, and each version", async () => {
  await render(<UpdatesPage />);
  const page = host.querySelector<HTMLElement>("[data-screen='settings.hub.updates']");
  expect(page?.querySelector("[data-updates-part='all']")?.textContent).toContain("is ready");
  expect(page?.querySelector("[data-updates-part='all'] button")?.textContent).toBe("Update");
  expect(page?.querySelector("[data-auto-updates='on']")?.textContent).toContain("Update automatically");
  expect(statusLines(page ?? document)).toEqual([
    expect.stringMatching(/^last: Last updatePartly updated .*\. mac1 didn't come back on it\.$/u),
    expect.stringMatching(/^next: Next check.+ at \d{2}:\d{2}\.$/u),
    "skip: Holding backA person's update is still running.",
  ]);
  expect(page?.querySelector("[data-updates-row='devbox']")).not.toBeNull();

  // Off: the hub keeps it, and the page says what off means.
  await act(async () => {
    page?.querySelector<HTMLElement>("[role='switch']")?.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(calls.filter((c) => c.tool === "hub_update_settings").map((c) => c.input)).toEqual([{ auto: false }]);
  expect(statusLines(page ?? document)).toEqual(["off: Off: the hub and its machines update only when someone presses Update."]);
});

it("tells a member whom to ask", async () => {
  await render(<AutoUpdates />, false);
  expect(document.querySelector("[data-auto-updates='member']")?.textContent).toContain("ask Ana.");
  expect(document.querySelector("[role='switch']")).toBeNull();
});
