// @vitest-environment happy-dom
// The first run on a team of fleetd cloud with nothing to run agents on yet: its owners and admins land on Where agents
// run, unless this device joined the team by an invitation (decision hosted.invites-need-accept); hosted sandboxes
// connected there ask for Claude until an account reaches them, and say why, with Try again, once they don't get ready
// within the wait.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { HubScope } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetServes } from "../admin/role";
import { FirstRun } from "./FirstRun";
import { HOSTED_WAIT } from "./hostedWait";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let send: (frame: HubFrame) => void = () => undefined;
let calls: string[] = [];

const render = async (entry: { cloud?: true; invited?: true }) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      return Promise.resolve({
        ok: true,
        output:
          tool === "hub_info"
            ? { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: ["setup_list", "setup_test"] }
            : tool === "machine_join"
              ? { hubUrl: "https://acme.fleetd.dev", code: "fje_x", expiresAt: "2099-01-01T00:00:00Z", line: "curl -fsSL https://fleetd.sh | sh" }
              : tool === "sandbox_get"
                ? { boxPubKey: "AAAA", placing: true, providers: [{ provider: "boat", connected: true, limit: 5, check: { at: "2026-11-18T00:00:00Z", ok: true } }] }
                : {},
      });
    },
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

beforeEach(() => {
  resetServes();
  calls = [];
});
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
    degradedCause: "claude_login",
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

it("hosted sandboxes that don't get ready within the wait say why, the fix and Try again, which tests the key and waits again", async () => {
  const was = HOSTED_WAIT.ms;
  HOSTED_WAIT.ms = 50;
  try {
    const stop = await render({ cloud: true });
    // Stuck coming up: the hub's start words, which aren't a reason to show.
    const runner = { machineId: "hosted", name: "Hosted sandboxes", runner: true, status: "degraded", degradedReason: "checking the node's runner", lastSeenAt: "2026-11-18T00:00:00Z", nodeVersion: "1.0.0" };
    await act(async () => {
      send({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines: [runner], projects: [] } } as never);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen()).toBe("setup.machine.hosted");
    expect(host.textContent).toContain("Getting the sandboxes ready");
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(screen()).toBe("setup.machine.hosted.not-ready");
    expect(host.querySelector("[role=alert]")?.textContent).toBe("boat.dev's sandboxes didn't get ready.");
    expect(host.textContent).toContain("If it keeps failing, check boat.dev in Settings › Hub › Machines.");
    expect(host.textContent).not.toContain("runner");
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === "Try again");
    if (again === undefined) throw new Error(`no Try again in: ${host.textContent}`);
    await act(async () => {
      again.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toContain("sandbox_test");
    // The wait starts over.
    expect(screen()).toBe("setup.machine.hosted");
    // A reason of the hub's own is shown as it says it.
    await act(async () => {
      send({ t: "snapshot", snapshot: { cursor: 3, attention: [], machines: [{ ...runner, degradedReason: "boat.dev refused: billing isn't set up on the account" }], projects: [] } } as never);
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("boat.dev refused: billing isn't set up on the account.");
    stop();
  } finally {
    HOSTED_WAIT.ms = was;
  }
});
