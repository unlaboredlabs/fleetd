// @vitest-environment happy-dom
// The first run on a team of fleetd cloud with no machine yet: its owners and admins land on Connect a computer,
// unless this device joined the team by an invitation (decision hosted.invites-need-accept).
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

const render = async (entry: { cloud?: true; invited?: true }) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  let send: (frame: HubFrame) => void = () => undefined;
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
  expect(host.textContent).toContain("Add a project");
  stop();
});
