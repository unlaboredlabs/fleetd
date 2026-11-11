// @vitest-environment happy-dom
// Settings › Vault: its rows show only on a hub that serves it; yours lists your items and the hub's, a project's its
// own; an item's fields are dots until Show, which goes through main (Touch ID there), and hide again when the window
// loses focus; Copy goes through main too, so the page never holds a copied value; Add sends the typed fields to main
// to seal, never to the hub.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultItemSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { VaultCopyRequest, VaultRevealRequest, VaultSaveRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { PaymentsSetting } from "./Payments";
import { ShareDialog } from "./VaultItem";
import { SettingsScreen, SettingsSidebar } from "./SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const CANARY = "canary-7Qx-not-a-real-secret";
const AT = "2026-11-09T10:00:00.000Z";
const base = { canEdit: true, canReveal: true, createdMs: 0, updatedMs: 0, updatedBy: "human:laptop", version: 1 };
const amazon: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000001", kind: "login", scope: "person", label: "Amazon", meta: { source: { kind: "typed" }, sites: ["amazon.com"], fields: ["username", "password"] } };
const teamCard: VaultItemSummary = { ...base, canEdit: false, canReveal: false, itemId: "V00000000000000000000000000000002", kind: "card", scope: "hub", label: "Team Visa", meta: { source: { kind: "typed" }, brand: "visa", last4: "4242" } };
const stripe: VaultItemSummary = { ...base, itemId: "V00000000000000000000000000000003", kind: "env", scope: "project", machineId: "devbox", projectId: "shop", label: "STRIPE_KEY", envName: "STRIPE_KEY", meta: { source: { kind: "typed" }, secret: true, fingerprint: "ab12cd34", bytes: 20 } };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let saves: VaultSaveRequest[];
let reveals: VaultRevealRequest[];
let copies: VaultCopyRequest[];
let card: { ref: string; label?: string; brand?: string; last4?: string } | undefined;

beforeEach(() => {
  calls = [];
  saves = [];
  reveals = [];
  copies = [];
  card = undefined;
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

const render = async (hash: string, features: string[] = ["vault"], page?: ReactNode, snapshot = true) => {
  window.location.hash = hash;
  let send: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const i = input as { machineId?: string; kind?: string };
      if (tool === "vault_list") {
        const all = i.machineId === undefined ? [amazon, teamCard, stripe] : [stripe, amazon, teamCard];
        return Promise.resolve({ ok: true, output: { items: all.filter((x) => i.kind === undefined || x.kind === i.kind) } });
      }
      if (tool === "vault_get") {
        const id = (input as { itemId: string }).itemId;
        const item = [amazon, teamCard, stripe].find((x) => x.itemId === id);
        return Promise.resolve({ ok: true, output: { item, activity: [{ n: 4, atMs: Date.parse(AT), action: "fill", outcome: "ok", data: { site: "amazon.com", fields: ["password"] } }] } });
      }
      if (tool === "vault_status") return Promise.resolve({ ok: true, output: { hubBoxKey: "k", keyMode: "file", locked: false, keyMissing: false, recoverySaved: true, migration: { done: true, machines: [] } } });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], admin: false } });
      if (tool === "project_settings_get")
        return Promise.resolve({ ok: true, output: { settings: { machineId: "devbox", projectId: "shop", title: "Shop", workspaceRoot: "/w/shop", setup: { commands: [], inputs: [] }, env: [{ name: "STRIPE_KEY", kind: "secret", fingerprint: "ab12cd34", bytes: 20, updatedAt: AT }], worktrees: { dir: "/w/wt", baseBranch: "main", worktrees: [] } } } });
      if (tool === "navi_purchases") return Promise.resolve({ ok: true, output: { purchases: [], ...(card === undefined ? {} : { card }) } });
      if (tool === "navi_card_set") {
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

it("lists yours and the hub's, with the hub's tagged Everyone, and the project's on its own tab", async () => {
  await render("#/settings/vault");
  expect(rows()).toEqual(["Amazonamazon.com", "Team VisaEveryoneVisa ••4242"]);
  act(() => root.unmount());
  root = createRoot(host);
  await render("#/settings/project-vault?for=devbox/shop");
  expect(rows()).toEqual(["STRIPE_KEYShopSecret"]);
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

it("says why a hub item can't be shown or changed here, instead of greying it out", async () => {
  await render("#/settings/vault");
  await openRow("Team Visa");
  expect(panel()?.textContent).toContain("Only owners and admins can show it. Agents still fill it.");
  expect(panel()?.textContent).toContain("Only the hub's owners and admins change it.");
  expect([...(panel()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).not.toContain("Show");
});

it("adds a login by handing its typed fields to main to seal, never to the hub", async () => {
  await render("#/settings/vault");
  const plus = button("Add to the vault");
  await act(async () => {
    plus.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const login = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((m) => m.textContent === "Login");
  if (login === undefined) throw new Error("no Login item");
  await click(login);
  await type(fieldByLabel("Websites"), "https://www.github.com/login");
  await type(fieldByLabel("User name"), "sam");
  await type(fieldByLabel("Password"), CANARY);
  await click(button("Add"));
  expect(saves).toEqual([{ kind: "login", scope: "person", label: "github.com", sites: ["github.com"], fields: { username: "sam", password: CANARY } }]);
  expect(JSON.stringify(calls)).not.toContain(CANARY);
});


it("names a picked vault card the list doesn't have by its label, never its raw vault: id", async () => {
  card = { ref: "vault:V00000000000000000000000000000077", label: "Old Visa", brand: "visa", last4: "1111" };
  await render("#/settings/projects?for=devbox/shop", ["vault"], <PaymentsSetting projectRef={{ machineId: "devbox", projectId: "shop" }} />);
  expect(host.textContent).toContain("Pays with Old Visa");
  await click(button("Change…"));
  const picker = host.querySelector<HTMLElement>("[role='combobox']");
  expect(picker?.textContent).toContain("Old Visa");
  expect(host.textContent).not.toContain("vault:V");
});

it("picks the project's card from the vault cards its work can use, kept as vault:<id>", async () => {
  await render("#/settings/projects?for=devbox/shop", ["vault"], <PaymentsSetting projectRef={{ machineId: "devbox", projectId: "shop" }} />);
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
  expect(options.map((o) => o.textContent)).toEqual(["Team Visa · Visa ••4242 · Everyone", "No card"]);
  const team = options[0];
  if (team === undefined) throw new Error("no option");
  await click(team);
  expect(calls.filter((c) => c.tool === "navi_card_set").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "shop", card: `vault:${teamCard.itemId}` }]);
  expect(host.textContent).toContain("Pays with Team Visa");
});

it("keeps Save off in Use in until the projects are in, so no share is dropped", async () => {
  const shared = { ...amazon, sharedWith: [{ machineId: "devbox", projectId: "shop" }] };
  await render("#/settings/vault", ["vault"], <ShareDialog item={shared} onClose={() => undefined} />, false);
  const dialog = document.querySelector<HTMLElement>("[role='dialog']");
  expect(dialog?.textContent).toContain("Loading your projects… Save waits for them, so no share is dropped.");
  const save = button("Save", dialog ?? document.body);
  expect(save.disabled).toBe(true);
  await click(save);
  expect(calls.some((c) => c.tool === "vault_share_set")).toBe(false);
});
