// @vitest-environment happy-dom
// Move to the cloud's row, sheet and banner (MoveToCloud.tsx): the row only where a hub can move, the sheet's sign-in,
// team and Move, a move that stops saying why and its one way forward, and a moved hub's banner with Undo.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubMove } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetCloud } from "../onboarding/cloud";
import { MovedBanner, MoveRow, MoveSheet } from "./MoveToCloud";
import { resetServes } from "./role";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-11-07T10:00:00.000Z";
let host: HTMLDivElement;
let root: Root;
let calls: string[];
let move: HubMove;
let moved: Array<[string, string]>;
let available: boolean;

beforeEach(() => {
  resetServes();
  resetCloud();
  calls = [];
  moved = [];
  available = true;
  move = { phase: "idle", machines: [{ machineId: "devbox", name: "devbox", state: "waiting" }] };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    cloud: {
      state: () => Promise.resolve({ available, email: null, domain: "fleetd.dev" }),
      signIn: () => Promise.resolve({ ok: true, arrival: { email: "sam@acme.example", invitations: [] } }),
      finish: () => Promise.resolve({ ok: true, email: "sam@acme.example", teams: [{ name: "acme", ok: true }] }),
      moveTargets: () => Promise.resolve([{ hub: "h2", name: "acme" }]),
      move: (from: string, to: string) => {
        moved.push([from, to]);
        move = { ...move, phase: "failed", failure: { reason: "signed_out", message: "Your sign-in to fleetd cloud ended during the move.", fix: "Sign in again, then press Move." } };
        return Promise.resolve({ ok: true });
      },
      cancel: () => Promise.resolve(),
    },
  });
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

const render = async (node: React.ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      if (tool === "hub_move_resume") move = { phase: "idle", machines: move.machines };
      const output =
        tool === "hub_info"
          ? { version: "1", protocol: 1, busy: [], admin: true, me: { personId: "p_aaaaaaaa", name: "Sam", role: "owner", createdAt: AT } }
          : tool.startsWith("hub_move_")
            ? { move }
            : undefined;
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : ({ ok: true, output } as never));
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
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1, version: "1" } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], projects: [], machines: [] } } as unknown as HubFrame);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const click = async (label: string) => {
  const b = button(label);
  if (b === undefined) throw new Error(`no ${label} button in: ${document.body.textContent}`);
  act(() => b.click());
  for (let i = 0; i < 4; i++) await settle();
};

it("the row shows on a self-hosted hub this build can move, and only there", async () => {
  await render(<MoveRow />);
  expect(host.querySelector("[aria-label='Move to the cloud']")).not.toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  resetCloud();
  available = false;
  await render(<MoveRow />);
  expect(host.querySelector("[aria-label='Move to the cloud']")).toBeNull();
});

it("the sheet signs in, names the team and its machines, moves, and a move that stops says why and the one way forward", async () => {
  await render(<MoveSheet onClose={() => undefined} />);
  await click("Sign in to fleetd cloud");
  expect(document.body.textContent).toContain("Into acme");
  expect(document.querySelector("[data-machine='devbox']")?.textContent).toBe("devboxComes along");
  await click("Move");
  expect(moved.map(([, to]) => to)).toEqual(["h2"]);
  for (let i = 0; i < 10; i++) await settle();
  await act(async () => new Promise((r) => setTimeout(r, 1100)));
  await settle();
  const alert = document.querySelector("[role='alert']");
  expect(alert?.textContent).toBe("Your sign-in to fleetd cloud ended during the move.");
  expect(document.body.textContent).toContain("Sign in again, then press Move.");
  expect(button("Sign in again")).toBeDefined();
});

it("a moved hub's banner says its bots are paused here, and Undo runs them here again", async () => {
  move = { phase: "done", machines: [], team: "acme", paused: { team: "acme", url: "https://acme.fleetd.dev", since: AT } };
  await render(<MovedBanner />);
  expect(host.querySelector("[data-banner='moved']")?.textContent).toContain("This hub moved to fleetd cloud (acme). Its bots are paused here.");
  await click("Undo");
  expect(calls).toContain("hub_move_resume");
  for (let i = 0; i < 4; i++) await settle();
  expect(host.querySelector("[data-banner='moved']")).toBeNull();
});

it("no banner while the hub is where it was", async () => {
  await render(<MovedBanner />);
  expect(host.querySelector("[data-banner='moved']")).toBeNull();
});

it("done with something left out, the sheet lists it and stays open rather than switching hub", async () => {
  move = {
    phase: "done",
    team: "acme",
    machines: [{ machineId: "devbox", name: "devbox", state: "joined" }],
    skipped: ["GitHub: install fleetd's GitHub App on acme, then each person connects their GitHub again."],
    paused: { team: "acme", url: "https://acme.fleetd.dev", since: AT },
  };
  let closed = false;
  await render(<MoveSheet onClose={() => (closed = true)} />);
  const left = document.querySelector("[data-move-skipped]");
  expect(left?.textContent).toContain("install fleetd's GitHub App on acme");
  expect(closed).toBe(false);
});

it("a move that lost track of the cloud keeps the pause and says it may not have finished", async () => {
  move = { phase: "failed", team: "acme", machines: [], paused: { team: "acme", url: "https://acme.fleetd.dev", since: AT }, failure: { reason: "offline", message: "x", fix: "y" } };
  await render(<MovedBanner />);
  expect(host.querySelector("[data-banner='moved']")?.textContent).toContain("may not have finished");
});
