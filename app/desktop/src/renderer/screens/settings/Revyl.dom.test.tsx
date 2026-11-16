// @vitest-environment happy-dom
// The team's own Revyl in Hub › Machines › Screens: Connect opens one sealed field whose key goes to main (never to
// the hub as typed, never shown again), Test says whether it works, Disconnect removes it; each phone kind's route,
// whose Revyl choices are off before a key is connected and say why, with Connect right there. A hub too old for
// revyl_get shows none of it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RevylState } from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { RevylKeyRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { RevylScreens } from "./Revyl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-26T10:00:00.000Z";
const BOX = `${"A".repeat(43)}=`;
const KEY = "rvl_live_0123456789abcdef";
/** The hub's own words for a missing CLI (fleetd/src/hub/revyl, shared/revyl.ts INSTALL). */
/** The same where the key is tested on the team's machines: the sentence names the one to install on. */
const MACHINE_INSTALL =
  "install Revyl's CLI on devbox, and on each machine whose agents get Revyl screens: curl -fsSL https://revyl.com/install.sh | sh (or brew install RevylAI/tap/revyl, or pip install revyl)";
const HUB_INSTALL = "install Revyl's CLI on the hub's machine and on each machine whose agents get Revyl screens: curl -fsSL https://revyl.com/install.sh | sh (or brew install RevylAI/tap/revyl, or pip install revyl)";

