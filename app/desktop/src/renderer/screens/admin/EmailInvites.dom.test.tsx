// @vitest-environment happy-dom
// People on a fleetd cloud team: an owner or admin invites by email (the plus), a sent invite says the person gets an
// email and signs in with it, a refusal is one line by the field in the team's words, and who is invited is listed with
// Revoke. A member reaches no People page, and the team is never asked. A self-hosted hub's People is today's: the
// invite link, nothing of email, and the cloud never asked. The page's calls go to main as the preload sends them
// (window.fleetd.cloud); main's side against the stand-in team is src/main/cloud/invites.test.ts.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InviteRequest } from "../../../shared/cloud";
import type { AccountsInvite, HubInfoOutput, PeopleListOutput, Person } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { PairFailure } from "../../../shared/pairing";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, HubScope, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SettingsScreen } from "../settings/SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const person = (personId: string, name: string, role: Person["role"]): Person => ({ personId, name, role, createdAt: AT });
const sam = person("p_aaaaaaaa", "Sam Rivera", "owner");
const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
const bob = person("p_cccccccc", "Bob Okafor", "member");
const people: PeopleListOutput = { people: [sam, alice, bob], devices: [], invites: [], me: sam.personId };
const dayAhead = () => new Date(Date.now() + 6.5 * 86_400_000).toISOString();

let host: HTMLDivElement;
let root: Root;
/** What the page asked main for, in order. */
let asked: string[];
/** The team's open invites, as the stand-in keeps them. */
let invites: AccountsInvite[];
/** The team's answer to the next invite instead of making one. */
let refuse: PairFailure | null;
/** The team's answer to the next revoke: the invite was used or gone meanwhile. */
let gone: boolean;
/** Sends the page a frame from the hub. */
let send: (frame: HubFrame) => void;

beforeEach(() => {
  asked = [];
  invites = [{ inviteId: "inv_aaaaaaaaaa", email: "dana@example.com", role: "member", createdAt: AT, expiresAt: dayAhead() }];
  refuse = null;
  gone = false;
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
    cloud: {
      invites: (hub: string) => {
        asked.push(`invites ${hub}`);
        return Promise.resolve({ ok: true, invites: [...invites] });
      },
      invite: (hub: string, request: InviteRequest) => {
        asked.push(`invite ${hub} ${request.email} ${request.role}`);
        if (refuse !== null) return Promise.resolve({ ok: false, failure: refuse });
        const invite = { inviteId: "inv_bbbbbbbbbb", email: request.email.toLowerCase(), role: request.role, createdAt: AT, expiresAt: dayAhead() };
        invites = [invite, ...invites];
        return Promise.resolve({ ok: true, invite });
      },
      revokeInvite: (hub: string, inviteId: string) => {
        asked.push(`revoke ${hub} ${inviteId}`);
        invites = invites.filter((i) => i.inviteId !== inviteId);
        if (gone) return Promise.resolve({ ok: false, failure: { code: "not_found", message: `No open invite ${inviteId}.`, fix: "List the open invites to see which are left." } });
        return Promise.resolve({ ok: true });
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = "#/settings/hub/people";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** The one hub, a cloud team's (`cloud`) or a self-hosted one, as `me`. */
function Team({ cloud }: { cloud: boolean }) {
  const layer = useDataLayer();
  return (
    <HubScope hub={{ id: layer.hub, label: "acme", layer, ...(cloud ? { cloud: true as const } : {}) }}>
      <SettingsScreen />
    </HubScope>
  );
}

const render = async (me: Person, cloud: boolean, list: () => PeopleListOutput = () => people) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  send = (frame) => listener(frame);
  const info: Partial<HubInfoOutput> = { me, admin: me.role !== "member" };
  const hub: HubApi = {
    call: (tool) =>
      Promise.resolve({
        ok: true,
        output:
          tool === "hub_info"
            ? { version: "0.0.0", protocol: 1, busy: [], ...info }
            : tool === "people_list"
              ? list()
              : tool === "hub_links_get"
                ? { links: [], issued: [], boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }
                : tool === "setup_list"
                  ? { steps: [], requiredLeft: 0 }
                  : {},
      }),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Team cloud={cloud} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "https://acme.fleetd.dev", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 4; i++) await settle();
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const has = (text: string) => [...host.querySelectorAll("button")].some((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};
const row = (name: string) => host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}']`);
const type = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>("form[aria-label='Invite by email'] input[type='email']");
  if (input === null) throw new Error("no email field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const line = (role: "alert" | "status") => host.querySelector(`form[aria-label='Invite by email'] [role='${role}']`)?.textContent;

it("lets a cloud team's owner invite by email, says what happens next, and revoke from the list", async () => {
  await render(sam, true);
  expect(asked).toEqual(["invites hub"]);
  expect(row("dana@example.com")?.textContent).toContain("Expires in 6 days.");
  expect(row("dana@example.com")?.textContent).toContain("Member");
  // The plus invites by email; the invite link isn't offered on a cloud team.
  expect(has("Invite someone")).toBe(false);
  await click(button("Invite by email"));
  expect(host.querySelector("form[aria-label='Invite someone']")).toBeNull();

  // Nothing typed: one line by the field, and nothing sent.
  await click(button("Invite"));
  expect(line("alert")).toBe("Type the person's email.");
  expect(asked.filter((a) => a.startsWith("invite "))).toEqual([]);

  await type(" Eve@Example.com ");
  const adminRole = host.querySelector<HTMLElement>("form [role='radio'][value='admin']");
  if (adminRole === null) throw new Error("no Admin role");
  await click(adminRole);
  await click(button("Invite"));
  expect(asked).toContain("invite hub Eve@Example.com admin");
  expect(line("status")).toBe("Invite sent to eve@example.com. They get an email, and join by signing in with it.");
  expect(line("alert")).toBeUndefined();
  expect(row("eve@example.com")?.textContent).toContain("Admin");

  await click(button("Revoke", row("dana@example.com") ?? document));
  expect(asked).toContain("revoke hub inv_aaaaaaaaaa");
  expect(row("dana@example.com")).toBeNull();
  expect(row("eve@example.com")).not.toBeNull();
});

it("drops an invite from the list when its person joins while the page is open, and after a revoke the team refused", async () => {
  invites = [...invites, { inviteId: "inv_cccccccccc", email: "kai@example.com", role: "member", createdAt: AT, expiresAt: dayAhead() }];
  let list = people;
  await render(sam, true, () => list);
  expect(row("dana@example.com")).not.toBeNull();
  // Dana signs in with that email on her own computer: the team takes her invite as used and tells every app.
  const dana = person("p_dddddddd", "Dana Ito", "member");
  invites = invites.filter((i) => i.email !== "dana@example.com");
  list = { ...people, people: [...people.people, dana] };
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: AT, type: "people.changed", summary: "Dana Ito joined", data: { change: "joined" } } });
    // The layer gathers events a moment before reading again.
    await new Promise((r) => setTimeout(r, 300));
  });
  for (let i = 0; i < 4; i++) await settle();
  expect(row("Dana Ito")).not.toBeNull();
  expect(row("dana@example.com")).toBeNull();
  // Kai's invite was used or ran out meanwhile: the team refuses the revoke, and the list is read again.
  gone = true;
  await click(button("Revoke", row("kai@example.com") ?? document));
  expect(asked).toContain("revoke hub inv_cccccccccc");
  expect(row("kai@example.com")).toBeNull();
});

