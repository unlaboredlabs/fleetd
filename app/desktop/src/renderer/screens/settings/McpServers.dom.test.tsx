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
import { McpSection, McpSettings } from "./McpServers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const KEY2 = "Bz+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const SECRET = "ghp_never_in_a_hub_call";

const github: McpServer = {
  scope: { kind: "global" },
  name: "github",
  enabled: true,
  roles: { lead: true, writers: true, reviewers: false },
  transport: { type: "http", url: "https://api.example.com/mcp" },
  headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }] }],
  updatedAt: AT,
};

const machine = (id: string, key: string) => ({ machineId: id, name: id, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [], boxPubKey: key });

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [machine("devbox", KEY), machine("laptop", KEY2)],
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
  tested = { machineId: "devbox", result: { server: "github-mcp 1.2.0", tools: [{ name: "search_issues" }, { name: "create_pr" }] } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    secret: {
      mcpServer: (_hub: string, request: McpServerRequest): Promise<CallOutcome> => {
        saved.push(request);
        return Promise.resolve({ ok: true, output: { server: github, missingOn: ["laptop"] } });
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

const render = async (page: React.ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const output =
        tool === "mcp_servers_get" ? { global: [github], project, userServers: true } : tool === "mcp_server_test" ? tested : tool === "mcp_settings_set" ? { userServers: false } : { ok: true };
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
        <DataProvider layer={layer}>{page}</DataProvider>
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
  if (b === undefined) throw new Error(`no button ${text}`);
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

const field = (label: string, within: ParentNode = dialog()) => {
  const f = within.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (f === null) throw new Error(`no field ${label}`);
  return f;
};

describe("Settings → MCP servers", () => {
  it("lists a server by its roles and a secret only as such, and says which machine lacks it", async () => {
    await render(<McpSettings />);
    const text = document.body.textContent;
    expect(text).toContain("github");
    expect(text).toContain("Lead and writers");
    expect(text).toContain("HTTP https://api.example.com/mcp");
    expect(text).toContain("Authorization=secret");
    expect(text).toContain("Its secrets aren't on laptop");
  });

  it("tests a server: its tools, or the node's error", async () => {
    await render(<McpSettings />);
    await click(button("Test connection"));
    expect(calls.find((c) => c.tool === "mcp_server_test")?.input).toEqual({ scope: { kind: "global" }, name: "github" });
    expect(document.body.textContent).toContain("Connected on devbox to github-mcp 1.2.0: 2 tools.");
    expect(document.body.textContent).toContain("search_issues, create_pr");

    tested = { machineId: "devbox", result: { error: "db-mcp was not found on this machine's PATH" } };
    await click(button("Test connection"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Failed on devbox: db-mcp was not found on this machine's PATH");
  });

  it("adds a server with a secret sealed in main to every machine, never in a hub call, and says when it takes effect", async () => {
    await render(<McpSettings />);
    await click(button("Add server"));
    const name = dialog().querySelector<HTMLInputElement>('input[placeholder="github"]');
    if (name === null) throw new Error("no name");
    await type(name, "db");
    await type(field("Command"), "db-mcp");
    await type(field("Arguments"), "--read-only");
    await click(button("Add variable", dialog()));
    const row = dialog().querySelector<HTMLElement>('[role="group"]');
    if (row === null) throw new Error("no value row");
    await type(field("Name", row), "DB_PASSWORD");
    const secret = row.querySelector<HTMLElement>('[role="switch"]');
    await click(secret as HTMLElement);
    const value = field("Value", row);
    expect(value.hasAttribute("data-secret")).toBe(true);
    await type(value, SECRET);
    await click(button("Save", dialog()));
    expect(saved).toEqual([
      {
        scope: { kind: "global" },
        name: "db",
        enabled: true,
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "stdio", command: "db-mcp", args: ["--read-only"] },
        env: [{ kind: "secret", name: "DB_PASSWORD", value: SECRET }],
        headers: [],
        boxes: [
          { machineId: "devbox", boxPubKey: KEY },
          { machineId: "laptop", boxPubKey: KEY2 },
        ],
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    const status = document.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("one already running at its next start");
    expect(status).toContain("aren't on laptop yet");
  });

  it("turns the person's own servers off", async () => {
    await render(<McpSettings />);
    const toggle = document.querySelector<HTMLElement>('[role="switch"]');
    await click(toggle as HTMLElement);
    expect(calls.find((c) => c.tool === "mcp_settings_set")?.input).toEqual({ userServers: false });
  });

  it("on a project's page, seals its own server's secret to its machine only and shows the global it replaces", async () => {
    project = [{ ...github, scope: { kind: "project", machineId: "devbox", projectId: "p1" }, roles: { lead: false, writers: true, reviewers: false } }];
    await render(<McpSection projectRef={{ machineId: "devbox", projectId: "p1" }} />);
    expect(calls.find((c) => c.tool === "mcp_servers_get")?.input).toEqual({ project: { machineId: "devbox", projectId: "p1" } });
    expect(document.body.textContent).toContain("replaced by this project's");
    await click(button("Edit"));
    // The saved secret stays unless a new value is typed.
    await click(button("Save", dialog()));
    expect(saved[0]?.headers).toEqual([{ kind: "keep", name: "Authorization" }]);
    expect(saved[0]?.boxes).toEqual([]);
    await click(button("Edit"));
    const row = dialog().querySelector<HTMLElement>('[role="group"]');
    await type(field("Value", row as HTMLElement), `Bearer ${SECRET}`);
    await click(button("Save", dialog()));
    expect(saved[1]?.headers).toEqual([{ kind: "secret", name: "Authorization", value: `Bearer ${SECRET}` }]);
    expect(saved[1]?.boxes).toEqual([{ machineId: "devbox", boxPubKey: KEY }]);
  });
});
