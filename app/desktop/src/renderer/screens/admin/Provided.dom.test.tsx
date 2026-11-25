// @vitest-environment happy-dom
// Hub › Machines on a fleetd cloud team, once fleetd's computers are on for it: no provider row (no key of the team's
// to connect); What runs where's Linux machine picks between the team's own machines and fleetd's computers (Your
// machines, Your machines first then fleetd's computers, fleetd's computers only), or reads fleetd's computers while
// the team has no machine of its own, never None yet; Mac machine says Macs are the team's own; and fleetd's
// computers lists each bot running there, asleep or awake with its agents at work and the size its agents get, how many
// run at once of what the plan allows, and this period's computer time against what the plan includes. A cloud that
// doesn't answer the pick yet (sandbox_get not found) still says agents run on fleetd's computers. A self-hosted hub
// keeps its page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Machine, ProjectChatState, ProjectSummary, SandboxState, SlotState } from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import { BILLING_SAMPLES } from "../../../shared/billing.samples";
import { readBilling, type BillingState } from "../../../shared/billing";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProvidersGroup, WhatRunsWhere } from "../settings/Places";
import { ProvidedComputers } from "./Provided";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";

const bot = (projectId: string, title: string, machineId = "hosted"): ProjectSummary => ({
  machineId,
  projectId,
  title,
  workspaceRoot: `/home/fleetd/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
});

const provided = (linux: string, limit = 3, running = 1): SandboxState => ({
  boxPubKey: "",
  placing: true,
  provided: true,
  providers: [{ provider: "boat", connected: true, limit, running }],
  linux,
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sandbox: SandboxState | HubError;
let whereSet: (linux: string) => SandboxState | HubError;
let roles: Array<{ machineId: string; roles: string[] }>;
let billing: BillingState;
let snap: { machines: Machine[]; projects: ProjectSummary[]; chats: ProjectChatState[]; slots: SlotState };

const plan = (): BillingState => {
  const b = readBilling(BILLING_SAMPLES.plan);
  if (b === null) throw new Error("sample doesn't read");
  return { ...b, usage: { ...b.usage, seconds: 12 * 3600, cents: 4_20 } };
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  sandbox = provided("boat");
  whereSet = (linux) => ("code" in sandbox ? sandbox : { ...sandbox, linux });
  roles = [];
  billing = plan();
  snap = {
    machines: [],
    projects: [bot("p1", "web"), bot("p2", "api"), bot("p3", "local", "laptop")],
    chats: [
      { projectRef: { machineId: "hosted", projectId: "p1" }, lastSeq: 1, needsYou: false, leadWorking: false, leadAsleep: true },
      { projectRef: { machineId: "hosted", projectId: "p2" }, lastSeq: 1, needsYou: false, leadWorking: false },
    ],
    slots: {
      cap: 12,
      used: 2,
      queued: 0,
      perProject: [{ projectRef: { machineId: "hosted", projectId: "p2" }, maxAgents: 3, running: 2, queued: 0 }],
      hosted: [{ provider: "boat", limit: 3, running: 1 }],
    },
  };
  (globalThis as { fleetd?: unknown }).fleetd = {
    platform: "linux",
    cloud: { billing: () => Promise.resolve({ ok: true, billing }) },
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** The page's parts as Machines lays them out, on a fleetd cloud team (`cloud`) or a self-hosted hub. */
function Page({ cloud }: { cloud: boolean }) {
  const layer = useDataLayer();
  return (
    <HubScope hub={{ id: layer.hub, label: "acme", layer, ...(cloud ? { cloud: true as const } : {}) }}>
      <ProvidersGroup />
      <WhatRunsWhere />
      <ProvidedComputers />
    </HubScope>
  );
}

const render = async (cloud = true) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "1", protocol: 1, busy: [], admin: true, me: { personId: "p_aaaaaaaa", name: "Sam", role: "owner" } } });
      if (tool === "sandbox_get") return Promise.resolve("code" in sandbox ? { ok: false, error: sandbox } : { ok: true, output: sandbox });
      if (tool === "sandbox_where_set") {
        const out = whereSet((input as { linux: string }).linux);
        if ("code" in out) return Promise.resolve({ ok: false, error: out });
        sandbox = out;
        return Promise.resolve({ ok: true, output: out });
      }
      if (tool === "machine_roles") return Promise.resolve({ ok: true, output: { machines: roles } });
      if (tool === "project_settings_get") {
        const { machineId, projectId } = input as { machineId: string; projectId: string };
        const computer = projectId === "p2" ? { kind: "boat", cpu: 8, memGb: 16 } : undefined;
        return Promise.resolve({ ok: true, output: { settings: { machineId, projectId, env: [], setup: { commands: [] }, ...(computer ? { computer } : {}) } } });
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
          <Page cloud={cloud} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: snap.machines, projects: snap.projects, chats: snap.chats, slots: snap.slots } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const where = (kind: string) => host.querySelector<HTMLElement>(`[data-where-kind='${kind}']`);
const picker = () => where("linux")?.querySelector<HTMLElement>("button[role='combobox']") ?? null;
const section = () => host.querySelector<HTMLElement>("[data-provided]");
const botRow = (name: string) => [...host.querySelectorAll<HTMLElement>("[data-provided-bot]")].find((r) => r.getAttribute("aria-label") === name);

const choose = async (label: string) => {
  const trigger = picker();
  if (trigger === null) throw new Error("no Linux machine pick");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    trigger.click();
    await Promise.resolve();
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === label);
  if (option === undefined) throw new Error(`no option ${label}`);
  await act(async () => {
    option.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};

it("with no machine of the team's own, agents run on fleetd's computers: no None yet for Linux, and nothing offers a key", async () => {
  await render();
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("fleetd's computers");
  expect(picker()).toBeNull();
  expect(where("linux")?.textContent).not.toContain("None yet");
  // No provider row: fleetd's computers take no key of the team's.
  expect(host.querySelector("[data-sandboxes]")).toBeNull();
  expect(host.textContent).not.toContain("boat.dev");
  // Macs are the team's own, in one short line: none yet here.
  expect(where("mac")?.textContent).toContain("fleetd's computers don't run Macs");
  expect(where("mac")?.querySelector("[data-where-value]")?.textContent).toBe("None yet");
});

it("with a machine of the team's own, Linux machine picks between it and fleetd's computers, and a refusal says why", async () => {
  roles = [{ machineId: "laptop", roles: ["agents", "sessions"] }];
  sandbox = provided("ours_first");
  await render();
  expect(picker()?.textContent).toContain("Your machines first, then fleetd's computers");
  await choose("fleetd's computers only");
  expect(calls.filter((c) => c.tool === "sandbox_where_set")).toEqual([{ tool: "sandbox_where_set", input: { linux: "boat" } }]);
  expect(picker()?.textContent).toContain("fleetd's computers only");
  const options = async () => {
    await act(async () => {
      picker()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      picker()?.click();
      await Promise.resolve();
    });
    await settle();
    return [...document.querySelectorAll<HTMLElement>("[role='option']")].map((o) => o.textContent);
  };
  expect(await options()).toEqual(["Your machines", "Your machines first, then fleetd's computers", "fleetd's computers only"]);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  await settle();
  // The cloud refuses the team's own machines while none runs agents: its words, under the row.
  whereSet = () => ({ code: "invalid", message: "Add a computer first: no machine of the workspace's runs agents." });
  await choose("Your machines");
  expect(where("linux")?.querySelector("[role='alert']")?.textContent).toContain("Add a computer first");
});

it("lists each bot on fleetd's computers, asleep or awake with its agents and the size they get, the plan's at once and its computer time", async () => {
  await render();
  const s = section();
  expect(s).not.toBeNull();
  expect(s?.querySelector("[data-provided-at-once]")?.textContent).toBe("1 of 3 at once");
  // Only bots on fleetd's computers, by name; one on a machine of the team's isn't one.
  expect([...(s?.querySelectorAll("[data-provided-bot]") ?? [])].map((r) => r.getAttribute("aria-label"))).toEqual(["api", "web"]);
  expect(botRow("web")?.textContent).toContain("Asleep");
  expect(botRow("web")?.textContent).toContain("Automatic");
  expect(botRow("api")?.textContent).toContain("Awake · 2 agents");
  expect(botRow("api")?.textContent).toContain("8 CPU · 16 GB");
  expect(s?.querySelector("[data-provided-time]")?.textContent).toContain("12 h · $4.20 of $60 included");
  // A row opens that bot's Computer, where its size is picked.
  await act(async () => {
    botRow("api")?.querySelector<HTMLElement>("a, button")?.click();
    await Promise.resolve();
  });
  expect(window.location.hash).toBe("#/settings/projects?for=hosted/p2");
});

it("says why nothing runs while fleetd's computers are held, in Billing's words for that reason, with the way to Billing", async () => {
  snap.slots = { ...snap.slots, hosted: [{ provider: "boat", limit: 0, running: 0 }] };
  sandbox = provided("boat", 0, 0);
  const read = (sample: unknown): BillingState => {
    const b = readBilling(sample);
    if (b === null) throw new Error("sample doesn't read");
    return b;
  };
  // The month's spend cap reached, with a plan and credits: raise the cap, never "get credits".
  billing = read(BILLING_SAMPLES.cap);
  await render();
  expect(section()?.textContent).toContain("spend cap");
  expect(section()?.textContent).not.toContain("credits");
  expect(section()?.querySelector("[data-provided-at-once]")).toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  // No plan and no credits: the service's own words and fix.
  billing = read(BILLING_SAMPLES.none);
  await render();
  expect(section()?.textContent).toContain("This workspace has no plan and no credits, so fleetd can't start a computer for its bots. Pick a plan or buy credits.");
});

it("on a cloud that doesn't answer the pick yet, still says agents run on fleetd's computers", async () => {
  sandbox = { code: "not_found", message: "fleetd provides the hosted computers here: no workspace brings a boat.dev key." };
  await render();
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("fleetd's computers");
  expect(where("mac")?.textContent).toContain("fleetd's computers don't run Macs");
  expect(host.querySelector("[role='alert']")).toBeNull();
  expect(section()).not.toBeNull();
});

it("leaves a self-hosted hub's page as it was", async () => {
  sandbox = { code: "not_found", message: "unknown tool sandbox_get" };
  roles = [{ machineId: "laptop", roles: ["agents", "sessions"] }];
  await render(false);
  expect(where("linux")?.querySelector("[data-where-value]")?.textContent).toBe("Your machines");
  expect(where("mac")?.textContent).not.toContain("fleetd");
  expect(section()).toBeNull();
  expect(calls.some((c) => c.tool === "project_settings_get")).toBe(false);
});
