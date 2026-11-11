// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudState, SignInOutcome } from "../../../shared/cloud";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ConnectComputer } from "../setup/ConnectComputer";
import { resetCloud } from "./cloud";
import { OnboardingScreen } from "./OnboardingScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cloud } = vi.hoisted(() => {
  const cloud = {
    available: true,
    finish: (_out: SignInOutcome): void => undefined,
    state: vi.fn((): Promise<CloudState> => Promise.resolve({ available: cloud.available, email: null })),
    signIn: vi.fn(() => new Promise<SignInOutcome>((resolve) => (cloud.finish = resolve))),
    cancel: vi.fn(() => {
      cloud.finish({ ok: false, cancelled: true });
      return Promise.resolve();
    }),
    reopen: vi.fn(() => Promise.resolve()),
    link: vi.fn(() => Promise.resolve(null)),
    signOut: vi.fn(() => Promise.resolve({ kept: [] })),
    connectComputer: vi.fn(() => Promise.resolve({ ok: true, terminal: "a terminal" })),
  };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    app: { presence: () => Promise.resolve(true), linkHandler: () => Promise.resolve(null) },
    hub: { forget: () => Promise.resolve() },
    hubs: { update: () => Promise.resolve({ ok: true }) },
    pair: {
      start: () => Promise.resolve({ appPair: null, problem: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } }),
      store: () => Promise.resolve(null),
      probe: (hub: string) => Promise.resolve({ answers: false, hub }),
      setup: () => Promise.resolve({ ok: true, terminal: "a terminal" }),
    },
    cloud,
  });
  return { cloud };
});

let host: HTMLDivElement;
let root: Root;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
const calls: Array<{ tool: string; input: unknown }> = [];

const mount = async (screen: React.ReactNode, first: HubFrame) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({
        ok: true,
        output: tool === "machine_join" ? { hubUrl: "https://acme.fleetd.dev", code: "fje_x", expiresAt: "2099-01-01T00:00:00Z", line: "curl -fsSL https://fleetd.sh | sh -s -- --join https://acme.fleetd.dev --code fje_x" } : {},
      });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <UiProvider>{screen}</UiProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(first);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

beforeEach(() => {
  resetCloud();
  cloud.available = true;
  calls.length = 0;
  for (const f of [cloud.signIn, cloud.cancel, cloud.connectComputer]) f.mockClear();
  window.location.hash = "#/onboarding";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const button = (name: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent)));
const click = (name: string | RegExp) => {
  const found = button(name);
  if (!found) throw new Error(`no ${String(name)} button`);
  act(() => found.click());
};
const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const unpaired: HubFrame = { t: "state", state: { phase: "unpaired" } };

it("on a build without the cloud's values, the first screen is today's connect form, with no Sign in anywhere", async () => {
  cloud.available = false;
  await mount(<OnboardingScreen />, unpaired);
  expect(screen()).toBe("onboarding");
  expect(host.textContent).toContain("Hub address");
  expect(button("Sign in")).toBeUndefined();
  expect(button("Back")).toBeUndefined();
  expect(host.textContent).not.toContain("fleetd hosts your hub");
});

it("offers both ways a line each; Use your own hub is the connect form, with the way back", async () => {
  await mount(<OnboardingScreen />, unpaired);
  expect(screen()).toBe("onboarding.ways");
  expect(host.textContent).toContain("fleetd hosts your hub. Your agents run on your own computers.");
  expect(host.textContent).toContain("A hub you run yourself. No fleetd account.");
  click(/^Use your own hub/u);
  expect(screen()).toBe("onboarding");
  expect(host.textContent).toContain("Hub address");
  click("Back");
  expect(screen()).toBe("onboarding.ways");
});

it("Sign in waits on the browser; Cancel comes back quietly, and a refusal says what happened and to sign in again", async () => {
  await mount(<OnboardingScreen />, unpaired);
  click("Sign in");
  expect(cloud.signIn).toHaveBeenCalledTimes(1);
  expect(screen()).toBe("onboarding.signin");
  click("Cancel");
  await settle();
  expect(screen()).toBe("onboarding.ways");
  expect(host.querySelector("[role='alert']")).toBeNull();
  click("Sign in");
  await act(async () => {
    cloud.finish({ ok: false, failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(host.querySelector("[role='alert']")?.textContent).toContain("The browser came back without signing you in.");
  expect(button("Sign in again")).toBeDefined();
});

it("Connect a computer: makes a line with no machine name, opens this computer's terminal, and moves on when a machine joins", async () => {
  const empty: HubFrame = { t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } };
  await mount(<ConnectComputer onAddProject={() => undefined} />, { t: "state", state: { phase: "live", hub: "https://acme.fleetd.dev", protocol: 1 } });
  await act(async () => {
    send(empty);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  expect(screen()).toBe("setup.machine");
  expect(calls.find((c) => c.tool === "machine_join")?.input).toEqual({});
  expect(host.querySelector("code")?.textContent).toContain("--join https://acme.fleetd.dev --code fje_x");
  click("Connect this computer");
  await settle();
  expect(cloud.connectComputer).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Connecting this computer…");
  await act(async () => {
    send({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(screen()).toBe("setup.machine.joined");
  expect(host.querySelector("h1")?.textContent).toBe("devbox is connected");
  click("Connect another computer");
  expect(screen()).toBe("setup.machine");
});
