// @vitest-environment happy-dom
// Settings › Vault: its rows show only on a hub that serves it; it lists the team's logins, cards and addresses, a
// project's tab its variables; an item's fields are dots until Show, which goes through main (Touch ID there), and
// hide again when the window loses focus; Copy goes through main too, so the page never holds a copied value; Add sends
// the typed fields to main to seal, never to the hub, and names no scope; an item only its creator or an admin may
// show or change says so; items set aside for the person have a section of their own, only when there are some; an
// older hub's items are one list.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultItemSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { VaultCopyRequest, VaultRevealRequest, VaultSaveRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { HubVault } from "./Vault";
import { PaymentsSetting } from "./Payments";
import { SettingsScreen, SettingsSidebar } from "./SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const CANARY = "canary-7Qx-not-a-real-secret";
const AT = "2026-11-09T10:00:00.000Z";
const base = { canEdit: true, canReveal: true, createdMs: 0, updatedMs: 0, updatedBy: "human:laptop", version: 1 };
const amazon: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000001", kind: "login", scope: "hub", label: "Amazon", meta: { source: { kind: "typed" }, sites: ["amazon.com"], fields: ["username", "password"] } };
const teamCard: VaultItemSummary = { ...base, canEdit: false, canReveal: false, itemId: "V00000000000000000000000000000002", kind: "card", scope: "hub", label: "Team Visa", meta: { source: { kind: "typed" }, brand: "visa", last4: "4242" } };
/** Set aside: Sam's own from before the team vault, never shared. */
const oldCard: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000004", kind: "card", scope: "person", label: "Sam's Amex", meta: { source: { kind: "typed" }, brand: "amex", last4: "0005" } };
const oldEnv: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000005", kind: "env", scope: "person", label: "OPENAI_KEY", envName: "OPENAI_KEY", meta: { source: { kind: "typed" }, secret: true } };
const stripe: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000003", kind: "env", scope: "project", machineId: "devbox", projectId: "shop", label: "STRIPE_KEY", envName: "STRIPE_KEY", meta: { source: { kind: "typed" }, secret: true, fingerprint: "ab12cd34", bytes: 20 } };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let saves: VaultSaveRequest[];
let reveals: VaultRevealRequest[];
let copies: VaultCopyRequest[];
let card: { ref: string; label?: string; brand?: string; last4?: string } | undefined;
/** What vault_list {} gives: the team's items, and those set aside for the caller. */
let team: VaultItemSummary[];
const TEAM = ["vault", "vault_team"];

