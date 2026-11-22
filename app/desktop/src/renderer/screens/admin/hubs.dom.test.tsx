// @vitest-environment happy-dom
// Settings' Hub group with several hubs: it says which hub it manages above every page, the
// group switches between the hubs this person administers (keeping the page), and an invite is made on the hub it
// names, never on whichever hub some other screen had open. An old Administration link still lands on its hub. With
// one hub, none of it shows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import type { HubEntry } from "../../../shared/hubs";
import { createHubSet } from "../../src/data/hubs";
import { HubsProvider } from "../../src/data/react";
import { BILLING_SAMPLES } from "../../../shared/billing.samples";
import { PAID_READ_EVERY_MS, readBilling } from "../../../shared/billing";
import { resetBillingReturn } from "./Billing";
import { AT, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { Shell } from "../shell/Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake = vi.hoisted(() => {
  const hubs = new Map<string, { listeners: Set<(frame: unknown) => void>; calls: Array<{ tool: string; input: unknown }> }>();
  // Each cloud team's `GET /billing/v1` answer, by hub.
  const billing = new Map<string, unknown>();
  // The role this app's person has on each hub (hub_info's `me`).
  const roles = new Map<string, "owner" | "admin" | "member">();
  // Hubs from before hub_info: it isn't a tool there, and the app lets their keys try.
  const old = new Set<string>();
  const of = (id: string) => {
    const held = hubs.get(id) ?? { listeners: new Set(), calls: [] };
    hubs.set(id, held);
    return held;
  };
  const done = () => Promise.resolve();
  const answer = (id: string, tool: string): unknown => {
    const at = "2026-10-19T10:00:00.000Z";
    const me = { personId: "p_aaaaaaaa", name: "Sam Rivera", role: roles.get(id) ?? "member", createdAt: at };
    switch (tool) {
      case "hub_info":
        if (old.has(id)) return undefined;
        return { version: "0.0.0", protocol: 1, busy: [], me };
      case "people_list":
        return { people: [me], devices: [], invites: [], me: me.personId };
      case "invite_create":
        return {
          invite: { inviteId: "inv_bbbbbbbb", person: { personId: "p_eeeeeeee", name: "Eve Park" }, state: "open", createdAt: at, expiresAt: "2026-10-26T10:00:00.000Z" },
          code: "ABCD-2345",
          link: `fleetd://pair?hub=${id}&code=ABCD-2345`,
          hubUrl: `http://${id}:4790`,
        };
      case "orders_board":
        return { orders: [] };
      default:
        return undefined;
    }
  };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    vibrancy: false,
    softwareCompositing: false,
    version: "test",
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: () => () => undefined,
      notify: () => Promise.resolve(true),
      setBadge: done,
      setMenuState: done,
      presence: () => Promise.resolve(true),
      linkHandler: () => Promise.resolve({ packaged: false, handler: false }),
      logError: done,
    },
    updates: { state: () => new Promise(() => undefined), subscribe: () => () => undefined },
    hubs: { list: () => Promise.resolve([]), subscribe: () => () => undefined, update: () => Promise.resolve({ ok: true }) },
    hub: {
      subscribe: (id: string, listener: (frame: unknown) => void) => {
        of(id).listeners.add(listener);
        return () => of(id).listeners.delete(listener);
      },
      call: (id: string, tool: string, input: unknown) => {
        of(id).calls.push({ tool, input });
        const output = answer(id, tool);
        return Promise.resolve(output === undefined ? { ok: false, error: { code: "not_found", message: `${tool} isn't faked` } } : { ok: true, output });
      },
      chat: done,
      focus: done,
      watch: done,
      input: done,
      resync: done,
      retryNow: done,
      cache: { read: () => Promise.resolve(null), write: done },
      forget: done,
    },
    machines: { thisComputer: () => Promise.resolve({ kind: "none" }), joinHereState: () => Promise.resolve(null), onJoinHere: () => () => undefined },
    pair: { store: () => Promise.resolve(null), probe: (hub: string) => Promise.resolve({ answers: false, hub }), start: () => new Promise(() => undefined) },
    system: { hostName: () => Promise.resolve("devbox") },
    cloud: {
      billing: (id: string) => {
        const answer = billing.get(id);
        return Promise.resolve(answer === undefined ? { ok: false, failure: { code: "not_found", message: "Nothing is here." } } : { ok: true, billing: answer });
      },
    },
  });
  return { hubs, of, roles, old, billing };
});

const send = (id: string, frame: HubFrame) => {
  for (const l of fake.of(id).listeners) l(frame);
};
const calls = (id: string, tool: string) => fake.of(id).calls.filter((c) => c.tool === tool);

