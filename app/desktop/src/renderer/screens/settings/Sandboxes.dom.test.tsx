// @vitest-environment happy-dom
// The hosted sandbox providers in Hub › Machines' Providers, a row each in the order agents go to them, each saying it
// runs agents; Connect opens a sealed key field (and for E2B a domain) whose key goes to main only, never shown again;
// once connected, the limit and a menu with Test and Disconnect. While no machine places agents there yet the section
// says so. What runs where's Agents row says the order the connected ones make. A hub too old for sandbox_get shows none of them.
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
const KEY = "e2b_0123456789abcdef";

const offRow = (provider: string): SandboxProviderState => ({ provider, connected: false, limit: 0 });
const off: SandboxState = { boxPubKey: BOX, placing: false, providers: [offRow("e2b"), offRow("boat"), offRow("daytona")] };
const withRow = (s: SandboxState, row: SandboxProviderState): SandboxState => ({ ...s, providers: s.providers.map((p) => (p.provider === row.provider ? row : p)) });
const e2bOn = withRow(off, { provider: "e2b", connected: true, limit: 5, check: { ok: true, at: AT } });

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
  testAnswer = e2bOn;
  (globalThis as { fleetd?: unknown }).fleetd = {
    platform: "linux",
    secret: {
      sandboxKey: (_hub: string, request: SandboxKeyRequest) => {
        sealed.push(request);
        state = withRow(off, { provider: request.provider, connected: true, limit: 5, ...(request.domain ? { domain: request.domain } : {}), check: { ok: true, at: AT } });
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
      // A hub without Revyl: the phones' rows stand on its machines.
      if (tool === "revyl_get") return Promise.resolve({ ok: false, error: { code: "not_found", message: "unknown tool revyl_get" } });
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

it("lists the providers in the order agents go to them, each its name, what it runs and Connect, and says none runs agents yet", async () => {
  await render();
  const rows = [...host.querySelectorAll<HTMLElement>("[data-sandbox]")].map((r) => r.getAttribute("data-sandbox"));
  expect(rows).toEqual(["e2b", "boat", "daytona"]);
  expect(row("boat")?.textContent).toContain("boat.devAgents");
  expect(host.querySelector("[data-where-kind='agents'] [data-where-value]")?.textContent).toBe("Your machines");
  for (const p of ["e2b", "boat", "daytona"]) {
    expect(row(p)?.querySelector("[role='alert'], [role='status']:not(:empty)")).toBeNull();
    expect(row(p)?.querySelector("[data-mark='off']")).not.toBeNull();
    expect(button("Connect", within(row(p)))).toBeDefined();
  }
  expect(host.textContent).toContain("Agents don't run in hosted sandboxes yet");
});

it("connects E2B through a sealed field with its self-hosted domain, which go to main only, then says it works", async () => {
  await render();
  await click(button("Connect", within(row("e2b"))));
  expect(host.querySelector("input[aria-label='E2B API key']")?.hasAttribute("data-secret")).toBe(true);
  expect(host.querySelector("input[aria-label='Self-hosted E2B domain']")).not.toBeNull();
  expect(button("Connect", within(row("e2b")))?.disabled).toBe(true);
  await typeInto("E2B API key", `  ${KEY}\n`);
  await typeInto("Self-hosted E2B domain", " e2b.example.com ");
  await click(button("Connect", within(row("e2b"))));
  expect(sealed).toEqual([{ boxPubKey: BOX, provider: "e2b", key: KEY, domain: "e2b.example.com" }]);
  expect(JSON.stringify(calls)).not.toContain(KEY);
  expect(host.textContent).not.toContain(KEY);
  expect(row("e2b")?.getAttribute("data-sandbox-state")).toBe("connected");
  expect(row("e2b")?.textContent).toContain("Works");
  expect(row("e2b")?.querySelector("[data-mark='ready']")).not.toBeNull();
  expect(row("e2b")?.querySelector("button[aria-haspopup='menu']")).not.toBeNull();
});

it("gives boat.dev and Daytona no domain field", async () => {
  await render();
  await click(button("Connect", within(row("daytona"))));
  expect(host.querySelector("input[aria-label='Daytona API key']")).not.toBeNull();
  expect(host.querySelector("input[aria-label='Self-hosted E2B domain']")).toBeNull();
});

it("says what a failed test found with its fix, and disconnects", async () => {
  state = e2bOn;
  testAnswer = withRow(off, { provider: "e2b", connected: true, limit: 5, check: { ok: false, at: AT, reason: "invalid_key", message: "devbox: E2B refused the key", fix: "make a new one" } });
  await render();
  expect(row("e2b")?.textContent).not.toContain("Works");
  await fromMenu("e2b", "Test");
  expect(calls.find((c) => c.tool === "sandbox_test")?.input).toEqual({ provider: "e2b" });
  expect(row("e2b")?.querySelector("[role='alert']")?.textContent).toBe("devbox: E2B refused the key Make a new one.");
  expect(row("e2b")?.querySelector("[data-mark='failed']")).not.toBeNull();
  await fromMenu("e2b", "Disconnect");
  expect(calls.find((c) => c.tool === "sandbox_disconnect")?.input).toEqual({ provider: "e2b" });
  expect(row("e2b")?.getAttribute("data-sandbox-state")).toBe("off");
});

it("shows the limit of each connected one, and the order agents go to them in What runs where", async () => {
  state = withRow(e2bOn, { provider: "daytona", connected: true, limit: 20 });
  await render();
  expect(host.querySelector("[data-where-kind='agents'] [data-where-value]")?.textContent).toBe("Your machines first, then E2B, then Daytona");
  expect(row("e2b")?.querySelector("button[role='combobox']")?.textContent).toContain("5 at once");
  expect(row("daytona")?.querySelector("button[role='combobox']")?.textContent).toContain("20 at once");
  expect(row("boat")?.querySelector("button[role='combobox']")).toBeNull();
});

it("shows no sandbox provider on a hub too old for them, and agents on your machines", async () => {
  state = { code: "not_found", message: "unknown tool sandbox_get" };
  await render();
  expect(host.querySelector("[data-where-kind='agents'] [data-where-value]")?.textContent).toBe("Your machines");
  expect(host.querySelector("[data-sandbox]")).toBeNull();
  expect(host.querySelector("[role='alert']")).toBeNull();
});
