// @vitest-environment happy-dom
// Settings' Hub group (D211): People, Machines, Updates, Every project (Profiles, Tools & skills, Instructions & memory),
// Hub accounts, and Setup, always; Machines a list with Add machine and recordings, each machine's role,
// screens and caps on its own page; Claude and
// GitHub on Hub accounts with the way back into the guided setup; and the hub-wide instructions, MCP
// servers and skills on Every project's pages, the hub-wide built-in prompts a page opened from the foot of its
// Instructions and saved hub-wide. A project's pages keep its own: its built-in prompts never offer a hub-wide save,
// and its Instructions are a project's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AppFrame, TopBar, UiProvider } from "../../ui";
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
/** The prompts edited on the hub: id → the level of its edit. */
let edited: Record<string, "global" | "project">;
/** The edited prompts whose built-in text changed since. */
let stale: ReadonlySet<string>;

const version = (id: string, text: string) => ({ ref: `${id}@1`, text });

/** prompt_get and prompt_set as the hub answers them: fleetd's built-in texts, but for what `edited` names. */
function promptAnswer(tool: string, input: Record<string, unknown>) {
  const id = input["id"];
  if (tool === "prompt_set") return { ok: true, output: { ref: `${String(id)}@2`, scope: input["scope"], warnings: [] } };
  const one = (pid: string) => ({ id: pid, title: pid, kind: pid === "instructions" ? "instructions" : "start", group: "lead", sentWhen: "lead start" });
  if (typeof id !== "string") {
    return { ok: true, output: { prompts: Object.keys(prompts).map((pid) => ({ ...one(pid), scope: edited[pid] ?? "default", defaultRef: `${pid}@1`, stale: stale.has(pid) })), orphans: [] } };
  }
  const text = id === "instructions" ? "" : `The ${id} text.`;
  const level = edited[id];
  const mine = level ? { ref: `${id}@e`, text: `The ${id} text, edited.` } : undefined;
  return {
    ok: true,
    output: {
      prompt: {
        ...one(id),
        perProject: prompts[id] ?? true,
        default: version(id, text),
        ...(level && mine ? { [level]: { ...mine, base: stale.has(id) ? `${id}@0` : `${id}@1` } } : {}),
        scope: level ?? "default",
        effective: mine ?? version(id, text),
        ...(level && mine && stale.has(id)
          ? { stale: { scope: level, base: { ref: `${id}@0`, text: `The old ${id} text.` }, current: version(id, text), yours: mine, merged: `The ${id} text, both.`, conflicts: false } }
          : {}),
        placeholders: [],
        safetyRules: [],
        warnings: [],
      },
    },
  };
}

