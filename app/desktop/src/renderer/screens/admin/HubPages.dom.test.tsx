// @vitest-environment happy-dom
// Settings' Hub group (D211): People, Machines, Every project (Profiles, Tools & skills, Instructions & memory,
// Prompts), Hub accounts, and Setup while required steps are left; machine roles and caps on Machines; Claude and
// GitHub on Hub accounts with the way back into the guided setup; and the hub-wide instructions, memory caps, MCP
// servers, skills and prompts on Every project's pages, its prompts nested under its Prompts in the sidebar and saved
// hub-wide. A project's pages keep its own: its Prompts never offer a hub-wide save, and its Instructions are a
// project's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { Instructions } from "../settings/Instructions";
import { Prompts } from "../settings/Prompts";
import { SettingsScreen, SettingsSidebar } from "../settings/SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const owner = { personId: "p_aaaaaaaa", name: "Sam Rivera", role: "owner" as const, createdAt: AT };

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [],
    projects: [
      { machineId: "devbox", projectId: "storefront", title: "storefront", workspaceRoot: "/home/w/src/storefront", threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: Record<string, unknown> }>;
/** The prompts the hub has: id → whether a project may have its own text. */
let prompts: Record<string, boolean>;

const version = (id: string, text: string) => ({ ref: `${id}@1`, text });

/** prompt_get and prompt_set as the hub answers them, with nothing edited yet. */
function promptAnswer(tool: string, input: Record<string, unknown>) {
  const id = input["id"];
  if (tool === "prompt_set") return { ok: true, output: { ref: `${String(id)}@2`, scope: input["scope"], warnings: [] } };
  const one = (pid: string) => ({ id: pid, title: pid, kind: pid === "instructions" ? "instructions" : "start", group: "lead", sentWhen: "lead start" });
  if (typeof id !== "string") {
    return { ok: true, output: { prompts: Object.keys(prompts).map((pid) => ({ ...one(pid), scope: "default", defaultRef: `${pid}@1`, stale: false })), orphans: [] } };
  }
  const text = id === "instructions" ? "" : `The ${id} text.`;
  return {
    ok: true,
    output: {
      prompt: { ...one(id), perProject: prompts[id] ?? true, default: version(id, text), scope: "default", effective: version(id, text), placeholders: [], safetyRules: [], warnings: [] },
    },
  };
}

beforeEach(() => {
  calls = [];
  prompts = { "lead.start": true, "task.brief.write": true, instructions: true };
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, openExternal: () => Promise.resolve({ ok: true }), system: { hostName: () => Promise.resolve("devbox") },
    // Add machine, on Machines: this computer isn't one of the hub's, and nothing is joining.
    machines: { thisComputer: () => new Promise(() => undefined), joinHereState: () => new Promise(() => undefined), onJoinHere: () => () => undefined },
    // Updates, on Machines: nothing to say.
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (node: React.ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      const args = input as Record<string, unknown>;
      calls.push({ tool, input: args });
      if (tool === "prompt_get" || tool === "prompt_set") return Promise.resolve(promptAnswer(tool, args) as never);
      const output =
        tool === "hub_info"
          ? { version: "0.0.0", protocol: 1, busy: [], me: owner, admin: true }
          : tool === "setup_list"
            ? { steps: [], requiredLeft: 2 }
            : tool === "mcp_servers_get"
              ? { global: [], userServers: true }
              : tool === "skills_list"
                ? { skills: [] }
                : tool === "machine_roles_get"
                  ? { machines: [] }
                  : undefined;
      return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{node}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const admin = (
  <>
    <SettingsSidebar onBack={() => undefined} />
    <SettingsScreen />
  </>
);

const nav = () => host.querySelector<HTMLElement>("nav[aria-label='Settings'] section[aria-label='Hub']");
const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.textContent.trim().startsWith(`${text} `));
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const type = async (el: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool && c.input["dryRun"] !== true).map((c) => c.input);
const parts = () => [...host.querySelectorAll<HTMLElement>("[data-part]")].map((p) => p.dataset["part"]);

it("nests Every project's pages, Setup last saying how many required steps are left, and the prompts only under Every project's Prompts", async () => {
  window.location.hash = "#/settings/hub/people";
  await render(admin);
  const rows = [...(nav()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
  expect(rows).toEqual(["People", "Machines", "Every project", "Profiles", "Tools & skills", "Instructions & memory", "Prompts", "Hub accounts", "Setup2 left"]);
  expect(nav()?.querySelector("[role='group'][aria-label='Prompts']")).toBeNull();

  await click(button("Every project", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/hub/profiles");
  expect(host.querySelector("[data-screen='settings.hub.profiles']")).not.toBeNull();
  await click(button("Prompts", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/hub/prompts");
  expect(nav()?.querySelector("[role='group'][aria-label='Prompts']")).not.toBeNull();
});

it("puts machine roles and caps on Machines, and the hub's Claude and GitHub on Hub accounts", async () => {
  window.location.hash = "#/settings/hub/machines";
  await render(admin);
  expect(host.querySelector("[data-screen='settings.hub.machines']")).not.toBeNull();
  expect(host.querySelector("#machine-roles")).not.toBeNull();
  expect(parts()).toEqual(["hub.caps", "hub.updates"]);

  await click(button("Hub accounts", nav() ?? document));
  expect(host.querySelector("[data-screen='settings.hub.accounts']")).not.toBeNull();
  expect(parts()).toEqual(["admin.claude", "admin.github"]);
  await click(button("Run guided setup again"));
  expect(window.location.hash).toBe("#/settings/hub/setup");
});

it("gathers what reaches every project on Every project's pages, and saves its instructions hub-wide", async () => {
  window.location.hash = "#/settings/hub/tools";
  await render(admin);
  expect(parts()).toEqual(["hub.mcp", "hub.skills"]);
  window.location.hash = "#/settings/hub/instructions";
  await settle();
  expect(parts()).toEqual(["hub.instructions", "hub.memory-caps", "hub.shared-memory"]);
  expect(host.querySelector("#machine-roles")).toBeNull();
  const text = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Instructions for every project']");
  if (text === null) throw new Error("no instructions");
  await type(text, "Write tests first.");
  await click(button("Save", host.querySelector("[data-part='hub.instructions']") ?? document));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "instructions", scope: "global", text: "Write tests first." })]);
});

it("opens a hub-wide prompt from under Every project's Prompts and saves it hub-wide, with no project to pick", async () => {
  window.location.hash = "#/settings/hub/prompts";
  await render(admin);
  const group = nav()?.querySelector<HTMLElement>("[role='group'][aria-label='Prompts']");
  const first = group?.querySelector<HTMLButtonElement>("button");
  if (!first) throw new Error("no prompt listed");
  await click(first);
  expect(window.location.hash).toMatch(/^#\/settings\/hub\/prompts\?prompt=/u);
  expect(host.querySelector("[data-screen='settings.hub.prompts']")).not.toBeNull();
  const editor = host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea");
  if (editor === null) throw new Error("no editor");
  await type(editor, `${editor.value}\nOne more line.`);
  await click(button("Save"));
  const saves = sent("prompt_set");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.["scope"]).toBe("global");
  expect(saves[0]?.["projectRef"]).toBeUndefined();
});

it("shows a prompt with one text for the whole hub read only in Settings, with no Save", async () => {
  prompts["lead.start"] = false;
  window.location.hash = "#/settings/prompts?prompt=lead.start&for=devbox/storefront";
  await render(<Prompts route={{ tab: "prompts", prompt: "lead.start", for: "devbox/storefront", view: "edit" }} />);
  expect(host.textContent).toContain("only the hub's owners and admins change it, in Hub › Every project › Prompts");
  expect(host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea")?.readOnly).toBe(true);
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save")).toBe(false);
});

it("keeps Settings' prompts to a project's own, the first project's when none is picked", async () => {
  window.location.hash = "#/settings/prompts?prompt=task.brief.write";
  await render(<Prompts route={{ tab: "prompts", prompt: "task.brief.write", for: null, view: "edit" }} />);
  expect(window.location.hash).toContain("for=devbox/storefront");
  const editor = host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea");
  if (editor === null) throw new Error("no editor");
  await type(editor, `${editor.value}\nOne more line.`);
  await click(button("Save"));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "task.brief.write", scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" } })]);
});

it("keeps Settings' instructions to one project's, with no text for every project", async () => {
  window.location.hash = "#/settings/instructions?for=devbox/storefront";
  await render(<Instructions route={{ tab: "instructions", prompt: null, for: "devbox/storefront", view: "edit" }} />);
  expect(host.querySelector("textarea[aria-label='Instructions for every project']")).toBeNull();
  const text = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Instructions for storefront']");
  if (text === null) throw new Error("no project instructions");
  await type(text, "Use pnpm.");
  await click(button("Save"));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "instructions", scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" }, text: "Use pnpm." })]);
});
