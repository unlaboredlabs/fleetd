// @vitest-environment happy-dom
// A fleetd cloud workspace's Sign-in page and its spend warnings and limits, as an owner sees them and as a member
// does. Sign-in: the method members must use, the domains with their state, joining by domain only once one is
// verified, and the page that adds a domain asked for on each press; none of it on a self-hosted workspace. Billing:
// a spend warning is a warning line with Raise cap, the warnings switch, and the limits set listed; a cloud from before
// them shows neither. People: each person's spend this month, and Spend limit… sets theirs. A bot's settings: its
// limit for an admin, nothing for a member. Workspaces & devices: a member's own limit, and no line without one.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BILLING_SAMPLES } from "../../../shared/billing.samples";
import { readBilling, type BillingState, type LimitOf } from "../../../shared/billing";
import type { SigninChange, SigninState } from "../../../shared/signin";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { chooseFromRow } from "../settings/rowMenu.testing";
import { Billing } from "./Billing";
import { BotLimitSetting, MyLimitLine } from "./Limits";
import { People } from "./People";
import { SigninPage } from "./Signin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-09-01T08:00:00.000Z";
const sam = { personId: "p_aaaaaaaa", name: "Sam Rivera", role: "owner" as const, createdAt: AT };
const alice = { personId: "p_bbbbbbbb", name: "Alice Chen", role: "admin" as const, createdAt: AT };
const bob = { personId: "p_cccccccc", name: "Bob Okafor", role: "member" as const, createdAt: AT };

const read = (sample: unknown): BillingState => {
  const b = readBilling(sample);
  if (b === null) throw new Error("sample doesn't read");
  return b;
};

let host: HTMLDivElement;
let root: Root;
let billing: BillingState;
let signin: SigninState;
let asked: { signin: SigninChange[]; domain: number; limits: Array<{ of: LimitOf; cents: number | null }>; warnings: boolean[]; signinReads: number };

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  billing = read(BILLING_SAMPLES.warned);
  signin = { require: "google", domainJoin: true, domains: [{ domain: "acme.com", state: "verified" }, { domain: "acme.io", state: "pending" }] };
  asked = { signin: [], domain: 0, limits: [], warnings: [], signinReads: 0 };
  (globalThis as { fleetd?: unknown }).fleetd = {
    platform: "linux",
    cloud: {
      billing: () => Promise.resolve({ ok: true, billing }),
      billingWarnings: (_hub: string, on: boolean) => {
        asked.warnings.push(on);
        if (billing.warnings !== null) billing = { ...billing, warnings: { ...billing.warnings, on } };
        return Promise.resolve({ ok: true, on });
      },
      billingLimit: (_hub: string, of: LimitOf, cents: number | null) => {
        asked.limits.push({ of, cents });
        return Promise.resolve({ ok: true, limit: { limitCents: cents, spentCents: 0, stopped: false } });
      },
      signin: () => {
        asked.signinReads++;
        return Promise.resolve({ ok: true, signin });
      },
      signinSet: (_hub: string, change: SigninChange) => {
        asked.signin.push(change);
        if (change.domainJoin === true && !signin.domains.some((d) => d.state === "verified")) {
          return Promise.resolve({ ok: false, failure: { code: "no_domain", message: "Verify an email domain first." } });
        }
        signin = { ...signin, ...change };
        return Promise.resolve({ ok: true, signin });
      },
      signinDomain: () => {
        asked.domain++;
        return Promise.resolve({ ok: true });
      },
    },
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function Scoped({ cloud, children }: { cloud: boolean; children: ReactNode }) {
  const layer = useDataLayer();
  return <HubScope hub={{ id: layer.hub, label: "acme", layer, ...(cloud ? { cloud: true as const } : {}) }}>{children}</HubScope>;
}

/** `page` on the workspace acme, as `me`; cloud unless said. */
const render = async (page: ReactNode, me: { personId: string; name: string; role: "owner" | "admin" | "member" } = sam, cloud = true) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "1", protocol: 1, busy: [], admin: me.role !== "member", me } });
      if (tool === "people_list") return Promise.resolve({ ok: true, output: { people: [sam, alice, bob], devices: [], invites: [], me: me.personId } });
      return Promise.resolve({ ok: true, output: {} });
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
          <Scoped cloud={cloud}>{page}</Scoped>
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "acme.fleetd.dev", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [], chats: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};

