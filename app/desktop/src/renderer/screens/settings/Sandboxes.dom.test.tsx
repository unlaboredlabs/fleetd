// @vitest-environment happy-dom
// The hosted sandbox provider in Hub › Machines' Providers (boat.dev), saying what it runs; Connect opens a sealed key
// field whose key goes to main only, never shown again; once connected, the limit and a menu with Test and Disconnect.
// While no machine places agents there yet the section says so. What runs where is two rows: Linux machine, a pick once
// there is more than one place, and Mac machine. A hub too old for sandbox_get shows no provider.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SandboxProviderState, SandboxState } from "../../../shared/contracts";
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
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [], slots: { cap: 12, used: 0, queued: 0, perProject: [] } } });
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
  const input = host.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
  if (input === null) throw new Error(`no field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const where = (kind: string) => host.querySelector<HTMLElement>(`[data-where-kind='${kind}']`);

it("lists boat.dev with what it runs and Connect, and says none runs agents yet", async () => {
  await render();
  const rows = [...host.querySelectorAll<HTMLElement>("[data-sandbox]")].map((r) => r.getAttribute("data-sandbox"));
  expect(rows).toEqual(["boat"]);
  expect(row("boat")?.textContent).toContain("boat.devAgents · Browser · Linux desktop");
  expect(row("boat")?.querySelector("[role='alert'], [role='status']:not(:empty)")).toBeNull();
  expect(row("boat")?.querySelector("[data-mark='off']")).not.toBeNull();
  expect(button("Connect", within(row("boat")))).toBeDefined();
  expect(host.textContent).toContain("Agents don't run in hosted sandboxes yet");
});

it("connects boat.dev through a sealed field whose key goes to main only, then says it works", async () => {
  await render();
  await click(button("Connect", within(row("boat"))));
  expect(host.querySelector("input[aria-label='boat.dev API key']")?.hasAttribute("data-secret")).toBe(true);
  expect(host.querySelector("input[aria-label*='domain']")).toBeNull();
  expect(button("Connect", within(row("boat")))?.disabled).toBe(true);
  await typeInto("boat.dev API key", `  ${KEY}\n`);
  await click(button("Connect", within(row("boat"))));
  expect(sealed).toEqual([{ boxPubKey: BOX, provider: "boat", key: KEY }]);
  expect(JSON.stringify(calls)).not.toContain(KEY);
  expect(host.textContent).not.toContain(KEY);
  expect(row("boat")?.getAttribute("data-sandbox-state")).toBe("connected");
  expect(row("boat")?.textContent).toContain("Works");
  expect(row("boat")?.querySelector("[data-mark='ready']")).not.toBeNull();
  expect(row("boat")?.querySelector("button[aria-haspopup='menu']")).not.toBeNull();
});

it("says what a failed test found with its fix, and disconnects", async () => {
  state = boatOn;
  testAnswer = withRow(off, { provider: "boat", connected: true, limit: 5, check: { ok: false, at: AT, reason: "invalid_key", message: "devbox: boat.dev refused the key", fix: "make a new one" } });
  await render();
  expect(row("boat")?.textContent).not.toContain("Works");
  await fromMenu("boat", "Test");
  expect(calls.find((c) => c.tool === "sandbox_test")?.input).toEqual({ provider: "boat" });
  expect(row("boat")?.querySelector("[role='alert']")?.textContent).toBe("devbox: boat.dev refused the key Make a new one.");
  expect(row("boat")?.querySelector("[data-mark='failed']")).not.toBeNull();
  await fromMenu("boat", "Disconnect");
  expect(calls.find((c) => c.tool === "sandbox_disconnect")?.input).toEqual({ provider: "boat" });
  expect(row("boat")?.getAttribute("data-sandbox-state")).toBe("off");
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
  expect(where("linux")?.querySelector("button[role='combobox']")?.textContent).toContain("boat.dev only");
  // No explaining line under it at rest.
  expect((where("linux")?.textContent ?? "").replace("Linux machine", "").replace("boat.dev only", "").trim()).toBe("");
});

it("shows no sandbox provider on a hub too old for them, and the Linux machine as your machines", async () => {
  state = { code: "not_found", message: "unknown tool sandbox_get" };
  await render();
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("Your machines");
  expect(host.querySelector("[data-sandbox]")).toBeNull();
  expect(host.querySelector("[role='alert']")).toBeNull();
});
