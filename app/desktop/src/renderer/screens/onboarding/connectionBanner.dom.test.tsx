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

const connect = async (version?: string) => {
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "http://devbox:4790", protocol: 1, ...(version === undefined ? {} : { version }) } });
    // Its one machine runs an older node than the hub's 0.2.0.
    const frame = snapshot(1);
    if (frame.t === "snapshot") send({ ...frame, snapshot: { ...frame.snapshot, machines: frame.snapshot.machines.map((m) => ({ ...m, nodeVersion: "0.1.0" })) } });
    await new Promise((r) => setTimeout(r, 0));
  });
};
const banner = () => host.querySelector("[data-banner='nodes-behind']")?.textContent ?? null;

it("reads the hub's version from its ready, without a request of its own", async () => {
  await connect("0.2.0");
  expect(banner()).toContain("devbox runs an older fleetd than the hub");
  expect(probe).not.toHaveBeenCalled();
});

it("asks an older hub, whose ready names no version, on /healthz", async () => {
  await connect();
  expect(probe).toHaveBeenCalledWith("http://devbox:4790");
  expect(banner()).toContain("devbox runs an older fleetd than the hub");
});
