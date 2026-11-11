// @vitest-environment happy-dom
// Settings › You › Hubs & devices, at Your devices (its old link opens there): only your own devices; Pair a phone mints a code with the address this app reaches the
// hub at, shows its link as a QR with the address and code as text and how long it lasts, and notices the phone once
// it has paired (key.paired); a hub only on loopback is refused with its fix, and an expired code offers a new one.
// Each device but this one signs out once confirmed (device_revoke), and leaves the list; the confirm says how many hub
// links made on it go with it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentKeyInfo, IssuedLink, PeopleListOutput, Person } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SettingsScreen } from "./SettingsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";
const person = (personId: string, name: string): Person => ({ personId, name, role: "owner", createdAt: AT });
const sam = person("p_aaaaaaaa", "Sam Rivera");
const alice = person("p_bbbbbbbb", "Alice Chen");
const device = (keyId: string, name: string, p: Person): AgentKeyInfo => ({
  keyId,
  name,
  prefix: keyId,
  kind: "human",
  grants: [{ role: "admin", machines: "*" }],
  createdAt: AT,
  person: { personId: p.personId, name: p.name },
});
const link = (linkId: string, keyId: string, revoked = false): IssuedLink => ({
  linkId,
  keyId,
  device: keyId,
  label: "home",
  prefix: "flk_abcdef",
  createdAt: AT,
  ...(revoked ? { revokedAt: AT } : {}),
});
const LINK = "fleetd://pair?hub=http%3A%2F%2Fdevbox.tail1234.ts.net%3A4790&code=ABCD-2345";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let people: PeopleListOutput;
let issued: IssuedLink[];
let pairCode: () => CallOutcome;
let send: (frame: HubFrame) => void;

beforeEach(() => {
  calls = [];
  issued = [];
  people = { people: [sam, alice], devices: [device("k1", "MacBook", sam), device("k2", "ThinkPad", alice)], invites: [], me: sam.personId };
  pairCode = () => ({
    ok: true,
    output: { code: "ABCD-2345", link: LINK, hubUrl: "http://devbox.tail1234.ts.net:4790", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
  });
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
    pair: { store: () => new Promise(() => undefined) },
  });
  window.location.hash = "#/settings/devices";
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

/** Settings › Hubs & devices, connected to a hub this app reaches at `appUrl`. */
const render = async (appUrl = "http://devbox.tail1234.ts.net:4790") => {
  send = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "people_list") return Promise.resolve({ ok: true, output: people });
      if (tool === "pair_code_create") return Promise.resolve(pairCode());
      if (tool === "hub_links_get") return Promise.resolve({ ok: true, output: { links: [], issued, boxPubKey: "box" } });
      if (tool === "device_revoke") {
        const keyId = (input as { keyId: string }).keyId;
        const gone = people.devices.find((d) => d.keyId === keyId);
        if (gone === undefined) return Promise.resolve({ ok: false, error: { code: "not_found", message: `No device ${keyId}.` } });
        people = { ...people, devices: people.devices.filter((d) => d !== gone) };
        return Promise.resolve({ ok: true, output: { device: { ...gone, revokedAt: AT } } });
      }
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], me: sam, admin: true } });
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
          <SettingsScreen />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: appUrl, protocol: 1 } });
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const button = (text: string, within: ParentNode = host) => {
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
const rows = () => [...host.querySelectorAll("[role='list'][aria-label='Your devices'] [role='listitem']")].map((r) => r.getAttribute("aria-label"));
const row = (name: string) => {
  const el = host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}']`);
  if (el === null) throw new Error(`no row ${name}`);
  return el;
};
const panel = () => host.querySelector<HTMLElement>("section[aria-label='Pair a phone']");
const qr = () => panel()?.querySelector("svg[aria-label='Pairing QR code']") ?? null;
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);

it("lists only your own devices", async () => {
  await render();
  expect(rows()).toEqual(["MacBook"]);
  // The old page's link lands on its part of Hubs & devices, under its own heading; with one hub, no intro.
  expect(host.querySelector("[data-screen='settings.hubs'] [data-screen='settings.devices'] section[aria-label='Your devices'] h2")?.textContent).toBe("Your devices");
  expect(document.activeElement?.getAttribute("data-screen")).toBe("settings.devices");
  expect(host.textContent).not.toContain("Each of these acts as you");
});