beforeEach(() => {
  calls = [];
  saves = [];
  reveals = [];
  copies = [];
  card = undefined;
  team = [amazon, teamCard];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
    copy: () => Promise.resolve(),
    vault: {
      save: (_hub: string, r: VaultSaveRequest): Promise<CallOutcome> => {
        saves.push(r);
        return Promise.resolve({ ok: true, output: { item: { ...amazon, itemId: "V00000000000000000000000000000009", label: r.label ?? "" } } });
      },
      reveal: (_hub: string, r: VaultRevealRequest) => {
        reveals.push(r);
        return Promise.resolve({ ok: true, fields: { username: "sam", password: CANARY } });
      },
      copy: (_hub: string, r: VaultCopyRequest) => {
        copies.push(r);
        return Promise.resolve({ ok: true });
      },
    },
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

const render = async (hash: string, features: string[] = TEAM, page?: ReactNode, snapshot = true) => {
  window.location.hash = hash;
  let send: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const i = input as { machineId?: string; kind?: string };
      if (tool === "vault_list") {
        const all = i.machineId === undefined ? team : (i as { usable?: boolean }).usable === true ? [stripe, teamCard] : [stripe];
        return Promise.resolve({ ok: true, output: { items: all.filter((x) => i.kind === undefined || x.kind === i.kind) } });
      }
      if (tool === "vault_get") {
        const id = (input as { itemId: string }).itemId;
        const item = [amazon, teamCard, stripe, oldCard, oldEnv].find((x) => x.itemId === id);
        return Promise.resolve({ ok: true, output: { item, activity: [{ n: 4, atMs: Date.parse(AT), action: "fill", outcome: "ok", data: { site: "amazon.com", fields: ["password"] } }] } });
      }
      if (tool === "vault_status") return Promise.resolve({ ok: true, output: { hubBoxKey: "k", keyMode: "file", locked: false, keyMissing: false, recoverySaved: true, migration: { done: true, machines: [] } } });
      if (tool === "vault_move") return Promise.resolve({ ok: true, output: { item: { ...amazon } } });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], admin: false } });
      if (tool === "project_settings_get")
        return Promise.resolve({ ok: true, output: { settings: { machineId: "devbox", projectId: "shop", title: "Shop", workspaceRoot: "/w/shop", setup: { commands: [], inputs: [] }, env: [{ name: "STRIPE_KEY", kind: "secret", fingerprint: "ab12cd34", bytes: 20, updatedAt: AT }], worktrees: { dir: "/w/wt", baseBranch: "main", worktrees: [] } } } });
      if (tool === "project_purchases") return Promise.resolve({ ok: true, output: { purchases: [], ...(card === undefined ? {} : { card }) } });
      if (tool === "project_card_set") {
        const ref = (input as { card?: string }).card;
        card = ref === undefined ? undefined : { ref, label: "Team Visa", brand: "visa", last4: "4242" };
        return Promise.resolve({ ok: true, output: card === undefined ? {} : { card } });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          {page ?? (
            <>
              <SettingsSidebar onBack={() => undefined} />
              <SettingsScreen />
            </>
          )}
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "http://devbox:4790", protocol: 1, features } });
    if (snapshot) send({
      t: "snapshot",
      snapshot: {
        cursor: 1,
        attention: [],
        machines: [],
        projects: [{ machineId: "devbox", projectId: "shop", title: "Shop", workspaceRoot: "/w/shop", threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT }],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const button = (text: string, within: ParentNode = document.body) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
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
const rows = () => [...host.querySelectorAll("[role='list'][aria-label='Vault items'] [data-vault-row]")].map((r) => r.textContent);
const panel = () => host.querySelector<HTMLElement>("[data-vault-item]");
/** Opens a row's item, by its title. */
const openRow = async (title: string) => {
  const row = host.querySelector<HTMLElement>(`[data-vault-row][aria-label='${title}'] button`);
  if (row === null) throw new Error(`no row ${title}`);
  await click(row);
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const fieldByLabel = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${label}`);
  return el;
};

it("shows no Vault row on a hub that doesn't serve it, and one under You where it does", async () => {
  await render("#/settings/vault", []);
  expect([...host.querySelectorAll("nav button")].map((b) => b.textContent)).not.toContain("Vault");
  expect(host.textContent).toContain("This hub has no vault yet.");
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/vault");
  expect([...host.querySelectorAll("nav button")].map((b) => b.textContent)).toContain("Vault");
});

it("lists the team's logins, cards and addresses with no tag, and the project's variables on its own tab", async () => {
  await render("#/settings/vault");
  expect(rows()).toEqual(["Amazonamazon.com", "Team VisaVisa ••4242"]);
  expect(host.textContent).not.toContain("Everyone");
  expect(host.querySelector("[data-vault-set-aside]")).toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  await render("#/settings/project-vault?for=devbox/shop");
  expect(rows()).toEqual(["STRIPE_KEYSecret"]);
  expect(calls.find((c) => c.tool === "vault_list")?.input).toEqual({ machineId: "devbox", projectId: "shop" });
});

it("shows an item's fields as dots until Show, through main, and hides them when the window loses focus", async () => {
  await render("#/settings/vault");
  await openRow("Amazon");
  expect(panel()?.textContent).toContain("••••••••");
  expect(panel()?.textContent).toContain("Filled");
  expect(panel()?.textContent).not.toContain(CANARY);
  await click(button("Show", panel() ?? host));
  expect(reveals).toEqual([{ itemId: amazon.itemId, label: "Amazon", fields: ["username", "password", "totp", "notes"] }]);
  expect(panel()?.textContent).toContain(CANARY);
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
  });
  expect(panel()?.textContent).not.toContain(CANARY);
  // Copy goes through main, which keeps the value from the page.
  await click(button("Copy the password", panel() ?? host));
  expect(copies).toEqual([{ itemId: amazon.itemId, label: "Amazon's password", field: "password" }]);
  expect(JSON.stringify(calls)).not.toContain(CANARY);
});

it("says an item only its creator or an admin may show or change, instead of greying it out", async () => {
  await render("#/settings/vault");
  await openRow("Team Visa");
  expect(panel()?.textContent).toContain("Only its creator or an admin can show it. Agents still fill it.");
  expect(panel()?.textContent).toContain("Only its creator or an admin can change or delete it.");
  const words = [...(panel()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  expect(words).not.toContain("Show");
  expect(words).not.toContain("Edit");
  expect(words).not.toContain("Delete…");
  expect(panel()?.textContent).not.toContain("Used by");
  // Its creator or an admin gets Show, Edit and Delete, and no line about it.
  await openRow("Amazon");
  expect([...(panel()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Show", "Edit", "Delete…"]));
  expect(panel()?.textContent).not.toContain("Only its creator");
});

const openPlus = async () => {
  const plus = button("Add to the vault");
  await act(async () => {
    plus.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  return [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
};

it("adds logins, cards, addresses or a 1Password import on the Vault page, and variables or a .env on a project's", async () => {
  await render("#/settings/vault");
  expect((await openPlus()).map((m) => m.textContent)).toEqual(["Login", "Card", "Address", "Import from 1Password…"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/project-vault?for=devbox/shop");
  expect((await openPlus()).map((m) => m.textContent)).toEqual(["Variable", "Paste .env…"]);
});

it("adds a login by handing its typed fields to main to seal, never to the hub, and names no scope", async () => {
  await render("#/settings/vault");
  const login = (await openPlus()).find((m) => m.textContent === "Login");
  if (login === undefined) throw new Error("no Login item");
  await click(login);
  await type(fieldByLabel("Websites"), "https://www.github.com/login");
  await type(fieldByLabel("User name"), "sam");
  await type(fieldByLabel("Password"), CANARY);
  await click(button("Add"));
  expect(saves).toEqual([{ kind: "login", label: "github.com", sites: ["github.com"], fields: { username: "sam", password: CANARY } }]);
  expect(JSON.stringify(calls)).not.toContain(CANARY);
});


it("names a picked vault card the list doesn't have by its label, never its raw vault: id", async () => {
  card = { ref: "vault:V00000000000000000000000000000077", label: "Old Visa", brand: "visa", last4: "1111" };
  await render("#/settings/projects?for=devbox/shop", TEAM, <PaymentsSetting projectRef={{ machineId: "devbox", projectId: "shop" }} />);
  expect(host.textContent).toContain("Pays with Old Visa");
  await click(button("Change…"));
  const picker = host.querySelector<HTMLElement>("[role='combobox']");
  expect(picker?.textContent).toContain("Old Visa");
  expect(host.textContent).not.toContain("vault:V");
});

it("picks the project's card from the vault cards its work can use, kept as vault:<id>", async () => {
  await render("#/settings/projects?for=devbox/shop", TEAM, <PaymentsSetting projectRef={{ machineId: "devbox", projectId: "shop" }} />);
  expect(host.textContent).toContain("from the vault");
  await click(button("Pick a card…"));
  expect(calls.filter((c) => c.tool === "vault_list").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "shop", kind: "card", usable: true }]);
  expect(calls.some((c) => c.tool === "onepassword_cards")).toBe(false);
  const picker = host.querySelector<HTMLElement>("[role='combobox']");
  if (picker === null) throw new Error("no card picker");
  await act(async () => {
    picker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const options = [...document.querySelectorAll<HTMLElement>("[role='option']")];
  expect(options.map((o) => o.textContent)).toEqual(["Team Visa · Visa ••4242", "No card"]);
  const team = options[0];
  if (team === undefined) throw new Error("no option");
  await click(team);
  expect(calls.filter((c) => c.tool === "project_card_set").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "shop", card: `vault:${teamCard.itemId}` }]);
  expect(host.textContent).toContain("Pays with Team Visa");
});

it("shows the items set aside for the person under the list, each to move or delete", async () => {
  team = [amazon, teamCard, oldCard, oldEnv];
  await render("#/settings/vault");
  expect(rows()).toEqual(["Amazonamazon.com", "Team VisaVisa ••4242"]);
  const aside = host.querySelector<HTMLElement>("[data-vault-set-aside]");
  if (aside === null) throw new Error("no set-aside section");
  expect(aside.textContent).toContain("Yours from before the team vault. Nothing uses them until you move them.");
  expect([...aside.querySelectorAll("[data-vault-row]")].map((r) => r.getAttribute("aria-label"))).toEqual(["Sam's Amex", "OPENAI_KEY"]);
  // A card goes to the team vault as it is.
  await click(button("Move to team vault", aside));
  expect(calls.filter((c) => c.tool === "vault_move").map((c) => c.input)).toEqual([{ itemId: oldCard.itemId }]);
  // A variable goes to a project, picked first: Add stays off until one is.
  await click(button("Add to a project…", aside));
  const dialog = document.querySelector<HTMLElement>("[role='dialog']");
  if (dialog === null) throw new Error("no dialog");
  expect(button("Add", dialog).disabled).toBe(true);
  const picker = dialog.querySelector<HTMLElement>("[role='combobox']");
  if (picker === null) throw new Error("no project picker");
  await act(async () => {
    picker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const shop = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === "Shop");
  if (shop === undefined) throw new Error("no Shop");
  await click(shop);
  await click(button("Add", document.querySelector<HTMLElement>("[role='dialog']") ?? document.body));
  expect(calls.filter((c) => c.tool === "vault_move").map((c) => c.input)).toEqual([{ itemId: oldCard.itemId }, { itemId: oldEnv.itemId, machineId: "devbox", projectId: "shop" }]);
});

it("lists an older hub's items as one list, the person's own among them, with no set-aside section", async () => {
  team = [amazon, teamCard, oldCard];
  await render("#/settings/vault", ["vault"]);
  expect(rows()).toEqual(["Amazonamazon.com", "Sam's AmexAmex ••0005", "Team VisaVisa ••4242"]);
  expect(host.querySelector("[data-vault-set-aside]")).toBeNull();
});

it("keeps only the vault key on Hub › Every project › Vault", async () => {
  await render("#/settings/hub/vault", TEAM, <HubVault />);
  expect(host.querySelector("[data-screen='settings.hub.vault']")).not.toBeNull();
  expect(host.textContent).toContain("Recovery code");
  expect(host.textContent).toContain("Rotate the key");
  expect(host.querySelector("[aria-label='Vault items']")).toBeNull();
  expect(calls.some((c) => c.tool === "vault_list")).toBe(false);
});