beforeEach(() => {
  calls = [];
  prompts = { "lead.start": true, "task.brief.write": true, instructions: true };
  edited = {};
  stale = new Set();
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, openExternal: () => Promise.resolve({ ok: true }), system: { hostName: () => Promise.resolve("devbox") },
    // Add machine, on Machines: this computer isn't one of the hub's, and nothing is joining.
    machines: { thisComputer: () => new Promise(() => undefined), joinHereState: () => new Promise(() => undefined), onJoinHere: () => () => undefined },
    // Updates: nothing to say.
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
/** Settings in the window's frame, whose top row holds a page's name and its way back. */
const framed = (
  <AppFrame topBar={<TopBar />} sidebar={<SettingsSidebar onBack={() => undefined} />}>
    <SettingsScreen />
  </AppFrame>
);

const nav = () => host.querySelector<HTMLElement>("nav[aria-label='Settings'] section[aria-label='Hub']");
const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.textContent.trim().startsWith(`${text} `));
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
/** Picks a tab: Radix's tabs open on a pointer press, not a click. */
const tab = async (list: HTMLElement | null, name: string) => {
  const t = [...(list?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])].find((x) => x.textContent === name);
  if (t === undefined) throw new Error(`no tab ${name}`);
  await act(async () => {
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
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

it("lists the Hub group's pages flat, Setup last saying how many required steps are left, and Every project's three under tabs on its page", async () => {
  window.location.hash = "#/settings/hub/people";
  await render(admin);
  const rows = [...(nav()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
  expect(rows).toEqual(["People", "Machines", "Updates", "Every project", "Hub accounts", "Setup2 left"]);
  // Nothing nested and nothing to pick in the sidebar.
  expect(host.querySelector("nav[aria-label='Settings'] [role='group']")).toBeNull();
  expect(host.querySelector("nav[aria-label='Settings'] [role='combobox']")).toBeNull();

  await click(button("Every project", nav() ?? document));
  expect(window.location.hash).toBe("#/settings/hub/profiles");
  expect(host.querySelector("[data-screen='settings.hub.profiles']")).not.toBeNull();
  expect(button("Every project", nav() ?? document).getAttribute("aria-current")).toBe("page");
  const tabs = host.querySelector<HTMLElement>("[role='tablist'][aria-label='Every project']");
  expect([...(tabs?.querySelectorAll("[role='tab']") ?? [])].map((t) => t.textContent)).toEqual(["Profiles", "Tools & skills", "Instructions & memory"]);
  await tab(tabs, "Instructions & memory");
  expect(window.location.hash).toBe("#/settings/hub/instructions");
  expect(button("Every project", nav() ?? document).getAttribute("aria-current")).toBe("page");
});

it("keeps Machines a list (each machine's role, screens and caps on its own page), and the hub's Claude and GitHub on Hub accounts", async () => {
  window.location.hash = "#/settings/hub/machines";
  await render(admin);
  expect(host.querySelector("[data-screen='settings.hub.machines']")).not.toBeNull();
  expect(host.querySelector("section[aria-label=\"This hub's machines\"]")).not.toBeNull();
  expect(parts()).toEqual(["hub.recordings"]);

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
  // The old shared memory shows only while it has text: this hub's has none.
  expect(parts()).toEqual(["hub.instructions", "builtin-prompts"]);
  expect(host.querySelector("section[aria-label=\"This hub's machines\"]")).toBeNull();
  const text = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Instructions for every project']");
  if (text === null) throw new Error("no instructions");
  await type(text, "Write tests first.");
  await click(button("Save", host.querySelector("[data-part='hub.instructions']") ?? document));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "instructions", scope: "global", text: "Write tests first." })]);
});

it("opens the hub-wide built-in prompts from the row under the instructions for every project, and saves one hub-wide", async () => {
  // One hub-wide edit: the row says so.
  edited = { "lead.start": "global" };
  window.location.hash = "#/settings/hub/instructions";
  await render(framed);
  const row = host.querySelector<HTMLElement>("[data-part='builtin-prompts']");
  expect(row?.textContent).toContain("1 edited");
  const link = row?.querySelector<HTMLAnchorElement>("a");
  expect(link?.textContent).toBe("Built-in prompts");
  expect(link?.getAttribute("href")).toBe("#/settings/hub/prompts");
  window.location.hash = link?.getAttribute("href") ?? "";
  for (let i = 0; i < 3; i++) await settle();
  // A page of its own, with no tabs: Every project stays the sidebar's page, and the way back is its Instructions.
  const page = host.querySelector<HTMLElement>("[data-screen='settings.hub.prompts']");
  expect(host.querySelector("[role='tablist']")).toBeNull();
  expect(button("Every project", nav() ?? document).getAttribute("aria-current")).toBe("page");
  // The edited prompt first, the rest folded behind its group.
  const lists = [...(page?.querySelectorAll<HTMLElement>("[role='list']") ?? [])].map((l) => [l.getAttribute("aria-label"), [...l.querySelectorAll("button")].map((b) => b.textContent)]);
  expect(lists).toEqual([
    ["Edited", ["Lead's role, rules and playbooks"]],
    ["Not edited", ["Task agents"]],
  ]);
  await click(button("Task agents", page ?? document));
  await click(button("Writer task", page ?? document));
  expect(window.location.hash).toBe("#/settings/hub/prompts?prompt=task.brief.write");
  // The way back goes to the list, and the prompt opens from it again.
  await click(button("‹ Built-in prompts"));
  expect(window.location.hash).toBe("#/settings/hub/prompts");
  expect(host.querySelector("[data-text='code'] textarea")).toBeNull();
  await click(button("Writer task", host));
  const editor = host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea");
  if (editor === null) throw new Error("no editor");
  // Nothing to save or reset yet: no Save, and no Reset for a prompt nobody edited.
  expect([...host.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /^(Save|Reset|Discard)/u.test(t))).toEqual([]);
  await type(editor, `${editor.value}\nOne more line.`);
  await click(button("Save"));
  const saves = sent("prompt_set");
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ id: "task.brief.write", scope: "global", base: "task.brief.write@1" });
  expect(saves[0]?.["projectRef"]).toBeUndefined();
  await click(button("‹ Built-in prompts"));
  await click(button("‹ Instructions"));
  expect(window.location.hash).toBe("#/settings/hub/instructions");
});

it("opens an old link to a hub-wide prompt, and resets its edit to the built-in", async () => {
  edited = { "lead.start": "global" };
  window.location.hash = "#/settings/hub/prompts?prompt=lead.start&view=compare";
  await render(admin);
  expect(host.querySelector("[data-screen='settings.hub.prompts']")).not.toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea")?.value).toBe("The lead.start text, edited.");
  await click(button("Reset to the built-in"));
  await click(button("Reset", document.querySelector("[role='dialog'], [role='alertdialog']") ?? document));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "lead.start", scope: "global", reset: true })]);
});