/** A hub up, at `url`, with one project of its own. */
const up = (id: string, url: string) => {
  send(id, { t: "state", state: { phase: "live", hub: url, protocol: 1 } });
  const frame = snapshot(1);
  if (frame.t !== "snapshot") throw new Error("not a snapshot");
  send(id, {
    t: "snapshot",
    snapshot: {
      ...frame.snapshot,
      projects: [{ machineId: "devbox", projectId: id, title: id, workspaceRoot: `/srv/${id}`, lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 0, failed: 0 } }],
    },
  });
};

let host: HTMLDivElement;
let root: Root;

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

const mount = async (entries: HubEntry[]) => {
  const set = createHubSet(window.fleetd, entries);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <HubsProvider hubs={set}>
        <UiProvider>
          <Shell />
        </UiProvider>
      </HubsProvider>,
    );
    await Promise.resolve();
  });
  act(() => {
    up("hub", "http://devbox:4790");
    up("a1b2", "https://hub.acme.example");
    up("c3d4", "http://club-hub:4790");
  });
  // Settings' pages and sidebar load in a chunk of their own.
  await act(() => import("../settings/SettingsScreen"));
  await settle();
  await settle();
};

const go = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
  });
  await settle();
  await settle();
  await settle();
};

const managing = () => host.querySelector<HTMLElement>("[data-managing]");
const choices = () => [...host.querySelectorAll<HTMLElement>("[data-admin-hub]")].map((b) => [b.dataset["adminHub"], b.getAttribute("aria-current") === "page"]);
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name);
/** Opens People's invite form, if it isn't open already. */
const openInvite = async () => {
  const open = button("Invite someone");
  if (open === undefined) return;
  act(() => open.click());
  await settle();
};

const THREE: HubEntry[] = [
  { id: "hub", label: "Personal" },
  { id: "a1b2", label: "Acme", color: "amber" },
  { id: "c3d4", label: "Club" },
];

beforeEach(() => {
  window.location.hash = "#/";
  window.localStorage.clear();
  fake.hubs.clear();
  fake.roles.clear();
  fake.old.clear();
  fake.billing.clear();
  fake.roles.set("hub", "owner").set("a1b2", "admin").set("c3d4", "member");
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("names the hub it manages, and lists to switch only the hubs this person administers", async () => {
  await mount(THREE);
  await go("#/settings/hub/people?at=a1b2");
  expect(host.querySelector('[data-screen="settings.hub.people"]')).not.toBeNull();
  expect(managing()?.dataset["managing"]).toBe("a1b2");
  expect(managing()?.textContent).toContain("Acme");
  // Its name and colour only: no raw address.
  expect(managing()?.textContent).not.toContain("https://hub.acme.example");
  // Club, where they are a member, is no hub to manage.
  expect(choices()).toEqual([
    ["hub", false],
    ["a1b2", true],
  ]);
});

it("creates the invite on the hub it names, saying which, never on another", async () => {
  await mount(THREE);
  // Another hub's screen was open last: a link to Acme's People still acts on Acme.
  await go("#/project/devbox/hub?at=hub");
  await go("#/settings/hub/people?at=a1b2");
  await openInvite();
  const create = button("Create invite link to Acme");
  expect(create).toBeDefined();
  const input = host.querySelector<HTMLInputElement>("form input");
  if (input === null) throw new Error("no name field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Eve Park");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    create?.click();
    await Promise.resolve();
  });
  await settle();
  expect(calls("a1b2", "invite_create").map((c) => c.input)).toEqual([{ name: "Eve Park", role: "member" }]);
  expect(calls("hub", "invite_create")).toEqual([]);
  expect(calls("c3d4", "invite_create")).toEqual([]);
});

it("switches hub from the Hub group, keeping the page, and the page follows", async () => {
  await mount(THREE);
  await go("#/settings/hub/people?at=a1b2");
  const personal = host.querySelector<HTMLButtonElement>('[data-admin-hub="hub"]');
  act(() => personal?.click());
  await settle();
  await settle();
  expect(window.location.hash).toBe("#/settings/hub/people?at=hub");
  expect(managing()?.dataset["managing"]).toBe("hub");
  expect(managing()?.textContent).toContain("Personal");
  await openInvite();
  expect(button("Create invite link to Personal")).toBeDefined();
});

// Billing is a cloud team's, and only once fleetd's computers are on for it: before, there is nothing to buy, so no
// entry, no search result and no page that only says so; on, the switch on its page offers only the hubs that have it.
const TEAM_AND_OWN: HubEntry[] = [
  { id: "hub", label: "Personal" },
  { id: "a1b2", label: "Acme", color: "amber", cloud: true },
];
const entries = () => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Settings"] button')].map((b) => b.textContent);
const search = async (words: string) => {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
  if (field === null) throw new Error("no search");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, words);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  return [...host.querySelectorAll<HTMLElement>("[data-result]")].map((b) => b.textContent);
};

