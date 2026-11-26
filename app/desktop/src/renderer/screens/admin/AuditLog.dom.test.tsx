// @vitest-environment happy-dom
// Settings › Workspace › Audit log: the rows newest first by name, a refused change marked, Older for the next page,
// and Export's file is the shared CSV of every row the filters pick; a workspace from before it says to update.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuditEvent } from "../../../shared/contracts";
import { auditCsv } from "../../../shared/auditCsv";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AuditLog } from "./AuditLog";
import { resetServes } from "./role";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-11-26T10:00:00.000Z";
const row = (n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  n,
  at: new Date(Date.parse(AT) - (1000 - n) * 60_000).toISOString(),
  kind: "bot.settings",
  actor: { kind: "person", personId: "p_aaaaaaaa", name: "Sam Rivera" },
  bot: { machineId: "devbox", projectId: "p1", name: "storefront" },
  outcome: "ok",
  summary: `Row ${n}`,
  ...over,
});
// 250 rows, newest first: three pages of 100.
const ROWS = Array.from({ length: 250 }, (_, i) => row(1000 - i, i === 1 ? { actor: { kind: "person", personId: "p_cccccccc", name: "Bob Okafor" }, outcome: "refused", summary: "Tried to set who merges to fleetd" } : {}));

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: Record<string, unknown> }>;
let saved: Blob[];
let lacks: boolean;

beforeEach(() => {
  resetServes();
  calls = [];
  saved = [];
  lacks = false;
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (saved.push(b as Blob), "blob:x"));
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function page(input: Record<string, unknown>) {
  const before = typeof input["before"] === "number" ? input["before"] : Number.POSITIVE_INFINITY;
  const limit = typeof input["limit"] === "number" ? input["limit"] : 100;
  const left = ROWS.filter((r) => r.n < before);
  return { events: left.slice(0, limit), more: left.length > limit };
}

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      const args = input as Record<string, unknown>;
      calls.push({ tool, input: args });
      const output =
        tool === "hub_info"
          ? { version: "0.9.1", protocol: 1, busy: [], admin: true, me: { personId: "p_aaaaaaaa", name: "Sam Rivera", role: "owner", createdAt: AT } }
          : tool === "people_list"
            ? { people: [{ personId: "p_aaaaaaaa", name: "Sam Rivera", role: "owner", createdAt: AT }], devices: [], invites: [] }
            : tool === "audit_list" && !lacks
              ? page(args)
              : undefined;
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `No tool ${tool}.` } } : ({ ok: true, output } as never));
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
          <AuditLog />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1, version: "0.9.1" } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], projects: [], machines: [] } } as unknown as HubFrame);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const cells = () => [...host.querySelectorAll("[data-audit-row]")].map((tr) => [...tr.querySelectorAll("td")].slice(1).map((td) => td.textContent));
const click = async (el: Element | null | undefined) => {
  await act(async () => {
    (el as HTMLElement | null)?.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name);

it("lists a hundred rows newest first by name, marks a refused change, and pages back with Older", async () => {
  await render();
  expect(cells().length).toBe(100);
  expect(cells().slice(0, 2)).toEqual([
    ["Sam Rivera", "Row 1000", "storefront"],
    ["Bob Okafor", "Tried to set who merges to fleetdrefused", "storefront"],
  ]);
  expect(calls.filter((c) => c.tool === "audit_list").map((c) => c.input)).toEqual([{ limit: 100 }]);
  await click(button("Older"));
  expect(calls.filter((c) => c.tool === "audit_list").at(-1)?.input).toEqual({ limit: 100, before: 901 });
  expect(cells()[0]).toEqual(["Sam Rivera", "Row 900", "storefront"]);
  await click(button("Newer"));
  expect(cells()[0]?.[1]).toBe("Row 1000");
});

it("exports every row as the shared CSV, a page of 500 at a time", async () => {
  await render();
  await click(host.querySelector("[data-audit-export]"));
  expect(calls.filter((c) => c.tool === "audit_list" && c.input["limit"] === 500).map((c) => c.input["before"])).toEqual([undefined]);
  expect(saved.length).toBe(1);
  expect(await saved[0]?.text()).toBe(auditCsv(ROWS));
});

it("on a workspace from before the audit log, says to update", async () => {
  lacks = true;
  await render();
  expect(host.querySelector("[data-screen='settings.hub.audit']")?.textContent).toContain("This workspace keeps no audit log yet: update fleetd on it.");
  expect(host.querySelector("[data-audit-export]")).toBeNull();
});