const off: RevylState = { boxPubKey: BOX, connected: false, routes: { ios: "ours_only", android: "ours_only" } };
const on: RevylState = { ...off, connected: true, check: { ok: true, at: AT }, routes: { ios: "ours_first", android: "ours_first" } };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: RevylKeyRequest[];
/** What revyl_get answers now, or the error a hub without it gives. */
let state: RevylState | HubError;
let admin: boolean;
let testAnswer: RevylState;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  sealed = [];
  state = off;
  admin = true;
  testAnswer = on;
  (globalThis as { fleetd?: unknown }).fleetd = {
    platform: "linux",
    secret: {
      revylKey: (_hub: string, request: RevylKeyRequest) => {
        sealed.push(request);
        state = on;
        return Promise.resolve({ ok: true, output: on });
      },
    },
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "1", protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? "owner" : "member" } } });
      if (tool === "revyl_get") return Promise.resolve("code" in state ? { ok: false, error: state } : { ok: true, output: state });
      if (tool === "revyl_test") {
        state = testAnswer;
        return Promise.resolve({ ok: true, output: testAnswer });
      }
      if (tool === "revyl_disconnect") {
        state = off;
        return Promise.resolve({ ok: true, output: off });
      }
      if (tool === "revyl_route_set" && "routes" in state) {
        const { kind, route } = input as { kind: "ios" | "android"; route: string };
        state = { ...state, routes: { ...state.routes, [kind]: route } };
        return Promise.resolve({ ok: true, output: state });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <RevylScreens />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const revyl = () => host.querySelector<HTMLElement>("[data-revyl]");
const route = (kind: string) => host.querySelector<HTMLElement>(`[data-revyl-route="${kind}"]`);
const button = (name: string, within: ParentNode = host) => [...within.querySelectorAll("button")].find((b) => b.textContent === name);
const click = async (b: HTMLElement | undefined) => {
  if (b === undefined) throw new Error("no such button");
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};
const field = () => host.querySelector<HTMLInputElement>("input[aria-label='Revyl API key']");
const type = async (text: string) => {
  const input = field();
  if (input === null) throw new Error("no key field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
/** A row, or the page when it isn't there (so a missing row fails on what it should hold). */
const within = (el: HTMLElement | null): ParentNode => el ?? host;

it("connects a key through one sealed field that goes to main only, then says it works and is never shown again", async () => {
  await render();
  expect(revyl()?.getAttribute("data-revyl")).toBe("off");
  // Nothing under the row at rest (what it is lives in its hover): its title and Connect.
  expect(revyl()?.querySelector("[role='alert'], [role='status']")).toBeNull();
  expect(button("Connect…", within(revyl()))).toBeDefined();
  await click(button("Connect…"));
  expect(field()?.hasAttribute("data-secret")).toBe(true);
  expect(button("Connect")?.disabled).toBe(true);
  await type(`  ${KEY}\n`);
  await click(button("Connect"));
  expect(sealed).toEqual([{ boxPubKey: BOX, key: KEY }]);
  // The hub never got the key from the page: main seals it and calls revyl_connect itself.
  expect(JSON.stringify(calls)).not.toContain(KEY);
  expect(revyl()?.getAttribute("data-revyl")).toBe("connected");
  expect(field()).toBeNull();
  expect(host.textContent).not.toContain(KEY);
  expect(revyl()?.textContent).toContain("Works");
  expect(button("Test")).toBeDefined();
  expect(button("Disconnect")).toBeDefined();
});

it("says what a failed test found, with the install line when the hub has no revyl, and disconnects", async () => {
  state = on;
  testAnswer = { ...on, check: { ok: false, at: AT, reason: "no_cli", message: "The hub's machine has no revyl command.", fix: HUB_INSTALL } };
  await render();
  // At rest, a working key says nothing.
  expect(revyl()?.textContent).not.toContain("Works");
  await click(button("Test"));
  expect(calls.some((c) => c.tool === "revyl_test")).toBe(true);
  // The hub's sentence is words in the line; only its install command is the line to copy, and runs as pasted.
  expect(revyl()?.querySelector("[role='alert']")?.textContent).toBe(`The hub's machine has no revyl command. I${HUB_INSTALL.slice(1)}`);
  const copied = [...(revyl()?.querySelectorAll("[data-text]") ?? [])].map((t) => t.textContent).filter((t) => t.startsWith("curl"));
  expect(copied).toEqual(["curl -fsSL https://revyl.com/install.sh | sh"]);
  await click(button("Disconnect"));
  expect(calls.some((c) => c.tool === "revyl_disconnect")).toBe(true);
  expect(revyl()?.getAttribute("data-revyl")).toBe("off");
  expect(button("Connect…")).toBeDefined();
});

it("copies only the install command when the sentence names the team machine to install on", async () => {
  state = on;
  testAnswer = { ...on, check: { ok: false, at: AT, reason: "no_cli", message: "No machine of the team's online has the revyl command (devbox).", fix: MACHINE_INSTALL } };
  await render();
  await click(button("Test"));
  expect(revyl()?.querySelector("[role='alert']")?.textContent).toBe(`No machine of the team's online has the revyl command (devbox). I${MACHINE_INSTALL.slice(1)}`);
  const copied = [...(revyl()?.querySelectorAll("[data-text]") ?? [])].map((t) => t.textContent).filter((t) => t.startsWith("curl"));
  expect(copied).toEqual(["curl -fsSL https://revyl.com/install.sh | sh"]);
  expect(revyl()?.textContent).not.toContain("hub's machine");
});

it("keeps each kind on our machines until a key is connected, saying why with Connect right there", async () => {
  await render();
  for (const kind of ["ios", "android"]) {
    expect(route(kind)?.querySelector("button[role='combobox']")?.textContent).toContain("Our machines only");
    expect(route(kind)?.textContent).toContain("Revyl choices need a Revyl key.");
  }
  expect(route("ios")?.textContent).toContain("iOS simulator");
  expect(route("android")?.textContent).toContain("Android");
  await click(button("Connect Revyl", within(route("android"))));
  expect(field()).not.toBeNull();
});

it("tells a member whom to ask, with no Connect", async () => {
  admin = false;
  await render();
  // Once hub_info has said who this is.
  for (let i = 0; i < 20 && !(route("ios")?.textContent ?? "").includes("ask an admin"); i++) await settle();
  expect(route("ios")?.textContent).toContain("ask an admin to connect one in Settings › Hub › Machines");
  expect(route("ios")).not.toBeNull();
  expect(button("Connect Revyl", within(route("ios")))).toBeUndefined();
});

it("shows each kind's route in effect once connected, with no line under it", async () => {
  state = { ...on, routes: { ios: "revyl_only", android: "ours_first" } };
  await render();
  expect(route("ios")?.querySelector("button[role='combobox']")?.textContent).toContain("Revyl only");
  expect(route("android")?.querySelector("button[role='combobox']")?.textContent).toContain("Our machines first, then Revyl");
  expect(route("ios")?.textContent).not.toContain("needs a Revyl key");
});

it("shows nothing on a hub too old for Revyl", async () => {
  state = { code: "not_found", message: "unknown tool revyl_get" };
  await render();
  expect(host.textContent).toBe("");
});