it("shows no Billing for a cloud team whose fleetd computers aren't on: no entry, no result, and its link lands on People", async () => {
  fake.roles.set("a1b2", "owner");
  fake.billing.set("a1b2", readBilling(BILLING_SAMPLES.off));
  await mount(TEAM_AND_OWN);
  await go("#/settings/hub/people?at=a1b2");
  expect(entries()).toContain("People");
  expect(entries()).not.toContain("Billing");
  // Claude's account row knows the word too; nothing found is Billing's page or a part of it.
  expect((await search("billing")).filter((r) => r.includes("Billing"))).toEqual([]);
  expect((await search("spend cap")).filter((r) => r.includes("Billing"))).toEqual([]);
  await search("");
  await go("#/settings/hub/billing?at=a1b2");
  expect(host.querySelector('[data-screen="settings.hub.billing"]')).toBeNull();
  expect(host.querySelector('[data-screen="settings.hub.people"]')).not.toBeNull();
  expect(window.location.hash).toBe("#/settings/hub/people?at=a1b2");
  expect(host.textContent).not.toContain("aren't on yet");
});

it("shows Billing once fleetd's computers are on for the team, switching only between hubs that have it", async () => {
  fake.roles.set("a1b2", "owner");
  fake.billing.set("a1b2", readBilling(BILLING_SAMPLES.plan));
  await mount(TEAM_AND_OWN);
  await go("#/settings/hub/billing?at=a1b2");
  expect(host.querySelector('[data-screen="settings.hub.billing"]')).not.toBeNull();
  expect(entries()).toContain("Billing");
  // Personal, a self-hosted hub, has no Billing: no choice of it here leads to a page that says so.
  expect(choices()).toEqual([["a1b2", true]]);
  // Elsewhere in the Hub group the switch still offers every hub this person administers.
  await go("#/settings/hub/people?at=a1b2");
  expect(choices()).toEqual([
    ["hub", false],
    ["a1b2", true],
  ]);
});

it("back from paying at Stripe, Billing says the payment arrived rather than that there are no credits, and shows them once Stripe says so", async () => {
  fake.roles.set("a1b2", "owner");
  fake.billing.set("a1b2", readBilling(BILLING_SAMPLES.none));
  resetBillingReturn();
  window.history.replaceState(null, "", "/?billing=paid&team=t1#/");
  await mount(TEAM_AND_OWN);
  await go("#/settings/hub/billing?at=a1b2");
  const page = () => host.querySelector('[data-screen="settings.hub.billing"]')?.textContent ?? "";
  expect(page()).toContain("Payment received. The credits show here in a moment, once Stripe confirms it.");
  expect(page()).not.toContain("no plan and no credits");
  // Stripe's word goes from the address at once, the rest of it kept: a reload doesn't say it again.
  expect(window.location.search).toBe("?team=t1");
  // Stripe's word lands: the page reads it on its own, and the line goes.
  fake.billing.set("a1b2", readBilling(BILLING_SAMPLES.plan));
  for (let waited = 0; page().includes("Payment received") && waited < PAID_READ_EVERY_MS * 3; waited += 100) {
    await act(() => new Promise((done) => setTimeout(done, 100)));
  }
  expect(page()).not.toContain("Payment received");
  expect(page()).toContain("$42.10 left");
  window.history.replaceState(null, "", "/#/");
  resetBillingReturn();
});

it("with one hub, names none and offers no switch: the page is as it was", async () => {
  await mount([{ id: "hub", label: "devbox" }]);
  await go("#/settings/hub/people");
  expect(host.querySelector('[data-screen="settings.hub.people"]')).not.toBeNull();
  expect(managing()).toBeNull();
  expect(choices()).toEqual([]);
  await openInvite();
  expect(button("Create invite link")).toBeDefined();
});

it("settles with hubs from before hub_info: the Hub group shows once, and nobody asks hub_info in a loop", async () => {
  fake.old.add("hub").add("a1b2");
  await mount(THREE);
  await go("#/settings/general?at=hub");
  for (let i = 0; i < 5; i++) await settle();
  const asked = calls("hub", "hub_info").length;
  for (let i = 0; i < 5; i++) await settle();
  expect(calls("hub", "hub_info").length).toBe(asked);
  expect(asked).toBeLessThan(10);
  const groups = [...host.querySelectorAll("nav[aria-label='Settings'] [role='group']")].map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
  expect(groups).toContain("Hub");
});
