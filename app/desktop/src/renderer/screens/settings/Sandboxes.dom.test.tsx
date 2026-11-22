// @vitest-environment happy-dom
// The hosted sandbox provider in Hub › Machines' Providers (boat.dev), saying what it runs; Connect opens a sealed key
// field whose key goes to main only, never shown again; once connected, the limit and a menu with Test and Disconnect.
// Its dot and line are its real state: Starting…, Ready with how many run, Needs a Claude account (Connect), Couldn't
// start with why and its fix (Try again), a refused key (Test again). What runs where is two rows: Linux machine, a pick once
// there is more than one place, and Mac machine. A hub too old for sandbox_get shows no provider.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Machine, ProviderTrouble, SandboxProviderState, SandboxState, SlotState } from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { SandboxKeyRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProvidersGroup, WhatRunsWhere } from "./Places";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-11-17T10:00:00.000Z";
const BOX = `${"A".repeat(43)}=`;
const KEY = "boat_0123456789abcdef";

const offRow = (provider: string): SandboxProviderState => ({ provider, connected: false, limit: 0 });
const off: SandboxState = { boxPubKey: BOX, placing: false, providers: [offRow("boat")] };
const withRow = (s: SandboxState, row: SandboxProviderState): SandboxState => ({ ...s, providers: s.providers.map((p) => (p.provider === row.provider ? row : p)) });
const boatOn = withRow(off, { provider: "boat", connected: true, limit: 5, check: { ok: true, at: AT } });

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: SandboxKeyRequest[];
let state: SandboxState | HubError;
let testAnswer: SandboxState;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  sealed = [];
  state = off;
  snap = { machines: [], slots: { cap: 12, used: 0, queued: 0, perProject: [] } };
  testAnswer = boatOn;
  (globalThis as { fleetd?: unknown }).fleetd = {
    platform: "linux",
    secret: {
      sandboxKey: (_hub: string, request: SandboxKeyRequest) => {
        sealed.push(request);
        state = withRow(off, { provider: request.provider, connected: true, limit: 5, check: { ok: true, at: AT } });
        return Promise.resolve({ ok: true, output: state });
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

/** The hub's machines and slot board in its snapshot: its runner, and the live count and trouble. */
let snap: { machines: Machine[]; slots: SlotState } = { machines: [], slots: { cap: 12, used: 0, queued: 0, perProject: [] } };

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "1", protocol: 1, busy: [], admin: true, me: { personId: "p_aaaaaaaa", name: "Sam", role: "owner" } } });
      if (tool === "sandbox_get") return Promise.resolve("code" in state ? { ok: false, error: state } : { ok: true, output: state });
      if (tool === "sandbox_test") {
        state = testAnswer;
        return Promise.resolve({ ok: true, output: testAnswer });
      }
      if (tool === "sandbox_set" && "providers" in state) {
        const { provider, limit } = input as { provider: string; limit: number };
        state = { ...state, providers: state.providers.map((p) => (p.provider === provider ? { ...p, limit } : p)) };
        return Promise.resolve({ ok: true, output: state });
      }
      if (tool === "sandbox_disconnect") {
        state = off;
        return Promise.resolve({ ok: true, output: off });
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
          <ProvidersGroup />
          <WhatRunsWhere />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: snap.machines, projects: [], slots: snap.slots } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const row = (p: string) => host.querySelector<HTMLElement>(`[data-sandbox="${p}"]`);