it("pairs a phone by QR, shows the address and code to type and how long it lasts, then notices the phone", async () => {
  await render();
  await click(button("Pair a phone"));
  expect(sent("pair_code_create")).toEqual([{ hubUrl: "http://devbox.tail1234.ts.net:4790" }]);
  expect(qr()?.getAttribute("data-link")).toBe(LINK);
  expect(qr()?.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  const text = panel()?.textContent ?? "";
  expect(text).toContain("http://devbox.tail1234.ts.net:4790");
  expect(text).toContain("ABCD-2345");
  expect(text).toMatch(/Works once, for 15 more minutes \(until \d\d:\d\d\)\./);

  // The phone trades the code: the hub records key.paired, and the view reads the devices again.
  people = { ...people, devices: [...people.devices, device("k3", "iPhone", sam)] };
  const reads = sent("people_list").length;
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: AT, type: "key.paired", summary: "iPhone paired with the hub", data: { keyId: "k3", deviceName: "iPhone" } } });
    await new Promise((r) => setTimeout(r, 300));
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(sent("people_list").length).toBeGreaterThan(reads);
  expect(qr()).toBeNull();
  expect(panel()?.querySelector("[role='status']")?.textContent).toBe("iPhone paired. It acts as you on this hub now.");
  expect(rows()).toEqual(["MacBook", "iPhone"]);
  expect(host.querySelector("[role='listitem'][aria-label='iPhone']")?.textContent).toContain("just paired");
  await click(button("Done"));
  expect(panel()).toBeNull();
});

it("says a hub only on loopback can't pair a phone, and how to give it an address, with no QR", async () => {
  pairCode = () => ({
    ok: false,
    error: {
      code: "failed",
      message: "The hub is only at http://127.0.0.1:4790, which a phone can't reach.",
      fix: "Give the hub an address your phone reaches, its tailnet or LAN address: on the hub, run `fleetd init --listen <ip>:<port> --url http://<name>:<port>`.",
    },
  });
  await render("http://127.0.0.1:4790");
  await click(button("Pair a phone"));
  expect(sent("pair_code_create")).toEqual([{ hubUrl: "http://127.0.0.1:4790" }]);
  expect(qr()).toBeNull();
  const alert = panel()?.querySelector("[role='alert']");
  expect(alert?.textContent).toContain("which a phone can't reach");
  expect(alert?.querySelector("code")?.textContent).toBe("fleetd init --listen <ip>:<port> --url http://<name>:<port>");
});

it("offers a new code once the code has expired, and shows no QR for it", async () => {
  const live = pairCode;
  pairCode = () => ({ ok: true, output: { code: "ZZZZ-9999", link: "fleetd://pair?hub=x&code=ZZZZ-9999", hubUrl: "http://devbox:4790", expiresAt: new Date(Date.now() - 1000).toISOString() } });
  await render();
  await click(button("Pair a phone"));
  expect(qr()).toBeNull();
  expect(panel()?.textContent).toContain("This code expired, unused.");
  pairCode = live;
  await click(button("New code"));
  expect(sent("pair_code_create")).toHaveLength(2);
  expect(qr()?.getAttribute("data-link")).toBe(LINK);
});

it("signs out another device once confirmed, never this one", async () => {
  people = { ...people, devices: [...people.devices, device("k3", "iPhone", sam)], thisDevice: "k1" };
  await render();
  expect(rows()).toEqual(["MacBook", "iPhone"]);
  expect(row("MacBook").textContent).toContain("this computer");
  expect(() => button("Sign out", row("MacBook"))).toThrow();

  // Cancel sends nothing.
  await click(button("Sign out", row("iPhone")));
  expect(document.body.textContent).toContain("It stops working on this hub at once. To use it again, pair it again.");
  await click(button("Cancel", document));
  expect(sent("device_revoke")).toEqual([]);
  expect(rows()).toEqual(["MacBook", "iPhone"]);

  await click(button("Sign out", row("iPhone")));
  await click(button("Sign out iPhone", document));
  expect(sent("device_revoke")).toEqual([{ keyId: "k3" }]);
  for (let i = 0; i < 3; i++) await settle();
  expect(rows()).toEqual(["MacBook"]);
});

it("says the hub links made on a device go with it", async () => {
  people = { ...people, devices: [...people.devices, device("k3", "iPhone", sam)], thisDevice: "k1" };
  issued = [link("l1", "k3"), link("l2", "k3"), link("l3", "k3", true), link("l4", "k1")];
  await render();
  await click(button("Sign out", row("iPhone")));
  for (let i = 0; i < 3; i++) await settle();
  expect(document.body.textContent).toContain("It also removes the 2 hub links made on it.");
});

it("offers no sign-out on a hub that doesn't say which device this is", async () => {
  people = { ...people, devices: [...people.devices, device("k3", "iPhone", sam)] };
  await render();
  expect(rows()).toEqual(["MacBook", "iPhone"]);
  expect(() => button("Sign out", row("iPhone"))).toThrow();
});
