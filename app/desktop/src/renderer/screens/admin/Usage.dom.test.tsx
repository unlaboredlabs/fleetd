// @vitest-environment happy-dom
// Settings › Workspace › Usage: the hub's figures as the page writes them (the tiles, a row per person, the No one row,
// a row per bot), the period asked for again when another is picked, and on fleetd cloud the computer time and spend.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceUsageCounts, WorkspaceUsageOutput } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { Usage } from "./Usage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const H = 3_600_000;
const counts = (c: Partial<WorkspaceUsageCounts>): WorkspaceUsageCounts => ({ agents: 0, agentMs: 0, approvals: 0, failed: 0, merged: 0, messages: 0, orders: 0, ...c });

const answer = (cloud: boolean): WorkspaceUsageOutput => {
  const spend = (cents: number, ms: number) => (cloud ? { spendCents: cents, computerMs: ms } : {});
  return {
    since: "2026-10-28T00:00:00.000Z",
    until: "2026-11-26T12:00:00.000Z",
    now: { running: 3, queued: 2, waiting: 1 },
    total: counts({ orders: 288, merged: 409, messages: 783, agents: 1098, agentMs: 670 * H, approvals: 58, failed: 24, askToMergeMs: 4 * H + 16 * 60_000, ...spend(124_000, 400 * H) }),
    previous: counts({ orders: 288, merged: 440, messages: 700, agents: 1100, agentMs: 680 * H, approvals: 66, failed: 23, askToMergeMs: 4 * H, ...spend(100_000, 380 * H) }),
    members: [
      { person: { personId: "p_maya", name: "Maya Chen" }, role: "owner", counts: counts({ messages: 235, orders: 73, agents: 292, agentMs: 171 * H, merged: 113, approvals: 18, ...spend(31_000, 100 * H) }) },
      { person: { personId: "p_dan", name: "Dan Brooks" }, role: "member", removed: true, counts: counts({ messages: 22, orders: 10, agentMs: 19 * H }) },
    ],
    unattributed: counts({ orders: 31, agents: 122, agentMs: 105 * H, merged: 44 }),
    bots: [{ name: "storefront", projectRef: { machineId: "devbox", projectId: "storefront" }, counts: counts({ orders: 112, agentMs: 261 * H, merged: 153, askToMergeMs: 4 * H + 13 * 60_000, failed: 7 }) }],
    days: [
      { date: "2026-11-25", orders: 12, merged: 12, failed: 1, agentMs: 21 * H },
      { date: "2026-11-26", orders: 5, merged: 2, failed: 0, agentMs: 16 * H },
    ],
    ...(cloud ? { currency: "USD" } : {}),
  };
};

let host: HTMLDivElement;
let root: Root;
let asked: Array<Record<string, unknown>>;

beforeEach(() => {
  asked = [];
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render(cloud: boolean) {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "workspace_usage") asked.push(input as Record<string, unknown>);
      return Promise.resolve(tool === "workspace_usage" ? ({ ok: true, output: answer(cloud) } as never) : ({ ok: false, error: { code: "not_found", message: "not faked" } } as never));
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
          <Usage />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
}

const tile = (label: string) => host.querySelector(`[role='group'][aria-label='${label}']`)?.textContent ?? "";
const table = (label: string) =>
  [...(host.querySelector(`table[aria-label='${label}']`)?.querySelectorAll("tr") ?? [])].map((tr) => [...tr.children].map((c) => c.textContent.trim()));

it("writes the period's figures: what runs now, the tiles against the period before, a row per person and per bot", async () => {
  await render(false);
  expect(asked[0]).toMatchObject({ days: 30 });
  expect(host.querySelector("[role='status']")?.textContent).toBe("3 agents running now · 2 waiting for a slot · 1 approval waiting for an answer");
  expect(tile("Orders started")).toBe("Orders started288→ same783 messages to leads");
  expect(tile("PRs merged")).toBe("PRs merged409↓ 7%1,098 agents run");
  expect(tile("Ask to merge")).toBe("Ask to merge4h 16m↑ 16mmedian");
  expect(tile("Agent hours")).toContain("670h");
  expect(tile("Spend")).toBe("");
  expect(table("People")).toEqual([
    ["People", "Messages", "Orders", "Agents", "Hours", "Merged", "Approvals"],
    ["Maya ChenOwner", "235", "73", "292", "171h", "113", "18"],
    ["Dan BrooksRemoved", "22", "10", "0", "19h", "0", "0"],
    ["No oneAutomations, lead chats", "0", "31", "122", "105h", "44", "0"],
  ]);
  expect(table("Bots")).toEqual([
    ["Bots", "Orders", "Agents", "Hours", "Merged", "To merge", "Failed"],
    ["storefront", "112", "0", "261h", "153", "4h 13m", "7"],
  ]);
});

it("asks again for the period picked, and keeps it for next time", async () => {
  await render(false);
  const seven = [...host.querySelectorAll("button")].find((b) => b.textContent === "7 days");
  await act(async () => {
    seven?.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(asked.at(-1)).toMatchObject({ days: 7 });
  expect(localStorage.getItem("fleetd.usage.days")).toBe("7");
});

it("on fleetd cloud, adds what time on fleetd's computers cost, per person and bot", async () => {
  await render(true);
  expect(tile("Spend")).toBe("Spend$1,240↑ 24%400h on fleetd's computers");
  expect(table("People")[0]).toEqual(["People", "Messages", "Orders", "Computer", "Merged", "Approvals", "Spend"]);
  expect(table("People")[1]).toEqual(["Maya ChenOwner", "235", "73", "100h", "113", "18", "$310"]);
});
