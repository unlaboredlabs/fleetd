// @vitest-environment happy-dom
// Settings' Hub group (D211): hidden from members (no Hub group in Settings' sidebar, and a Hub page says it is for
// owners and admins); Settings' entry saying how much setup is left; an invite created with a name and role, its link
// copied once, and an open one revoked; a role changed and a person removed, each the call the hub expects.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubInfoOutput, PeopleListOutput, Person } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { Sidebar } from "../shell/Sidebar";
import { useAdministers } from "./role";
import { SettingsScreen, SettingsSidebar } from "../settings/SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const person = (personId: string, name: string, role: Person["role"]): Person => ({ personId, name, role, createdAt: AT });
const sam = person("p_aaaaaaaa", "Sam Rivera", "owner");
const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
const bob = person("p_cccccccc", "Bob Okafor", "member");
const ref = (p: Person) => ({ personId: p.personId, name: p.name });
const device = (keyId: string, name: string, p: Person) => ({
  keyId,
  name,
  prefix: keyId,
  kind: "human" as const,
  grants: [{ role: "admin" as const, machines: "*" as const }],
  createdAt: AT,
  person: ref(p),
});
const people: PeopleListOutput = {
  people: [sam, alice, bob],
  devices: [device("k1", "MacBook", sam), device("k2", "ThinkPad", alice), device("k3", "iMac", bob)],
  invites: [{ inviteId: "inv_aaaaaaaa", person: { personId: "p_dddddddd", name: "Dana Ito" }, state: "open", createdAt: AT, expiresAt: new Date(Date.now() + 6.5 * 86_400_000).toISOString(), createdBy: ref(sam) }],
  me: sam.personId,
};
const LINK = "fleetd://pair?hub=http%3A%2F%2Fdevbox%3A4790&code=ABCD-2345";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let copied: string[];
/** Required setup steps the hub says are left. */
let setupLeft: number;

beforeEach(() => {
  calls = [];
  copied = [];
  setupLeft = 0;
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    copy: (text: string) => (copied.push(text), Promise.resolve()),
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

function Entry() {
  const admin = useAdministers();
  return (
    <TooltipProvider>
      <Sidebar projects={[]} screen={{ id: "status", at: "hub" }} jumpHints={false} collapsed={new Set()} onToggleHub={() => undefined} factory={false} admin={admin} go={() => undefined} />
    </TooltipProvider>
  );
}

/**
 * `old`: a hub from before people, which has none of the people tools; `info: null`, not even hub_info. `what`: the
 * Settings page the route names, the main sidebar, or Settings' own sidebar.
 */
const render = async (info: Partial<HubInfoOutput> | null, what: "page" | "sidebar" | "settings" = "page", old = false) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if ((old && tool !== "hub_info") || (info === null && tool === "hub_info")) return Promise.resolve({ ok: false, error: { code: "not_found", message: `No tool ${tool}.` } });
      const output =
        tool === "hub_info"
          ? { version: "0.0.0", protocol: 1, busy: [], ...info }
          : tool === "people_list"
            ? people
            : tool === "invite_create"
              ? {
                  invite: { inviteId: "inv_bbbbbbbb", person: { personId: "p_eeeeeeee", name: "Eve Park" }, state: "open", createdAt: AT, expiresAt: "2026-10-26T10:00:00.000Z" },
                  code: "ABCD-2345",
                  link: LINK,
                  hubUrl: "http://devbox:4790",
                }
              : tool === "invite_revoke"
                ? { invite: { ...people.invites[0], state: "revoked" } }
                : tool === "person_set"
                  ? { person: { ...bob, role: "admin" } }
                  : tool === "person_remove"
                    ? { person: { ...bob, removedAt: AT }, revoked: 1 }
                    : tool === "setup_list"
                      ? { steps: [], requiredLeft: setupLeft }
                      : tool === "hub_links_get"
                      ? { links: [], issued: [], boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }
                      : {};
      return Promise.resolve({ ok: true, output });
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
          {what === "page" ? (
            <SettingsScreen />
          ) : what === "sidebar" ? (
            <Entry />
          ) : (
            <TooltipProvider>
              <SettingsSidebar onBack={() => undefined} />
            </TooltipProvider>
          )}
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
  // hub_info first, then the page's own reads.
  for (let i = 0; i < 3; i++) await settle();
};

const buttons = () => [...document.querySelectorAll("button")];
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
const row = (name: string) => {
  const el = host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}']`);
  if (el === null) throw new Error(`no row ${name}`);
  return el;
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);

