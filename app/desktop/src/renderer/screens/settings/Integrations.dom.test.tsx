// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { McpServerRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { IntegrationsSection } from "./Integrations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const CRM_KEY = "Bearer crm_never_in_a_hub_call_0123";
const ref = { machineId: "devbox", projectId: "navi" };

const crm: McpServer = {
  scope: { kind: "project", ...ref },
  name: "crm",
  enabled: true,
  roles: { lead: true, writers: false, reviewers: false },
  transport: { type: "http", url: "https://mcp.crm.example/mcp" },
  headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }] }],
  integration: {},
  updatedAt: AT,
};

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [], boxPubKey: BOX }],
    projects: [],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let saved: McpServerRequest[];
let tested: unknown;
let project: McpServer[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  saved = [];
  project = [];
  tested = {
    machineId: "devbox",
    result: {
      server: "CRM 2.0.0",
      tools: [
        { name: "list_contacts", policy: "read" },
        { name: "get_contact", policy: "read" },
        { name: "update_contact", policy: "ask" },
      ],
    },
  };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    openExternal: () => Promise.resolve({ ok: true }),
    secret: {
      mcpServer: (_hub: string, request: McpServerRequest): Promise<CallOutcome> => {
        saved.push(request);
        project = [{ ...crm, name: request.name, integration: request.integration?.readTools === undefined ? {} : { readTools: request.integration.readTools } }];
        return Promise.resolve({ ok: true, output: { server: project[0] } });
      },
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "mcp_server_remove") project = [];
      const output = tool === "mcp_servers_get" ? { global: [], project, userServers: true } : tool === "mcp_server_test" ? tested : { ok: true };
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <IntegrationsSection projectRef={ref} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${within.textContent ?? ""}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const dialog = () => {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  if (d === null) throw new Error("no dialog");
  return d;
};
const field = (label: string) => {
  const f = dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (f === null) throw new Error(`no field ${label}`);
  return f;
};
const row = (name: string) => {
  const r = document.querySelector<HTMLElement>(`[role="listitem"][aria-label="${name}"]`);
  if (r === null) throw new Error(`no row ${name}`);
  return r;
};
const hubCalls = () => JSON.stringify(calls);

describe("a Navi's integrations", () => {
  it("offers to add an MCP server", async () => {
    await render();
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("Add an MCP server");
    expect(document.body.textContent).toContain("Moving money, trading and creating accounts are never allowed.");
    expect(document.body.textContent).not.toMatch(/xaq/iu);
  });

  it("shows a connected server: its key sealed on Navi's machine, and a test by policy", async () => {
    project = [crm];
    await render();
    await click(button("Test connection", row("crm")));
    const text = row("crm").textContent;
    expect(text).toContain("Connected");
    expect(text).toContain("Key sealed on devbox. Navi never sees it.");
    expect(text).toContain("Works on devbox (CRM 2.0.0): 2 tools run without asking · 1 asks you each time.");
    expect(text).toContain("list_contacts, get_contact");
    tested = { machineId: "devbox", result: { error: "HTTP 401 Unauthorized" } };
    await click(button("Test connection", row("crm")));
    expect(row("crm").querySelector('[role="alert"]')?.textContent).toContain("Failed on devbox: HTTP 401 Unauthorized");
  });

  it("adds a custom server, then saves the tools the person ticks as only reading", async () => {
    tested = {
      machineId: "devbox",
      result: {
        tools: [
          { name: "list_issues", readOnly: true, policy: "ask" },
          { name: "create_issue", policy: "ask" },
          { name: "transfer_funds", readOnly: true, policy: "blocked" },
        ],
      },
    };
    await render();
    await click(button("Add an MCP server"));
    await type(field("Name"), "linear");
    await type(field("URL"), "https://mcp.linear.app/mcp");
    await type(field("Key"), CRM_KEY);
    await click(button("Connect and test", dialog()));
    expect(saved[0]?.integration).toEqual({});
    expect(saved[0]?.headers).toEqual([{ kind: "secret", name: "Authorization", value: CRM_KEY }]);
    expect(hubCalls()).not.toContain(CRM_KEY);
    // The server's own read-only hint is ticked; a blocked tool can't be.
    const box = (name: string) => [...dialog().querySelectorAll<HTMLElement>('[role="checkbox"]')].find((c) => c.closest("label")?.textContent.includes(name) ?? c.parentElement?.textContent.includes(name));
    expect(box("list_issues")?.getAttribute("aria-checked")).toBe("true");
    expect(box("transfer_funds")?.getAttribute("aria-checked")).toBe("false");
    expect(dialog().textContent).toContain("Blocked: fleetd never runs this one.");
    await click(button("Save", dialog()));
    expect(saved[1]?.integration).toEqual({ readTools: ["list_issues"] });
    expect(document.body.textContent).not.toContain(CRM_KEY);
  });

  it("adds the person's URL server with its key, in plain words throughout", async () => {
    await render();
    await click(button("Add an MCP server"));
    const words = () => dialog().textContent;
    expect(words()).toContain("encrypted on this computer so only devbox can read it");
    expect(words()).not.toMatch(/\blead\b|integration|only reads?\b/iu);
    await type(field("Name"), "xaq");
    await type(field("URL"), "https://macbook.example.ts.net/mcp");
    await type(field("Key"), CRM_KEY);
    await click(button("Connect and test", dialog()));
    expect(saved[0]?.transport).toEqual({ type: "http", url: "https://macbook.example.ts.net/mcp" });
    expect(saved[0]?.headers).toEqual([{ kind: "secret", name: "Authorization", value: CRM_KEY }]);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(words()).toContain("Which of xaq's tools may Navi use without asking?");
    expect(words()).not.toMatch(/\blead\b|integration|only reads?\b|sealed/iu);
  });

  it("shows the hub's refusal as what happened and what to do, and keeps the dialog open", async () => {
    vi.stubGlobal("fleetd", {
      platform: "linux",
      openExternal: () => Promise.resolve({ ok: true }),
      secret: {
        mcpServer: (): Promise<CallOutcome> =>
          Promise.resolve({ ok: false, error: { code: "machine_offline", message: "Machine devbox is offline.", fix: "Start the node on devbox or check its network, then retry." } }),
      },
    });
    await render();
    await click(button("Add an MCP server"));
    await type(field("Name"), "xaq");
    await type(field("URL"), "https://macbook.example.ts.net/mcp");
    await click(button("Connect and test", dialog()));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Machine devbox is offline. Start the node on devbox or check its network, then retry.");
    expect(button("Connect and test", dialog()).disabled).toBe(false);
  });

  it("says a saved server whose test failed is added, and how to fix it", async () => {
    tested = { machineId: "devbox", result: { error: "HTTP 401 Unauthorized" } };
    await render();
    await click(button("Add an MCP server"));
    await type(field("Name"), "xaq");
    await type(field("URL"), "https://macbook.example.ts.net/mcp");
    await type(field("Key"), CRM_KEY);
    await click(button("Connect and test", dialog()));
    expect(dialog().textContent).toContain("xaq is added, but its test failed");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Failed on devbox: HTTP 401 Unauthorized. Check the key: the server refused it.");
    expect(dialog().textContent).not.toContain("Which of");
    await click(button("Done", dialog()));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("disconnects: the server goes, and the key is erased from Navi's machine", async () => {
    project = [crm];
    await render();
    await click(button("Disconnect", row("crm")));
    expect(dialog().textContent).toContain("the key is erased from devbox");
    expect(dialog().textContent).toContain("revoke the key where you made it");
    await click(button("Disconnect", dialog()));
    expect(calls.find((c) => c.tool === "mcp_server_remove")?.input).toEqual({ scope: crm.scope, name: "crm" });
    await settle();
    expect(document.querySelector('[role="listitem"][aria-label="crm"]')).toBeNull();
  });
});