it("brings an edit up to date in place once its built-in text changed: both changes together, keep mine, or the new built-in", async () => {
  edited = { "lead.start": "global" };
  stale = new Set(["lead.start"]);
  window.location.hash = "#/settings/hub/prompts";
  await render(admin);
  const row = [...host.querySelectorAll<HTMLElement>("[role='list'][aria-label='Edited'] [role='listitem']")].map((r) => r.textContent);
  expect(row).toHaveLength(1);
  expect(row[0]).toContain("built-in changed");
  await click(button("Lead's role, rules and playbooks", host));
  expect(host.textContent).toContain("fleetd changed its built-in text since this edit was made. Your text stays in effect until you choose.");
  expect([...host.querySelectorAll("[role='group'], [aria-label]")].map((e) => e.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["What fleetd changed", "What you changed"]));
  const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Both changes together']");
  expect(editor?.value).toBe("The lead.start text, both.");
  // No plain Save or Reset beside the three choices.
  expect([...host.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /^(Save|Keep|Use|Reset|Discard)/u.test(t))).toEqual(["Save both changes", "Keep mine", "Use the new built-in"]);
  await click(button("Keep mine"));
  await click(button("Save both changes"));
  // Both are written against the new built-in, so the hub takes the edit as up to date.
  expect(sent("prompt_set")).toEqual([
    expect.objectContaining({ id: "lead.start", scope: "global", text: "The lead.start text, edited.", base: "lead.start@1" }),
    expect.objectContaining({ id: "lead.start", scope: "global", text: "The lead.start text, both.", base: "lead.start@1" }),
  ]);
});

it("leaves an out-of-date hub-wide edit to the hub's page: a project's shows it as the text in effect, with nothing hub-wide to press", async () => {
  edited = { "lead.start": "global" };
  stale = new Set(["lead.start"]);
  window.location.hash = "#/settings/prompts?prompt=lead.start&for=devbox/storefront";
  await render(<Prompts route={{ tab: "prompts", prompt: "lead.start", for: "devbox/storefront" }} />);
  expect(host.textContent).not.toContain("fleetd changed its built-in text");
  expect(host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea")?.value).toBe("The lead.start text, edited.");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /^(Save|Keep|Use|Reset|Discard)/u.test(t))).toEqual([]);
});

it("shows a prompt with one text for the whole hub read only in Settings, with no Save", async () => {
  prompts["lead.start"] = false;
  window.location.hash = "#/settings/prompts?prompt=lead.start&for=devbox/storefront";
  await render(<Prompts route={{ tab: "prompts", prompt: "lead.start", for: "devbox/storefront" }} />);
  expect(host.textContent).toContain("only the hub's owners and admins change it, from Hub › Every project › Instructions & memory");
  expect(host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea")?.readOnly).toBe(true);
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save")).toBe(false);
});

it("keeps a project's built-in prompts to its own: a hub-wide edit shows as the text in effect, and a save lands on the project", async () => {
  edited = { "lead.start": "global" };
  window.location.hash = "#/settings/prompts?prompt=lead.start&for=devbox/storefront";
  await render(<Prompts route={{ tab: "prompts", prompt: "lead.start", for: "devbox/storefront" }} />);
  expect(host.textContent).toContain("In effect: the hub-wide edit. Saving changes it for storefront only.");
  // The hub-wide edit is not the project's to reset.
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reset to the built-in")).toBe(false);
  const editor = host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea");
  if (editor === null) throw new Error("no editor");
  await type(editor, `${editor.value}\nOne more line.`);
  await click(button("Save"));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "lead.start", scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" } })]);
});

it("keeps Settings' prompts to a project's own, the first project's when none is picked", async () => {
  window.location.hash = "#/settings/prompts?prompt=task.brief.write";
  await render(admin);
  expect(window.location.hash).toContain("for=devbox/storefront");
  const editor = host.querySelector<HTMLTextAreaElement>("[data-text='code'] textarea");
  if (editor === null) throw new Error("no editor");
  await type(editor, `${editor.value}\nOne more line.`);
  await click(button("Save"));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "task.brief.write", scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" } })]);
});

it("keeps Settings' instructions to one project's, with no text for every project", async () => {
  window.location.hash = "#/settings/instructions?for=devbox/storefront";
  await render(<Instructions route={{ tab: "instructions", prompt: null, for: "devbox/storefront" }} />);
  expect(host.querySelector("textarea[aria-label='Instructions for every project']")).toBeNull();
  const text = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Instructions for storefront']");
  if (text === null) throw new Error("no project instructions");
  await type(text, "Use pnpm.");
  await click(button("Save"));
  expect(sent("prompt_set")).toEqual([expect.objectContaining({ id: "instructions", scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" }, text: "Use pnpm." })]);
});