const hubGroup = () => host.querySelector("nav[aria-label='Settings'] section[aria-label='Hub']");

it("shows Settings' Hub group to an owner or admin, and to nobody else; the main sidebar has no Administration row", async () => {
  for (const [info, shown] of [
    [{ me: sam, admin: true }, true],
    [{ me: alice, admin: true }, true],
    [{ me: bob, admin: false }, false],
    [{ admin: true }, true],
    // A hub from before hub_info said: the app tries, as Settings did.
    [{}, true],
  ] as const) {
    await render(info, "settings");
    expect(hubGroup() !== null, JSON.stringify(info)).toBe(shown);
    // You and Projects are everyone's.
    expect(host.querySelector("nav[aria-label='Settings']")?.textContent).toContain("Your accounts");
    act(() => root.unmount());
    root = createRoot(host);
    await render(info, "sidebar");
    expect(buttons().some((b) => b.textContent.includes("Administration"))).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
  }
});

it("lists the Hub group's pages, Every project's nested, and Setup only while a required step is left", async () => {
  setupLeft = 2;
  await render({ me: sam, admin: true }, "settings");
  const rows = () => [...(hubGroup()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  expect(rows()).toEqual([
    "People",
    "Machines",
    "Every project",
    "Profiles",
    "Tools & skills",
    "Instructions & memory",
    "Prompts",
    "Hub accounts",
    "Setup2 left",
  ]);
  act(() => root.unmount());
  root = createRoot(host);
  setupLeft = 0;
  await render({ me: sam, admin: true }, "settings");
  expect(rows()).not.toContain("Setup");
  expect(rows().at(-1)).toBe("Hub accounts");
});

it("counts the required setup steps left on Settings' entry, opening it on Hub › Setup, and says nothing once none is", async () => {
  setupLeft = 2;
  const went: unknown[] = [];
  const go = (s: unknown) => went.push(s);
  function Opener() {
    const admin = useAdministers();
    return (
      <TooltipProvider>
        <Sidebar projects={[]} screen={{ id: "status", at: "hub" }} jumpHints={false} collapsed={new Set()} onToggleHub={() => undefined} factory={false} admin={admin} go={go} />
      </TooltipProvider>
    );
  }
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) =>
      Promise.resolve({ ok: true, output: tool === "hub_info" ? { version: "0.0.0", protocol: 1, busy: [], me: sam, admin: true } : tool === "setup_list" ? { steps: [], requiredLeft: setupLeft } : {} }),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Opener />
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
  for (let i = 0; i < 3; i++) await settle();
  const entry = host.querySelector<HTMLElement>("[data-opens='settings']");
  expect(entry?.textContent).toContain("2 left");
  if (entry === null) throw new Error("no Settings entry");
  await click(entry);
  expect(went).toEqual([{ id: "settings", tab: "hub.setup" }]);
});

it("never counts setup left on Settings' entry for a member", async () => {
  setupLeft = 2;
  await render({ me: bob, admin: false }, "sidebar");
  expect(host.querySelector("[data-opens='settings']")?.textContent).not.toContain("left");
  expect(sent("setup_list")).toEqual([]);
});

it("tells a member who follows a link to a Hub page that it isn't theirs, and reads nothing of it", async () => {
  for (const hash of ["#/settings/hub/people", "#/settings/hub/accounts", "#/settings/hub/tools"]) {
    window.location.hash = hash;
    await render({ me: bob, admin: false });
    expect(host.querySelector("[data-screen='settings.hub.denied']"), hash).not.toBeNull();
    expect(host.textContent).toContain("This page is for the hub's owners and admins.");
    act(() => root.unmount());
    root = createRoot(host);
  }
  expect(sent("people_list")).toEqual([]);
  expect(sent("claude_settings_get")).toEqual([]);
});

it("lists the people with their roles and devices, and changes a role", async () => {
  window.location.hash = "#/settings/hub/people";
  await render({ me: sam, admin: true });
  expect(row("Sam Rivera").textContent).toContain("you");
  expect(row("Sam Rivera").textContent).toContain("1 device: MacBook");
  expect(row("Alice Chen").textContent).toContain("1 device: ThinkPad");
  const trigger = row("Bob Okafor").querySelector<HTMLElement>("[role='combobox']");
  if (trigger === null) throw new Error("no role picker");
  expect(trigger.getAttribute("aria-label")).toBe("Bob Okafor's role");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const admin = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === "Admin");
  if (admin === undefined) throw new Error("no Admin option");
  await click(admin);
  expect(sent("person_set")).toEqual([{ personId: "p_cccccccc", role: "admin" }]);
});