const button = (name: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};

const pick = async (label: string, option: string) => {
  const trigger = host.querySelector<HTMLElement>(`[role='combobox'][aria-label='${label}']`);
  if (trigger === null) throw new Error(`no picker ${label}`);
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const found = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === option);
  if (found === undefined) throw new Error(`no option ${option}`);
  await click(found);
};

const type = async (input: HTMLInputElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const toggle = (data: string) => host.querySelector<HTMLElement>(`[${data}] button[role='switch']`);

it("shows the workspace's sign-in to an owner, and changes the method and the domain join", async () => {
  await render(<SigninPage />);
  expect(host.querySelector("[data-screen='settings.hub.signin']")).not.toBeNull();
  expect(host.querySelector("[data-require='google']")).not.toBeNull();
  expect(host.textContent).toContain("Owners are let in however they sign in, so nobody gets locked out.");
  expect(host.textContent).toContain("A change applies from each person's next sign-in; anyone already signed in stays signed in.");
  expect(host.querySelector("[data-domain='verified']")?.textContent).toContain("acme.com");
  expect(host.querySelector("[data-domain='pending']")?.textContent).toContain("Waiting for its DNS record");
  expect(host.textContent).toContain("People with @acme.com join automatically");
  await pick("Sign-in method", "Any method");
  expect(asked.signin).toEqual([{ require: null }]);
  expect(host.querySelector("[data-require='any']")).not.toBeNull();
  const join = toggle("data-domain-join");
  if (join === null) throw new Error("no join switch");
  await click(join);
  expect(asked.signin).toEqual([{ require: null }, { domainJoin: false }]);
  // One Manage domains for the section, none on a domain's row.
  expect(host.querySelector("[data-domain='verified'] button")).toBeNull();
  await click(button("Manage domains"));
  expect(asked.domain).toBe(1);
});

it("keeps joining by domain off until a domain is verified, with Add domain", async () => {
  signin = { require: null, domainJoin: false, domains: [] };
  await render(<SigninPage />);
  expect(host.querySelector("[data-domain='none']")?.textContent).toContain("None yet");
  expect(host.textContent).toContain("Join by email domain");
  expect(host.textContent).toContain("Needs a verified email domain.");
  expect(toggle("data-domain-join")?.hasAttribute("disabled")).toBe(true);
  await click(button("Add domain"));
  expect(asked.domain).toBe(1);
});

it("has no Sign-in on a self-hosted workspace: its link lands on People", async () => {
  window.location.hash = "#/settings/hub/signin";
  await render(<SigninPage />, sam, false);
  expect(host.querySelector("[data-screen='settings.hub.signin']")).toBeNull();
  expect(asked.signinReads).toBe(0);
  expect(window.location.hash).toContain("hub/people");
});

it("says a spend warning as a warning, turns the warnings off, and lists the limits set", async () => {
  await render(<Billing />);
  const top = host.querySelector<HTMLElement>("[data-tone]");
  expect(top?.getAttribute("data-tone")).toBe("warning");
  expect(top?.textContent).toContain("This workspace has used 80% of its $100 spend cap this month.");
  expect(top?.textContent).toContain("Raise cap");
  expect(host.textContent).toContain("At 50%, 80% and 100% of the cap.");
  const warnings = toggle("data-warnings");
  if (warnings === null) throw new Error("no warnings switch");
  expect(warnings.getAttribute("aria-checked")).toBe("true");
  await click(warnings);
  expect(asked.warnings).toEqual([false]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-limit-row]")].map((r) => r.getAttribute("data-limit-row"));
  // Sam has no limit: only those set, people first, then bots.
  expect(rows).toEqual(["person:p_bbbbbbbb", "person:p_cccccccc", "bot:storefront"]);
  expect(host.querySelector("[data-limit-row='person:p_cccccccc']")?.textContent).toContain("Stopped");
  expect(host.querySelector("[data-limit-row='person:p_bbbbbbbb']")?.textContent).toContain("$6.80 of $25 this month");
});

it("shows neither warnings nor limits from a cloud before them", async () => {
  billing = { ...read(BILLING_SAMPLES.plan), warnings: null, limits: null };
  await render(<Billing />);
  expect(host.textContent).toContain("Monthly cap");
  expect(toggle("data-warnings")).toBeNull();
  expect(host.textContent).not.toContain("Spend limits");
});

it("says each person's spend on People, and sets a limit from their row", async () => {
  window.location.hash = "#/settings/hub/people";
  await render(<People me={sam} />);
  expect(host.querySelector("[data-spend='none']")?.textContent).toContain("spent $14.40 this month");
  expect(host.querySelector("[data-spend='2500']")?.textContent).toContain("spent $6.80 of $25 this month");
  expect(host.textContent).toContain("Reached their spend limit.");
  await chooseFromRow("Alice Chen", "Spend limit…");
  await settle();
  const field = document.querySelector<HTMLInputElement>("input[aria-label='Monthly limit']");
  if (field === null) throw new Error("no limit field");
  expect(field.value).toBe("25");
  await type(field, "40");
  await click(button("Save"));
  expect(asked.limits).toEqual([{ of: { personId: "p_bbbbbbbb" }, cents: 40_00 }]);
  await chooseFromRow("Bob Okafor", "Spend limit…");
  await settle();
  await click(button("Remove limit"));
  expect(asked.limits[1]).toEqual({ of: { personId: "p_cccccccc" }, cents: null });
});

it("has no spend on a self-hosted workspace's People", async () => {
  window.location.hash = "#/settings/hub/people";
  await render(<People me={sam} />, sam, false);
  expect(host.querySelector("[data-spend]")).toBeNull();
});

it("gives an admin a bot's limit in its settings, and a member nothing", async () => {
  await render(<BotLimitSetting projectId="storefront" administers />);
  const row = host.querySelector<HTMLElement>("[data-limit='4000']");
  expect(row?.textContent).toContain("$18.70 of $40 this month");
  const field = row?.querySelector<HTMLInputElement>("input");
  if (field === undefined || field === null) throw new Error("no limit field");
  await type(field, "60");
  await click(button("Save"));
  expect(asked.limits).toEqual([{ of: { projectId: "storefront" }, cents: 60_00 }]);
  act(() => root.unmount());
  root = createRoot(host);
  await render(<BotLimitSetting projectId="storefront" administers={false} />, bob);
  expect(host.querySelector("[data-limit]")).toBeNull();
  // A bot on the workspace's own machines has no limit to set.
  act(() => root.unmount());
  root = createRoot(host);
  await render(<BotLimitSetting projectId="laptop-bot" administers />);
  expect(host.querySelector("[data-limit]")).toBeNull();
});

it("tells a member their own limit, and nothing without one", async () => {
  billing = { ...read(BILLING_SAMPLES.plan), canBuy: false, limits: { members: [{ personId: bob.personId, name: bob.name, limitCents: 10_00, spentCents: 10_00, stopped: true }], bots: [] } };
  await render(<MyLimitLine personId={bob.personId} />, bob);
  expect(host.textContent).toBe(
    "You reached your spend limit: $10 of $10 this month. Your work on fleetd's computers is stopped until next month, or until an admin raises it.",
  );
  act(() => root.unmount());
  root = createRoot(host);
  billing = { ...billing, limits: { members: [{ personId: bob.personId, name: bob.name, limitCents: null, spentCents: 3_00, stopped: false }], bots: [] } };
  await render(<MyLimitLine personId={bob.personId} />, bob);
  expect(host.textContent).toBe("");
});
