// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudState, FinishOutcome, SignInOutcome } from "../../../shared/cloud";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useData } from "../../src/data/react";
import { AT } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ConnectComputer } from "../setup/ConnectComputer";
import { resetCloud } from "./cloud";
import { OnboardingScreen } from "./OnboardingScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cloud } = vi.hoisted(() => {
  const cloud = {
    available: true,
    arrive: (_out: SignInOutcome): void => undefined,
    state: vi.fn((): Promise<CloudState> => Promise.resolve({ available: cloud.available, email: null, domain: "fleetd.dev" })),
    signIn: vi.fn(() => new Promise<SignInOutcome>((resolve) => (cloud.arrive = resolve))),
    finish: vi.fn((_join: number[]): Promise<FinishOutcome> => Promise.resolve({ ok: true, email: "sam@example.com", teams: [] })),
    notMe: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => {
      cloud.arrive({ ok: false, cancelled: true });
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
  for (const f of [cloud.signIn, cloud.cancel, cloud.connectComputer, cloud.finish, cloud.notMe]) f.mockClear();
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
/** Its children only once the hub is live and fresh, so they mount (twice, under StrictMode) with calls going out at once. */
function WhenLive({ children }: { children: React.ReactNode }) {
  const ready = useData((d) => d.fresh && d.hub.phase === "live");
  return ready ? children : null;
}

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
    cloud.arrive({ ok: false, failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(host.querySelector("[role='alert']")?.textContent).toContain("The browser came back without signing you in.");
  expect(button("Sign in again")).toBeDefined();
});

/** Sign in, and the browser comes back with this answer. */
const arriveWith = async (arrival: { email: string; invitations: Array<{ name: string; invitedBy: string; role: string }> }) => {
  click("Sign in");
  await act(async () => {
    cloud.arrive({ ok: true, arrival });
    await new Promise((r) => setTimeout(r, 0));
  });
};

it("back from the browser, the first thing shown names the account; Not you signs out with nothing connected", async () => {
  await mount(<OnboardingScreen />, unpaired);
  await arriveWith({ email: "sam@example.com", invitations: [{ name: "acme", invitedBy: "eve@other.example", role: "admin" }] });
  expect(screen()).toBe("onboarding.signed-in");
  expect(host.querySelector("h1")?.textContent).toBe("Signed in as sam@example.com");
  expect(host.textContent).toContain("Not you?");
  expect(host.textContent).not.toContain("invited you");
  expect(cloud.finish).not.toHaveBeenCalled();
  click("Sign out");
  await settle();
  expect(cloud.notMe).toHaveBeenCalledTimes(1);
  expect(cloud.finish).not.toHaveBeenCalled();
  expect(screen()).toBe("onboarding.ways");
});

it("asks about each invitation before anything connects: Join and Not now, then the teams connect with the ones joined", async () => {
  await mount(<OnboardingScreen />, unpaired);
  await arriveWith({
    email: "sam@example.com",
    invitations: [
      { name: "acme", invitedBy: "eve@other.example", role: "admin" },
      { name: "side", invitedBy: "kai@example.com", role: "member" },
    ],
  });
  click("Continue");
  expect(screen()).toBe("onboarding.invited");
  expect(host.querySelector("h1")?.textContent).toBe("eve@other.example invited you to acme");
  expect(host.textContent).toContain("You'd join as an admin. Join only if you know who sent it.");
  click("Not now");
  expect(host.querySelector("h1")?.textContent).toBe("kai@example.com invited you to side");
  expect(cloud.finish).not.toHaveBeenCalled();
  click("Join");
  await settle();
  expect(cloud.finish).toHaveBeenCalledTimes(1);
  expect(cloud.finish).toHaveBeenCalledWith([1]);
});

it("no team of their own and one invitation: still asked, and Not now joins nothing", async () => {
  cloud.finish.mockImplementationOnce(() =>
    Promise.resolve({ ok: false, failure: { code: "none_joined", message: "You didn't join a team, so you aren't signed in.", fix: "Sign in again when you want to join it." } }),
  );
  await mount(<OnboardingScreen />, unpaired);
  await arriveWith({ email: "new@example.com", invitations: [{ name: "acme", invitedBy: "eve@other.example", role: "member" }] });
  click("Continue");
  expect(host.querySelector("h1")?.textContent).toBe("eve@other.example invited you to acme");
  click("Not now");
  await settle();
  expect(cloud.finish).toHaveBeenCalledWith([]);
  expect(screen()).toBe("onboarding.ways");
  expect(host.textContent).toContain("You didn't join a team, so you aren't signed in.");
});

it("a pairing link to a team of fleetd cloud says anyone can make one; a link to another hub doesn't", async () => {
  await mount(<OnboardingScreen hub="https://security.fleetd.dev" code="ABCD-2345-WXYZ-6789" />, unpaired);
  expect(host.textContent).toContain("This is a fleetd cloud team. Anyone can make one, so join only if you know who sent you this link.");
  act(() => root.unmount());
  host.remove();
  await mount(<OnboardingScreen hub="https://hub.example:4790" code="ABCD-2345" />, unpaired);
  expect(host.textContent).not.toContain("fleetd cloud team");
});

it("Connect a computer: makes a line with no machine name, opens this computer's terminal, and moves on when a machine joins", async () => {
  const empty: HubFrame = { t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } };
  // Under StrictMode, as the renderer mounts it: the dev double mount must not drop the hub's answers.
  await mount(
    <StrictMode>
      <WhenLive>
        <ConnectComputer onAddProject={() => undefined} />
      </WhenLive>
    </StrictMode>,
    { t: "state", state: { phase: "live", hub: "https://acme.fleetd.dev", protocol: 1 } },
  );
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