it("removes a person once confirmed", async () => {
  window.location.hash = "#/settings/hub/people";
  await render({ me: sam, admin: true });
  expect(() => button("Remove", row("Sam Rivera"))).toThrow();
  await click(button("Remove", row("Bob Okafor")));
  expect(document.body.textContent).toContain("Their 1 device is signed out at once.");
  await click(button("Remove Bob Okafor"));
  expect(sent("person_remove")).toEqual([{ personId: "p_cccccccc" }]);
});

it("never offers an admin a change to the owner", async () => {
  window.location.hash = "#/settings/hub/people";
  await render({ me: alice, admin: true });
  const owner = row("Sam Rivera");
  expect(owner.querySelector("[role='combobox']")).toBeNull();
  expect(owner.textContent).toContain("Only an owner changes an owner.");
  expect(() => button("Remove", owner)).toThrow();
});

it("creates an invite on People with a name and role, copies its link, and revokes an open one", async () => {
  window.location.hash = "#/settings/hub/people";
  await render({ me: sam, admin: true });
  expect(row("Dana Ito").textContent).toContain("Expires in 6 days.");
  expect(row("Dana Ito").textContent).toContain("Invited by you.");

  // The form opens from Invite someone. No name: nothing is sent.
  expect(host.querySelector("form[aria-label='Invite someone']")).toBeNull();
  await click(button("Invite someone"));
  await click(button("Create invite link"));
  expect(host.textContent).toContain("Give them a name.");
  expect(sent("invite_create")).toEqual([]);

  const input = host.querySelector<HTMLInputElement>("form input");
  if (input === null) throw new Error("no name field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, " Eve Park ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  const adminRole = host.querySelector<HTMLElement>("form [role='radio'][value='admin']");
  if (adminRole === null) throw new Error("no Admin role");
  await click(adminRole);
  await click(button("Create invite link"));
  expect(sent("invite_create")).toEqual([{ name: "Eve Park", role: "admin" }]);
  const made = host.querySelector<HTMLElement>("section[aria-label='Invite link for Eve Park']");
  expect(made?.textContent).toContain(LINK);
  expect(made?.textContent).toContain("ABCD-2345");

  await click(button("Copy link", made ?? document));
  expect(copied).toEqual([LINK]);
  expect(button("Copied", made ?? document)).toBeDefined();

  await click(button("Revoke", row("Dana Ito")));
  expect(sent("invite_revoke")).toEqual([{ inviteId: "inv_aaaaaaaa" }]);
});

it("asks for a hub update on a hub from before people, in place of a raw error", async () => {
  for (const page of ["people", "invites"]) {
    window.location.hash = `#/settings/hub/${page}`;
    await render({ admin: true }, "page", true);
    expect(host.textContent).toContain("This hub needs updating to manage people.");
    expect(host.textContent).not.toContain("No tool");
    expect(button("Update the hub")).toBeDefined();
    expect(host.querySelector("form")).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
  }
});

it("lets a hub with no hub_info at all reach the Hub group, whose Every project pages work there", async () => {
  await render(null, "settings", true);
  expect(hubGroup()).not.toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  window.location.hash = "#/settings/hub/tools";
  await render(null, "page", true);
  expect(host.querySelector("[data-screen='settings.hub.tools']")).not.toBeNull();
});

it("says to connect a hub, not Loading… for ever, with no hub and nothing kept from one", async () => {
  window.location.hash = "#/settings/hub/people";
  const hub: HubApi = {
    call: (tool, input) => (calls.push({ tool, input }), new Promise(() => undefined)),
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <SettingsScreen />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await settle();
  expect(host.querySelector("[data-screen='settings.hub.offline']")).not.toBeNull();
  expect(host.textContent).toContain("Connect to a hub to see and change this.");
  expect(host.textContent).not.toContain("Loading…");
});
