// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ConnectionBanner } from "./ConnectionBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { probe } = vi.hoisted(() => {
  const probe = vi.fn((hub: string) => Promise.resolve({ answers: true, hub, version: "0.2.0", protocol: 1 }));
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, pair: { probe } });
  return { probe };
});

let host: HTMLDivElement;
let root: Root;
let send: (frame: HubFrame) => void = () => undefined;

beforeEach(() => {
  probe.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const hub: HubApi = {
    call: () => Promise.resolve({ ok: true, output: {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  act(() => {
    root.render(
      <DataProvider layer={layer}>
        <UiProvider>
          <ConnectionBanner />
        </UiProvider>
      </DataProvider>,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

type Machine = Extract<HubFrame, { t: "snapshot" }>["snapshot"]["machines"][number];

const connect = async (version?: string, more: ReadonlyArray<Machine> = []) => {
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "http://devbox:4790", protocol: 1, ...(version === undefined ? {} : { version }) } });
    // Its one machine runs an older node than the hub's 0.2.0.
    const frame = snapshot(1);
    if (frame.t === "snapshot") {
      const machines = [...frame.snapshot.machines.map((m) => ({ ...m, nodeVersion: "0.1.0" })), ...more];
      send({ ...frame, snapshot: { ...frame.snapshot, machines } });
    }
    await new Promise((r) => setTimeout(r, 0));
  });
};
const banner = () => host.querySelector("[data-banner='nodes-behind']")?.textContent ?? null;

/** The live frame: each machine's node linked that many ms before now. */
const linked = async (ago: Readonly<Record<string, number>>) => {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const machines = Object.entries(ago).map(([machineId, ms]) => ({ machineId, name: machineId, status: "online" as const, running: 0, asOf: at, linkedSince: new Date(now - ms).toISOString() }));
  send({ t: "live", frame: { at, full: true, lanes: [], machines } });
  await new Promise((r) => setTimeout(r, 0));
};
const LONG_AGO = 13 * 60_000;

it("reads the hub's version from its ready, without a request of its own", async () => {
  await connect("0.2.0");
  await act(() => linked({ devbox: LONG_AGO }));
  expect(banner()).toContain("devbox runs an older fleetd than the hub");
  expect(probe).not.toHaveBeenCalled();
});

it("asks an older hub, whose ready names no version, on /healthz", async () => {
  await connect();
  await act(() => linked({ devbox: LONG_AGO }));
  expect(probe).toHaveBeenCalledWith("http://devbox:4790");
  expect(banner()).toContain("devbox runs an older fleetd than the hub");
});

it("says nothing while the hub's update of a machine may still be on its way", async () => {
  await connect("0.2.0");
  expect(banner()).toBeNull();
  await act(() => linked({ devbox: 60_000 }));
  expect(banner()).toBeNull();
});

// The hub and devbox's node restarted on the same build within seconds (an automatic update): the snapshot taken as
// the app reconnected still had the old node's version, and the node's new link said the new one only in its event.
it("clears as soon as the machine's node links again on the hub's build", async () => {
  await connect("0.2.0");
  await act(() => linked({ devbox: LONG_AGO }));
  expect(banner()).toContain("devbox runs an older fleetd than the hub");
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: new Date().toISOString(), type: "machine.linked", machineId: "devbox", summary: "devbox's node linked again, on fleetd 0.2.0", data: { nodeVersion: "0.2.0" } } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(banner()).toBeNull();
});

it("takes the version a node came back online with after it was away", async () => {
  await connect("0.2.0");
  await act(() => linked({ devbox: LONG_AGO }));
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: new Date().toISOString(), type: "machine.online", machineId: "devbox", summary: "devbox is online", data: { nodeVersion: "0.2.0" } } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(banner()).toBeNull();
});
