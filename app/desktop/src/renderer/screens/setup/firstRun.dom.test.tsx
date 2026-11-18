// @vitest-environment happy-dom
// The first run on a team of fleetd cloud with nothing to run agents on yet: its owners and admins land on Where agents
// run, unless this device joined the team by an invitation (decision hosted.invites-need-accept); hosted sandboxes
// connected there ask for Claude until an account reaches them.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { HubScope } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetServes } from "../admin/role";
import { FirstRun } from "./FirstRun";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let send: (frame: HubFrame) => void = () => undefined;

const render = async (entry: { cloud?: true; invited?: true }) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const hub: HubApi = {
    call: (tool) =>
      Promise.resolve({
        ok: true,
        output:
          tool === "hub_info"
            ? { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: ["setup_list", "setup_test"] }
            : tool === "machine_join"
              ? { hubUrl: "https://acme.fleetd.dev", code: "fje_x", expiresAt: "2099-01-01T00:00:00Z", line: "curl -fsSL https://fleetd.sh | sh" }
              : {},
      }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  const stop = layer.start();
  await act(async () => {
    root.render(
      <UiProvider>
        <HubScope hub={{ id: "hub", label: "acme", layer, ...entry }}>
          <FirstRun onAddProject={() => undefined} />
        </HubScope>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "https://acme.fleetd.dev", protocol: 1 } });
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return stop;
};

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");

beforeEach(() => resetServes());
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("a team of the person's own opens on Connect a computer", async () => {
  const stop = await render({ cloud: true });
  expect(screen()).toBe("setup.machine");
  stop();
});

it("a team this device joined by invitation never opens on Connect a computer: Get started instead", async () => {
  const stop = await render({ cloud: true, invited: true });
  expect(screen()).not.toBe("setup.machine");
  expect(host.textContent).not.toContain("Connect this computer");
  expect(host.textContent).toContain("Add a bot");
  stop();
});

it("hosted sandboxes connected with no Claude account that reaches them: Connect Claude, never that agents run there", async () => {
  const stop = await render({ cloud: true });
  const runner = {
    machineId: "hosted",
    name: "Hosted sandboxes",
    runner: true,
    status: "degraded",
    degradedReason: "agents in hosted sandboxes run on a Claude account, and none reaches them. Fix: connect the hub's API key or your Claude subscription in Settings",
    lastSeenAt: "2026-11-18T00:00:00Z",
    nodeVersion: "1.0.0",
  };
  const machines = async (list: unknown[]) =>
    act(async () => {
      send({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines: list, projects: [] } } as never);
      await new Promise((r) => setTimeout(r, 0));
    });
  await machines([runner]);
  expect(screen()).toBe("setup.machine.hosted");
  expect(host.textContent).toContain("Connect Claude");
  expect(host.textContent).not.toContain("Agents run there");
  // An account reached them: they run agents now.
  await machines([{ ...runner, status: "online", degradedReason: undefined }]);
  expect(screen()).toBe("setup.machine.joined");
  expect(host.textContent).toContain("Hosted sandboxes are connected");
  stop();
});