it("shows each refusal as one line by the field, in the team's words", async () => {
  await render(sam, true);
  await click(button("Invite by email"));
  for (const failure of [
    { code: "invalid", message: "That isn't an email address.", fix: "Type the person's email." },
    { code: "already_member", message: "bob@acme.example is on this team already." },
    { code: "already_invited", message: "dana@example.com is invited already.", fix: "Revoke that invite first to send a new one." },
    { code: "failed", message: "This team has reached its limit of people (50).", fix: "Remove one first, or ask fleetd's operator for a higher limit." },
    { code: "forbidden", message: "Only an owner or admin invites people.", fix: "Ask an owner or admin of this team." },
  ]) {
    refuse = failure;
    await type("someone@example.com");
    await click(button("Invite"));
    expect(line("alert")).toBe(failure.fix === undefined ? failure.message : `${failure.message} ${failure.fix}`);
    expect(host.querySelectorAll("form[aria-label='Invite by email'] [role='alert']")).toHaveLength(1);
  }
  // Typing again clears the refusal.
  await type("someone@example.co");
  expect(line("alert")).toBeUndefined();
  expect(row("someone@example.com")).toBeNull();
});

it("offers an admin the same", async () => {
  await render(alice, true);
  expect(has("Invite by email")).toBe(true);
  expect(row("dana@example.com")).not.toBeNull();
});

it("shows a member of a cloud team neither the field nor the invites, and never asks the team", async () => {
  await render(bob, true);
  expect(host.querySelector("[data-screen='settings.hub.denied']")).not.toBeNull();
  expect(has("Invite by email")).toBe(false);
  expect(row("dana@example.com")).toBeNull();
  expect(asked).toEqual([]);
});

it("leaves a self-hosted hub's People as it is: the invite link, nothing of email, the cloud never asked", async () => {
  await render(sam, false);
  expect(has("Invite by email")).toBe(false);
  await click(button("Invite someone"));
  expect(host.querySelector("form[aria-label='Invite someone']")).not.toBeNull();
  expect(has("Create invite link")).toBe(true);
  expect(host.querySelector("form[aria-label='Invite by email']")).toBeNull();
  expect(host.textContent).not.toContain("Invited by email");
  expect(asked).toEqual([]);
});
