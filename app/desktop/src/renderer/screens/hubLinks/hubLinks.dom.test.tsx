// @vitest-environment happy-dom
// Hub links in the app: a Navi's Linked hubs (none yet; working, can't reach and revoked there; a key pasted with its
// address, sealed in main and never in a hub call; removed), a person's Links to this hub (none yet; a key made for
// chosen projects, shown once and copied with the address; only their own even for an admin; revoked), Administration's
// list of everyone's, and a hub too old to link hubs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubLink, HubLinksGetOutput, IssuedLink } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { HubLinkRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AllLinks } from "./AllLinks";
import { LinkedHubs } from "./LinkedHubs";
import { LinksToThisHub } from "./LinksToThisHub";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const KEY = `flk_${"abcd".repeat(13)}`;
const HUB = "http://devbox:4790";
const NAVI = { machineId: "devbox", projectId: "ada" };
const SHOP = { machineId: "devbox", projectId: "shop" };
const BILLING = { machineId: "devbox", projectId: "billing" };
const ALEX = { personId: "p_aaaaaaaa", name: "Alex" };
const SAM = { personId: "p_bbbbbbbb", name: "Sam" };

const kept = (label: string, extra: Partial<HubLink> = {}): HubLink => ({
  linkId: `hl_${label.padEnd(8, "a").slice(0, 8)}`,
  navi: NAVI,
  label,
  url: `https://${label}.example`,
  state: "ok",
  createdAt: AT,
  ...extra,
});
const issued = (linkId: string, extra: Partial<IssuedLink> = {}): IssuedLink => ({
  linkId,
  label: "home",
  prefix: "flk_abcdab",
  keyId: "k1",
  device: "laptop",
  person: ALEX,
  createdAt: AT,
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: HubLinkRequest[];
let copied: string[];
let answer: HubLinksGetOutput;
let old: boolean;
/** hub_info's address for this hub; undefined: it has none another hub reaches. */
let reachable: string | undefined;
/** Holds hub_info's answer until released. */
let info: Promise<void>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  sealed = [];
  copied = [];
  old = false;
  reachable = "https://hub.devbox.example";
  info = Promise.resolve();
  answer = { links: [], issued: [], boxPubKey: BOX };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    copy: (text: string) => (copied.push(text), Promise.resolve()),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
    secret: {
      hubLink: (_hub: string, request: HubLinkRequest): Promise<CallOutcome> => {
        sealed.push(request);
        const link = kept(request.label, { url: request.url, who: "Alex" });
        answer = { ...answer, links: [...answer.links, link] };
        return Promise.resolve({ ok: true, output: { link, projects: [{ projectRef: SHOP, title: "Shop" }, { projectRef: BILLING, title: "Billing" }] } });
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

const render = async (page: React.ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (old && tool.startsWith("hub_link")) return Promise.resolve({ ok: false, error: { code: "not_found", message: `No tool ${tool}.` } });
      if (tool === "hub_info") {
        const me = { ...ALEX, role: "admin", createdAt: AT };
        return info.then(() => ({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], admin: true, me, ...(reachable === undefined ? {} : { url: reachable }) } }));
      }
      const output =
        tool === "hub_links_get"
          ? answer
          : tool === "hub_link_mint"
              ? { key: KEY, link: issued("hl_newnewne", { label: "home", ...(input as object) }) }
              : tool === "hub_link_remove"
                ? { revokedThere: false, next: "acme didn't answer, so the link still shows there until someone revokes it; it can't be used." }
                : tool === "hub_link_revoke"
                  ? { link: issued((input as { linkId: string }).linkId, { revokedAt: AT }) }
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
        <DataProvider layer={createDataLayer(hub)}>{page}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: HUB, protocol: 1 } });
    const project = (ref: typeof SHOP, title: string, kind?: string) => ({ ...ref, title, workspaceRoot: `/home/dev/${ref.projectId}`, lastActivityAt: AT, threads: { failed: 0, idle: 0, running: 0, waiting: 0 }, ...(kind ? { kind } : {}) });
    listener({
      t: "snapshot",
      snapshot: { cursor: 1, attention: [], machines: [], projects: [project(SHOP, "Shop"), project(BILLING, "Billing"), project(NAVI, "Ada", "assistant")] },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
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
const text = () => document.body.textContent;
const row = (label: string) => {
  const r = document.querySelector(`[role="listitem"][aria-label="${label}"]`);
  if (r === null) throw new Error(`no row ${label}`);
  return r;
};

describe("a Navi's Linked hubs", () => {
  it("with none yet, says so in one line with a button", async () => {
    await render(<LinkedHubs navi={NAVI} />);
    expect(calls).toContainEqual({ tool: "hub_links_get", input: { navi: NAVI } });
    expect(text()).toContain("No linked hubs yet.");
    expect(button("Link a hub")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
  });

  it("adds a link from a pasted key and address: main seals the key, and no hub call carries it", async () => {
    await render(<LinkedHubs navi={NAVI} />);
    await click(button("Link a hub"));
    const key = document.querySelector<HTMLTextAreaElement>("textarea[data-secret]");
    if (key === null) throw new Error("the key isn't a masked field");
    await type(key, `https://acme.example:4790\n${KEY}\n`);
    const [address, label] = [...document.querySelectorAll<HTMLInputElement>("form input")];
    expect(address?.value).toBe("https://acme.example:4790");
    await type(label as HTMLInputElement, "acme");
    await click(button("Link hub"));
    expect(sealed).toEqual([{ navi: NAVI, label: "acme", url: "https://acme.example:4790", boxPubKey: BOX, key: KEY }]);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(text()).toContain("Linked to acme: this Navi reaches 2 projects there.");
    expect(row("acme").textContent).toContain("Working");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("refuses a label this Navi already uses before anything is sent", async () => {
    answer = { ...answer, links: [kept("acme")] };
    await render(<LinkedHubs navi={NAVI} />);
    await click(button("Link another hub"));
    const key = document.querySelector<HTMLTextAreaElement>("textarea[data-secret]");
    await type(key as HTMLTextAreaElement, KEY);
    const [address, label] = [...document.querySelectorAll<HTMLInputElement>("form input")];
    await type(address as HTMLInputElement, "https://acme.example");
    await type(label as HTMLInputElement, "ACME");
    expect(text()).toContain("This Navi has a linked hub called that already");
    expect(button("Link hub").disabled).toBe(true);
  });

  it("lists each link with who it acts as, its projects and its state, plainly", async () => {
    answer = {
      ...answer,
      links: [
        kept("acme", { who: "Alex", projects: [{ projectRef: SHOP, title: "Shop" }] }),
        kept("personal", { url: "http://devbox:4790", state: "unreachable", error: "Can't reach personal at http://devbox:4790: connection refused." }),
        kept("oldjob", { state: "revoked", who: "Alex" }),
      ],
    };
    await render(<LinkedHubs navi={NAVI} />);
    const acme = row("acme").textContent;
    expect(acme).toContain("https://acme.example");
    expect(acme).toContain("As Alex · only Shop");
    expect(acme).toContain("Working");
    const down = row("personal").textContent;
    expect(down).toContain("Can’t reach");
    expect(down).toContain("http://devbox:4790: connection refused.");
    expect(down).toContain("over a tailnet or HTTPS");
    const gone = row("oldjob").textContent;
    expect(gone).toContain("Revoked on oldjob");
    expect(gone).toContain("As Alex · every project of theirs");
    expect(text()).not.toContain("No linked hubs yet.");
  });

  it("removes a link, saying when the other hub didn't hear of it", async () => {
    answer = { ...answer, links: [kept("acme")] };
    await render(<LinkedHubs navi={NAVI} />);
    answer = { ...answer, links: [] };
    await click(button("Remove", row("acme")));
    expect(calls).toContainEqual({ tool: "hub_link_remove", input: { linkId: "hl_acmeaaaa" } });
    expect(text()).toContain("No linked hubs yet.");
  });

  it("on a hub from before hub links, says it needs updating", async () => {
    old = true;
    await render(<LinkedHubs navi={NAVI} />);
    expect(text()).toContain("This hub needs updating to link hubs.");
    expect(button("Update the hub")).toBeTruthy();
  });
});

describe("Links to this hub, in a person's settings", () => {
  it("with none yet, says so in one line with a button", async () => {
    await render(<LinksToThisHub />);
    expect(text()).toContain("No links to this hub yet.");
    expect(button("Make a link key")).toBeTruthy();
  });

  it("makes a key for chosen projects, shows it once and copies it with the address another hub reaches", async () => {
    await render(<LinksToThisHub />);
    await click(button("Make a link key"));
    const label = document.querySelector<HTMLInputElement>("form input");
    await type(label as HTMLInputElement, "home");
    const some = [...document.querySelectorAll('[role="radio"]')].find((r) => r.getAttribute("value") === "some");
    await click(some as Element);
    // A Navi is no project to send work to.
    const boxes = [...document.querySelectorAll('[role="group"] label')].map((l) => l.textContent);
    expect(boxes).toEqual(["Billing", "Shop"]);
    expect(button("Make link key").disabled).toBe(true);
    const shop = [...document.querySelectorAll('[role="group"] label')].find((l) => l.textContent === "Shop");
    await click(shop?.querySelector('[role="checkbox"]') as Element);
    await click(button("Make link key"));
    expect(calls).toContainEqual({ tool: "hub_link_mint", input: { label: "home", projects: [SHOP] } });
    expect(text()).toContain(KEY);
    expect(text()).toContain("Shown only now");
    await click(button("Copy"));
    // The hub's own reachable address, never the one this app connects to.
    expect(copied).toEqual([`https://hub.devbox.example\n${KEY}`]);
    expect(text()).not.toContain(HUB);
  });

  it("asks for the address when the hub has none another hub reaches, and copies the key alone until then", async () => {
    reachable = undefined;
    await render(<LinksToThisHub />);
    await click(button("Make a link key"));
    await type(document.querySelector<HTMLInputElement>("form input") as HTMLInputElement, "home");
    await click(button("Make link key"));
    expect(text()).toContain("This hub has no address another hub can reach set");
    await click(button("Copy"));
    expect(copied).toEqual([KEY]);
    const address = document.querySelector<HTMLInputElement>('[aria-label="Link key for home"] input');
    await type(address as HTMLInputElement, "https://hub.home.example/");
    await click(button("Copied"));
    expect(copied[1]).toBe(`https://hub.home.example\n${KEY}`);
  });

  it("shows no one's links until the hub says who you are", async () => {
    let release: () => void = () => undefined;
    info = new Promise((r) => {
      release = r;
    });
    answer = { ...answer, issued: [issued("hl_samsaaaa", { label: "work", person: SAM })] };
    await render(<LinksToThisHub />);
    expect(document.querySelector('[role="listitem"]')).toBeNull();
    expect(text()).not.toContain("For work");
    await act(async () => {
      release();
      await Promise.resolve();
    });
    for (let i = 0; i < 3; i++) await settle();
    expect(document.querySelector('[role="listitem"]')).toBeNull();
    expect(text()).toContain("No links to this hub yet.");
  });

  it("lists only the person's own links, even for an admin, and revokes one", async () => {
    answer = { ...answer, issued: [issued("hl_mineaaaa", { label: "home", projects: [SHOP], lastUsedAt: AT }), issued("hl_samsaaaa", { label: "work", person: SAM })] };
    await render(<LinksToThisHub />);
    const rows = [...document.querySelectorAll('[role="listitem"]')];
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Link for home"]);
    expect(rows[0]?.textContent).toContain("Only Shop");
    expect(rows[0]?.textContent).toContain("Last used");
    expect(rows[0]?.textContent).not.toContain("Sam");
    await click(button("Revoke"));
    expect(calls).toContainEqual({ tool: "hub_link_revoke", input: { linkId: "hl_mineaaaa" } });
  });
});

describe("Administration's hub links", () => {
  it("lists everyone's, with the person each acts as, and revokes any", async () => {
    answer = { ...answer, issued: [issued("hl_mineaaaa"), issued("hl_samsaaaa", { label: "work", person: SAM }), issued("hl_goneaaaa", { revokedAt: AT })] };
    await render(<AllLinks />);
    const rows = [...document.querySelectorAll('[role="listitem"]')];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent).join(" ")).toContain("as Sam");
    // A revoked one stays listed, last, with nothing to press.
    expect(rows[2]?.textContent).toContain("Revoked");
    expect(rows[2]?.querySelector("button")).toBeNull();
    await click(button("Revoke", rows[0]));
    expect(calls.filter((c) => c.tool === "hub_link_revoke")).toHaveLength(1);
  });

  it("with none, says so with a way to make one", async () => {
    await render(<AllLinks />);
    expect(text()).toContain("No links to this hub yet.");
    expect(button("Make one in Settings")).toBeTruthy();
  });
});