const within = (el: HTMLElement | null): ParentNode => el ?? host;
const button = (name: string, where: ParentNode = host) => [...where.querySelectorAll("button")].find((b) => b.textContent === name);
const click = async (b: HTMLElement | undefined) => {
  if (b === undefined) throw new Error("no such button");
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};
/** A connected provider's menu (⋯): opens it and picks `label`. */
const fromMenu = async (p: string, label: string) => {
  const trigger = row(p)?.querySelector<HTMLElement>("button[aria-haspopup='menu']");
  if (trigger === null || trigger === undefined) throw new Error(`no menu on ${p}`);
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
  if (item === undefined) throw new Error(`no ${label} in ${p}'s menu`);
  await click(item);
};
const typeInto = async (label: string, text: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (input === null) throw new Error(`no field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const where = (kind: string) => host.querySelector<HTMLElement>(`[data-where-kind='${kind}']`);

it("lists boat.dev with what it runs and Connect, and no stale line about agents not running there", async () => {
  await render();
  const rows = [...host.querySelectorAll<HTMLElement>("[data-sandbox]")].map((r) => r.getAttribute("data-sandbox"));
  expect(rows).toEqual(["boat"]);
  expect(row("boat")?.textContent).toContain("fleetd's computersAgents · Browser · Linux desktop · Android");
  expect(row("boat")?.querySelector("[role='alert'], [role='status']:not(:empty)")).toBeNull();
  expect(row("boat")?.querySelector("[data-mark='off']")).not.toBeNull();
  expect(button("Connect", within(row("boat")))).toBeDefined();
  expect(host.textContent).not.toContain("Agents don't run in hosted sandboxes yet");
});

it("connects boat.dev through a sealed field whose key goes to main only, then says it is ready", async () => {
  await render();
  await click(button("Connect", within(row("boat"))));
  expect(host.querySelector("input[aria-label=\"fleetd's computers API key\"]")?.hasAttribute("data-secret")).toBe(true);
  expect(host.querySelector("input[aria-label*='domain']")).toBeNull();
  expect(button("Connect", within(row("boat")))?.disabled).toBe(true);
  await typeInto("fleetd's computers API key", `  ${KEY}\n`);
  await click(button("Connect", within(row("boat"))));
  expect(sealed).toEqual([{ boxPubKey: BOX, provider: "boat", key: KEY }]);
  expect(JSON.stringify(calls)).not.toContain(KEY);
  expect(host.textContent).not.toContain(KEY);
  expect(row("boat")?.getAttribute("data-sandbox-state")).toBe("connected");
  expect(words()).toBe("Ready · 0 of 5 running");
  expect(row("boat")?.querySelector("[data-mark='ready']")).not.toBeNull();
  expect(row("boat")?.querySelector("button[aria-haspopup='menu']")).not.toBeNull();
});

it("says what a failed test found with its fix, and disconnects", async () => {
  state = boatOn;
  testAnswer = withRow(off, { provider: "boat", connected: true, limit: 5, check: { ok: false, at: AT, reason: "invalid_key", message: "fleetd's computers refused the key.", fix: "try again later" } });
  await render();
  expect(row("boat")?.querySelector("[role='alert']")).toBeNull();
  await fromMenu("boat", "Test");
  expect(calls.find((c) => c.tool === "sandbox_test")?.input).toEqual({ provider: "boat" });
  // No machine's name and no status code; Test again on the line itself.
  expect(words()).toBe("fleetd's computers refused the key. Try again later.");
  expect(row("boat")?.querySelector("[data-mark='failed']")).not.toBeNull();
  calls = [];
  await click(button("Test again", within(row("boat"))));
  expect(calls.find((c) => c.tool === "sandbox_test")?.input).toEqual({ provider: "boat" });
  await fromMenu("boat", "Disconnect");
  expect(calls.find((c) => c.tool === "sandbox_disconnect")?.input).toEqual({ provider: "boat" });
  expect(row("boat")?.getAttribute("data-sandbox-state")).toBe("off");
});

const runner = (status: Machine["status"], more: Partial<Machine> = {}): Machine => ({
  machineId: "hosted",
  name: "Hosted sandboxes",
  nodeVersion: "1.0.0",
  status,
  lastSeenAt: AT,
  runner: true,
  tags: [],
  ...more,
});
const billing: ProviderTrouble = {
  what: "start",
  reason: "billing",
  message: "fleetd's computers refused: billing isn't set up on the account",
  fix: "try again later",
  until: "2026-11-17T10:10:00.000Z",
};
const line = () => row("boat");
/** The row's line, without the button at its end. */
const words = () => row("boat")?.querySelector("[data-line]")?.textContent;

it("says Starting… while its runner comes up, with no button", async () => {
  state = boatOn;
  snap.machines = [runner("degraded", { degradedCause: "starting", degradedReason: "Starting…" })];
  await render();
  expect(row("boat")?.getAttribute("data-hosted-state")).toBe("starting");
  expect(words()).toBe("Starting…");
  expect(row("boat")?.querySelector("[data-mark='starting']")).not.toBeNull();
  expect(button("Try again", within(row("boat")))).toBeUndefined();
});

it("is Ready with how many of its limit run now, from the hub's live count", async () => {
  state = boatOn;
  snap = { machines: [runner("online")], slots: { cap: 12, used: 3, queued: 0, perProject: [], hosted: [{ provider: "boat", limit: 20, running: 3 }] } };
  await render();
  expect(words()).toBe("Ready · 3 of 20 running");
  expect(row("boat")?.querySelector("[data-mark='ready']")).not.toBeNull();
});

it("needs a Claude account, with Connect on the line", async () => {
  state = boatOn;
  snap.machines = [runner("degraded", { degradedCause: "claude_login", degradedReason: "no Claude account is connected for hosted sandboxes" })];
  await render();
  expect(words()).toBe("Needs a Claude account");
  expect(row("boat")?.querySelector("[data-mark='needs']")).not.toBeNull();
  expect(button("Connect", line() ?? undefined)).toBeDefined();
  // The separate notice above the providers is gone: the row says it.
  expect(host.querySelector("[data-hosted-account]")).toBeNull();
});

it("a refusal turns it red with the reason and its fix, and Try again asks again", async () => {
  state = withRow(off, { provider: "boat", connected: true, limit: 20, running: 0, check: { ok: true, at: AT }, trouble: billing });
  testAnswer = withRow(off, { provider: "boat", connected: true, limit: 20, running: 0, check: { ok: true, at: AT } });
  snap.machines = [runner("online")];
  await render();
  expect(row("boat")?.querySelector("[data-mark='failed']")).not.toBeNull();
  expect(words()).toBe("Couldn't start: fleetd's computers refused: billing isn't set up on the account. Try again later.");
  await click(button("Try again", line() ?? undefined));
  expect(calls.find((c) => c.tool === "sandbox_test")?.input).toEqual({ provider: "boat" });
  expect(row("boat")?.querySelector("[role='alert']")).toBeNull();
  expect(words()).toBe("Ready · 0 of 20 running");
});

it("What runs where is two rows: the Linux machine a pick once boat.dev is connected, the Mac machine a value", async () => {
  await render();
  // Your machines alone: nothing to choose.
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("Your machines");
  expect(where("linux")?.querySelector("button[role='combobox']")).toBeNull();
  expect(where("mac")?.querySelector("[data-where-value]")?.textContent).toBe("Your machines");
  expect(host.querySelectorAll("[data-where-kind]").length).toBe(2);
  act(() => root.unmount());
  root = createRoot(host);
  state = { ...withRow(off, { provider: "boat", connected: true, limit: 20 }), linux: "boat" };
  await render();
  expect(row("boat")?.querySelector("button[role='combobox']")?.textContent).toContain("20 at once");
  expect(where("linux")?.querySelector("button[role='combobox']")?.textContent).toContain("fleetd's computers only");
  // No explaining line under it at rest.
  expect((where("linux")?.textContent ?? "").replace("Linux machine", "").replace("fleetd's computers only", "").trim()).toBe("");
});

it("shows no sandbox provider on a hub too old for them, and the Linux machine as your machines", async () => {
  state = { code: "not_found", message: "unknown tool sandbox_get" };
  await render();
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("Your machines");
  expect(host.querySelector("[data-sandbox]")).toBeNull();
  expect(host.querySelector("[role='alert']")).toBeNull();
});
