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
const XAQ_KEY = "aib_never_in_a_hub_call_0123";
const NOTION_KEY = "ntn_never_in_a_hub_call_0123";
const ref = { machineId: "devbox", projectId: "navi" };

const google: McpServer = {
  scope: { kind: "project", ...ref },
  name: "google",
  enabled: true,
  roles: { lead: true, writers: false, reviewers: false },
  transport: { type: "http", url: "http://127.0.0.1:8425/mcp" },
  headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }] }],
  integration: { kind: "google" },
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
      server: "xaq 2.4.0",
      tools: [
        { name: "search_threads", policy: "read" },
        { name: "get_thread", policy: "read" },
        { name: "send_message", policy: "ask" },
      ],
    },
  };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    openExternal: () => Promise.resolve({ ok: true }),
    secret: {
      mcpServer: (request: McpServerRequest): Promise<CallOutcome> => {
        saved.push(request);
        project = [request.name === "google" ? google : { ...google, name: request.name, integration: { kind: request.integration?.kind ?? "custom" } }];
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
  it("lists Google and Notion to connect, and a custom server to add", async () => {
    await render();
    expect(row("Google").textContent).toContain("Gmail, Calendar and Drive, through your own xaq.");
    expect(row("Notion").textContent).toContain("Connect");
    expect(document.body.textContent).toContain("Add an MCP server");
    expect(document.body.textContent).toContain("Moving money, trading and creating accounts are never allowed.");
  });

  it("connects Google through xaq: the steps with the exact redirect URI, the key sealed in main, then a test by policy", async () => {
    await render();
    await click(button("Connect", row("Google")));
    const steps = dialog().textContent;
    expect(steps).toContain("npx xaq-cli");
    expect(steps).toContain("http://localhost:8425/oauth/callback");
    // xaq's own approval stays on as a second layer.
    expect(steps).toContain("send mode on Approval");
    expect(steps).not.toContain("Direct");
    // The redirect URI follows the address typed.
    await type(field("xaq's address"), "https://mail.example.com/");
    expect(dialog().textContent).toContain("https://mail.example.com/oauth/callback");
    expect(button("Connect and test", dialog()).disabled).toBe(true);
    await type(field("Agent key"), "nope");
    expect(dialog().textContent).toContain("An xaq agent key starts with aib_");
    await type(field("xaq's address"), "127.0.0.1:8425");
    await type(field("Agent key"), XAQ_KEY);
    await click(button("Connect and test", dialog()));

    expect(saved).toHaveLength(1);
    const request = saved[0];
    expect(request?.integration).toEqual({ kind: "google" });
    expect(request?.transport).toEqual({ type: "http", url: "http://127.0.0.1:8425/mcp" });
    expect(request?.roles).toEqual({ lead: true, writers: false, reviewers: false });
    expect(request?.headers).toEqual([{ kind: "secret", name: "Authorization", value: `Bearer ${XAQ_KEY}` }]);
    expect(request?.boxes).toEqual([{ machineId: "devbox", boxPubKey: BOX }]);
    // The key goes to main to be sealed, never in a hub call, and never shows again.
    expect(hubCalls()).not.toContain(XAQ_KEY);
    expect(document.body.textContent).not.toContain(XAQ_KEY);

    // Connected: the test's tools by what fleetd does with them.
    const google = row("Google").textContent;
    expect(google).toContain("Connected");
    expect(google).toContain("Agent key sealed on devbox. Navi never sees it.");
    expect(google).toContain("Works on devbox (xaq 2.4.0): 2 tools read freely · 1 asks you each time.");
    expect(google).toContain("search_threads, get_thread");
    expect(google).toContain("send_message");
  });

  it("says xaq isn't running when the test can't reach it, and that a key without grants lists nothing", async () => {
    project = [google];
    tested = { machineId: "devbox", result: { error: "connection refused (os error 111)" } };
    await render();
    await click(button("Test connection", row("Google")));
    expect(row("Google").querySelector('[role="alert"]')?.textContent).toContain("xaq isn't answering at http://127.0.0.1:8425/mcp from devbox. Start it there with npx xaq-cli");
    tested = { machineId: "devbox", result: { server: "xaq 2.4.0", tools: [] } };
    await click(button("Test connection", row("Google")));
    expect(row("Google").textContent).toContain("give Navi's agent a grant on your Gmail account");
  });

  it("connects Notion with its own token as a sealed NOTION_TOKEN for its official server", async () => {
    await render();
    await click(button("Connect", row("Notion")));
    expect(dialog().textContent).toContain("notion.so/profile/integrations");
    expect(dialog().textContent).toContain("Connections, and add Navi");
    await type(field("Integration secret"), NOTION_KEY);
    await click(button("Connect and test", dialog()));
    const request = saved[0];
    expect(request?.integration).toEqual({ kind: "notion" });
    expect(request?.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] });
    expect(request?.env).toEqual([{ kind: "secret", name: "NOTION_TOKEN", value: NOTION_KEY }]);
    expect(hubCalls()).not.toContain(NOTION_KEY);
    expect(document.body.textContent).not.toContain(NOTION_KEY);
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
    await click(button("Connect and test", dialog()));
    expect(saved[0]?.integration).toEqual({ kind: "custom" });
    expect(saved[0]?.headers).toEqual([]);
    // The server's own read-only hint is ticked; a blocked tool can't be.
    const box = (name: string) => [...dialog().querySelectorAll<HTMLElement>('[role="checkbox"]')].find((c) => c.closest("label")?.textContent.includes(name) ?? c.parentElement?.textContent.includes(name));
    expect(box("list_issues")?.getAttribute("aria-checked")).toBe("true");
    expect(box("transfer_funds")?.getAttribute("aria-checked")).toBe("false");
    expect(dialog().textContent).toContain("Blocked: fleetd never runs this one.");
    await click(button("Save", dialog()));
    expect(saved[1]?.integration).toEqual({ kind: "custom", readTools: ["list_issues"] });
  });

  it("disconnects: the server goes, and the key is erased from Navi's machine", async () => {
    project = [google];
    await render();
    await click(button("Disconnect", row("Google")));
    expect(dialog().textContent).toContain("the key is erased from devbox");
    expect(dialog().textContent).toContain("delete Navi's agent in xaq");
    await click(button("Disconnect", dialog()));
    expect(calls.find((c) => c.tool === "mcp_server_remove")?.input).toEqual({ scope: google.scope, name: "google" });
    await settle();
    expect(button("Connect", row("Google"))).toBeDefined();
  });
});
