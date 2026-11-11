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
import { McpServersSection } from "./Integrations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const CRM_KEY = "Bearer crm_never_in_a_hub_call_0123";
const ref = { machineId: "devbox", projectId: "ada" };

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
    projects: [{ ...ref, title: "Ada", workspaceRoot: "/home/dev/ada", lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, onlyMe: true }],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let saved: McpServerRequest[];
let tested: unknown;
let project: McpServer[];
let global: McpServer[];
let started: unknown;
let opened: string[];
let send: (frame: HubFrame) => void;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  saved = [];
  project = [];
  global = [];
  opened = [];
  started = { authorizeUrl: "https://auth.mail.example/authorize?client_id=c1&state=s1", redirectUri: "http://devbox:4710/oauth/callback" };
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
    openExternal: (url: string) => {
      opened.push(url);
      return Promise.resolve({ ok: true });
    },
    secret: {
      mcpServer: (_hub: string, request: McpServerRequest): Promise<CallOutcome> => {
        saved.push(request);
        const { integration: _, ...plain } = crm;
        project = [
          request.integration === undefined
            ? { ...plain, name: request.name, roles: request.roles }
            : { ...crm, name: request.name, integration: request.integration.readTools === undefined ? {} : { readTools: request.integration.readTools } },
        ];
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
      const output =
        tool === "mcp_servers_get"
          ? { global, project, userServers: true }
          : tool === "mcp_server_test"
            ? tested
            : tool === "mcp_oauth_start"
              ? started
              : { ok: true };
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  send = (frame) => listener(frame);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <McpServersSection projectRef={ref} />
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
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
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

describe("a project's MCP servers", () => {
  it("offers to add an MCP server, and says the lead's writes follow Approvals", async () => {
    await render();
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(button("Add an MCP server")).toBeDefined();
    expect(document.body.textContent).toContain("Reads run unasked; anything else follows Approvals.");
    expect(document.body.textContent).not.toMatch(/xaq/iu);
  });

  it("shows a connected server: its key sealed on the project's machine, and a test by policy", async () => {
    project = [crm];
    await render();
    await click(button("Test", row("crm")));
    const text = row("crm").textContent;
    expect(text).toContain("Connected");
    expect(text).toContain("Its key is sealed on devbox. It never goes in the chat.");
    expect(text).toContain("Works on devbox (CRM 2.0.0): 2 tools run without asking · 1 asks you each time.");
    expect(text).toContain("list_contacts, get_contact");
    tested = { machineId: "devbox", result: { error: "HTTP 401 Unauthorized" } };
    await click(button("Test", row("crm")));
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
    expect(words()).toContain("Which of xaq's tools may Ada use without asking?");
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

  it("disconnects: the server goes, and the key is erased from the project's machine", async () => {
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

const MAIL = "https://mcp.mail.example/mcp";
const mail = (oauth: NonNullable<McpServer["oauth"]>): McpServer => ({ ...crm, name: "mail", transport: { type: "http", url: MAIL }, headers: [], oauth });

/** The hub says the server's sign-in moved, as it does when the browser comes back. */
let seq = 1;
const signInMoved = async (oauth: NonNullable<McpServer["oauth"]>) => {
  project = [mail(oauth)];
  seq += 1;
  await act(async () => {
    send({ t: "event", event: { seq, at: AT, type: "mcp.oauth", summary: "mail's sign-in changed", data: { name: "mail" } } });
    await new Promise((r) => setTimeout(r, 300));
  });
  await settle();
};

describe("one list for the lead and the project's agents", () => {
  const github: McpServer = {
    ...crm,
    name: "github",
    roles: { lead: true, writers: true, reviewers: false },
    transport: { type: "http", url: "https://api.example.com/mcp" },
  };

  it("lists an agents' server by its roles with Edit, beside the lead's, and the global it replaces", async () => {
    const { integration: _, ...plain } = github;
    project = [crm, plain];
    global = [{ ...plain, scope: { kind: "global" } }];
    await render();
    expect(row("github").textContent).toContain("Lead and agents · unasked");
    expect(() => button("Edit", row("crm"))).toThrow();
    expect(document.body.textContent).toContain("replaced by this project's");
    await click(button("Edit", row("github")));
    // The saved secret stays unless a new value is typed, and it is sealed to the project's machine only.
    await click(button("Save", dialog()));
    expect(saved[0]?.scope).toEqual({ kind: "project", ...ref });
    expect(saved[0]?.headers).toEqual([{ kind: "keep", name: "Authorization" }]);
    expect(saved[0]?.roles).toEqual({ lead: true, writers: true, reviewers: true });
    expect(saved[0]?.integration).toBeUndefined();
  });

  it("adds one the agents get too: every role, no policy, and no tools to pick", async () => {
    await render();
    await click(button("Add an MCP server"));
    await type(field("Name"), "db");
    await type(field("URL"), "https://mcp.db.example/mcp");
    const agents = [...dialog().querySelectorAll<HTMLElement>('[role="switch"]')].find((x) => x.closest("label")?.textContent.includes("Agents get it too") ?? false);
    if (agents === undefined) throw new Error("no agents switch");
    await click(agents);
    expect(dialog().textContent).toContain("none of its tools asks you");
    await click(button("Connect and test", dialog()));
    expect(saved[0]?.roles).toEqual({ lead: true, writers: true, reviewers: true });
    expect(saved[0]?.integration).toBeUndefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(row("db").textContent).toContain("Lead and agents · unasked");
    expect(row("db").textContent).toContain("Works on devbox (CRM 2.0.0).");
  });
});

describe("an MCP server that signs you in", () => {
  it("opens its sign-in page from Add, follows the sign-in, then asks which tools may run unasked", async () => {
    tested = { machineId: "devbox", result: { error: "mail asks you to sign in with your own account, not a key.", signIn: true } };
    await render();
    await click(button("Add an MCP server"));
    expect(dialog().textContent).toContain("Leave it empty for a service you sign in to with your account");
    await type(field("Name"), "mail");
    await type(field("URL"), MAIL);
    await click(button("Connect and test", dialog()));
    expect(saved[0]?.headers).toEqual([]);
    expect(dialog().textContent).toContain("Sign in to mail");
    expect(dialog().textContent).toContain("mail uses your own account with its service instead of a key.");
    expect(dialog().textContent).toContain("Your browser opens mcp.mail.example's own sign-in page.");
    expect(dialog().querySelector('[role="alert"]')).toBeNull();

    await click(button("Sign in", dialog()));
    // The redirect goes to where this app reaches the hub.
    expect(calls.find((c) => c.tool === "mcp_oauth_start")?.input).toEqual({ scope: crm.scope, name: "mail", hubUrl: "http://devbox:4710" });
    expect(opened).toEqual(["https://auth.mail.example/authorize?client_id=c1&state=s1"]);
    await signInMoved({ status: "signed_out", issuer: "https://auth.mail.example", signingIn: true });
    expect(dialog().textContent).toContain("Finish signing in on auth.mail.example's page in your browser.");
    await click(button("Open the sign-in page again", dialog()));
    expect(opened).toHaveLength(2);

    tested = { machineId: "devbox", result: { server: "mail 1.0", tools: [{ name: "search_mail", readOnly: true, policy: "read" }, { name: "send_mail", policy: "ask" }] } };
    await signInMoved({ status: "connected", issuer: "https://auth.mail.example", signedInAt: AT, expiresAt: AT });
    expect(dialog().textContent).toContain("Which of mail's tools may Ada use without asking?");
    expect(dialog().textContent).toContain("Works on devbox (mail 1.0).");
    await click(button("Save", dialog()));
    expect(saved[1]?.integration).toEqual({ readTools: ["search_mail"] });
    expect(saved[1]?.headers).toEqual([]);
  });

  it("says why a sign-in failed, and lets the person try again", async () => {
    project = [mail({ status: "signed_out", issuer: "https://auth.mail.example" })];
    await render();
    expect(row("mail").textContent).toContain("Signed out");
    expect(row("mail").textContent).toContain("Not signed in yet: the lead can't use it until you sign in.");
    await click(button("Sign in", row("mail")));
    expect(dialog().textContent).toContain("Sign in to mail");
    await click(button("Sign in", dialog()));
    await signInMoved({ status: "signed_out", issuer: "https://auth.mail.example", signingIn: true });
    await signInMoved({ status: "signed_out", issuer: "https://auth.mail.example", problem: "`auth.mail.example` didn't sign you in (The user denied access)." });
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("auth.mail.example didn't sign you in (The user denied access).");
    expect(button("Sign in", dialog()).disabled).toBe(false);
  });

  it("takes the person's own app where the service lets none sign up, its secret sealed in main", async () => {
    started = { redirectUri: "http://devbox:4710/oauth/callback", needsClient: { issuer: "https://login.mail.example", boxPubKey: BOX } };
    const own: unknown[] = [];
    vi.stubGlobal("fleetd", {
      platform: "linux",
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve({ ok: true });
      },
      secret: {
        mcpOauthClient: (_hub: string, request: unknown): Promise<CallOutcome> => {
          own.push(request);
          return Promise.resolve({ ok: true, output: { authorizeUrl: "https://login.mail.example/authorize?client_id=mine", redirectUri: "http://devbox:4710/oauth/callback" } });
        },
      },
    });
    project = [mail({ status: "signed_out", issuer: "https://login.mail.example" })];
    await render();
    await click(button("Sign in", row("mail")));
    await click(button("Sign in", dialog()));
    expect(dialog().textContent).toContain("login.mail.example doesn't let apps sign up by themselves");
    expect(dialog().querySelector('[aria-label="Redirect URL"]')?.textContent).toContain("http://devbox:4710/oauth/callback");
    expect(dialog().textContent).toContain("encrypted on this computer so only the hub can read it");
    expect(button("Sign in", dialog()).disabled).toBe(true);
    await type(field("Client ID"), "mine");
    await type(field("Client secret"), "own-secret-devbox");
    await click(button("Sign in", dialog()));
    expect(own).toEqual([{ scope: crm.scope, name: "mail", hubUrl: "http://devbox:4710", boxPubKey: BOX, clientId: "mine", clientSecret: "own-secret-devbox" }]);
    expect(hubCalls()).not.toContain("own-secret-devbox");
    expect(opened).toEqual(["https://login.mail.example/authorize?client_id=mine"]);
  });

  it("shows a signed-out server's reason with Reconnect, and tests it once it is back", async () => {
    project = [
      mail({
        status: "signed_out",
        issuer: "https://auth.mail.example",
        signedInAt: AT,
        problem: "`auth.mail.example` ended the sign-in (revoked), so you need to sign in again.",
      }),
    ];
    await render();
    const text = row("mail").textContent;
    expect(text).toContain("Signed out");
    expect(text).toContain("auth.mail.example ended the sign-in (revoked), so you need to sign in again.");
    expect(text).not.toContain("Key sealed");
    await click(button("Reconnect", row("mail")));
    expect(dialog().textContent).toContain("Reconnect mail");
    await click(button("Sign in", dialog()));
    await signInMoved({ status: "signed_out", issuer: "https://auth.mail.example", signedInAt: AT, signingIn: true });
    tested = { machineId: "devbox", result: { server: "mail 1.0", tools: [{ name: "search_mail", policy: "read" }] } };
    await signInMoved({ status: "connected", issuer: "https://auth.mail.example", signedInAt: "2026-10-27T11:00:00.000Z" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(row("mail").textContent).toContain("Connected");
    expect(row("mail").textContent).toContain("Signed in with auth.mail.example.");
    expect(row("mail").textContent).toContain("Works on devbox (mail 1.0): 1 tool runs without asking");
    expect(row("mail").querySelector("button")?.textContent).not.toBe("Reconnect");
  });
});
