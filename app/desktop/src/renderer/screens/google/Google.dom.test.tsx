// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccount, GoogleClient, GooglePubsub, MailMode } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { GoogleClientRequest, GoogleConnectRequest, GooglePubsubRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { IntegrationsSection } from "../settings/Integrations";
import { AdminGoogle } from "./AdminGoogle";
import { SCOPES } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const SECRET = "GOCSPX-never_in_a_hub_call_0123";
const CLIENT_ID = "418559210337-q8fj2v0c.apps.googleusercontent.com";
const ref = { machineId: "devbox", projectId: "ada" };

const machine = (machineId: string) => ({ machineId, name: machineId, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [], boxPubKey: BOX });
const snapshot: HubFrame = { t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [machine("devbox"), machine("buildbox")], projects: [] } };

const held = (...machines: string[]): GoogleClient => ({ clientId: CLIENT_ID, sealedOn: machines.map((machineId) => ({ machineId, fingerprint: "9c41e0b2" })), updatedAt: AT });
const account = (patch: Partial<GoogleAccount> = {}): GoogleAccount => ({ projectRef: ref, email: "sam@example.com", scopes: [...SCOPES], connectedAt: AT, ...patch });

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let client: GoogleClient | undefined;
let linked: GoogleAccount | undefined;
let admin: boolean;
let getError: CallOutcome | undefined;
let check: { ok: boolean; problem?: string };
let sealedRequests: GoogleClientRequest[];
let connects: GoogleConnectRequest[];
let connectAnswer: CallOutcome;
let cancelled: number;
let hang: boolean;
let pubsub: GooglePubsub | undefined;
let mailMode: MailMode;
let mailProblem: string | undefined;
let pubsubRequests: GooglePubsubRequest[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  client = undefined;
  linked = undefined;
  admin = false;
  getError = undefined;
  check = { ok: true };
  sealedRequests = [];
  connects = [];
  cancelled = 0;
  hang = false;
  pubsub = undefined;
  mailMode = "polling";
  mailProblem = undefined;
  pubsubRequests = [];
  connectAnswer = { ok: true, output: { account: account(), next: "The Navi gets its Google tools from its next start." } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    openExternal: () => Promise.resolve({ ok: true }),
    secret: {
      googleClient: (_hub: string, request: GoogleClientRequest): Promise<CallOutcome> => {
        sealedRequests.push(request);
        client = held(...request.boxes.map((b) => b.machineId));
        return Promise.resolve({ ok: true, output: { client } });
      },
      googlePubsub: (_hub: string, request: GooglePubsubRequest): Promise<CallOutcome> => {
        pubsubRequests.push(request);
        pubsub = { topic: request.topic, subscription: request.subscription, machineId: request.machineId, fingerprint: "71d03a5e" };
        return Promise.resolve({ ok: true, output: { client: { ...client, pubsub }, next: "Navis whose mail wakes them start watching their inbox within a minute." } });
      },
    },
    google: {
      connect: (_hub: string, request: GoogleConnectRequest): Promise<CallOutcome> => {
        connects.push(request);
        // Still on Google's page.
        if (hang) return new Promise<CallOutcome>(() => undefined);
        if (connectAnswer.ok) linked = account();
        return Promise.resolve(connectAnswer);
      },
      cancel: () => {
        cancelled += 1;
        return Promise.resolve();
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

const answer = (tool: string, input: unknown): CallOutcome => {
  switch (tool) {
    case "hub_info":
      return { ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin, me: { personId: "p_aaaaaaaa", name: "Sam", role: admin ? "owner" : "member", createdAt: AT } } };
    case "google_get":
      if (getError !== undefined) return getError;
      return {
        ok: true,
        output: {
          ...(client === undefined ? {} : { client: { ...client, ...(pubsub === undefined ? {} : { pubsub }) } }),
          mailMode,
          ...(mailProblem === undefined ? {} : { mailProblem }),
          ...((input as { project?: unknown }).project === undefined || linked === undefined ? {} : { account: linked }),
          scopes: [...SCOPES],
          redirect: "http://127.0.0.1",
        },
      };
    case "google_client_test":
      return { ok: true, output: { machineId: "devbox", check } };
    case "google_pubsub_set":
      pubsub = undefined;
      return { ok: true, output: { client, next: "The hub checks the mail of each Navi whose mail wakes it about every minute." } };
    case "google_mail_set": {
      const set = input as { rule: "off" | "all" | "query"; query?: string };
      if (linked !== undefined) linked = { ...linked, mail: { rule: set.rule, ...(set.query === undefined ? {} : { query: set.query }) } };
      return { ok: true, output: { account: linked, next: set.rule === "off" ? "New mail no longer wakes the Navi." : "New mail matching the query wakes the Navi." } };
    }
    case "google_disconnect":
      linked = undefined;
      return { ok: true, output: { revoked: true, next: "Google revoked the Navi's access. It goes without its Google tools from its next start." } };
    case "mcp_servers_get":
      return { ok: true, output: { global: [], project: [], userServers: true } };
    default:
      return { ok: true, output: {} };
  }
};

const render = async (node: ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input));
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>{node}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${within.textContent ?? ""}`);
  return b;
};
const hasButton = (text: string, within: ParentNode = document) => [...within.querySelectorAll("button")].some((x) => x.textContent.trim() === text);
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};
const type = async (label: string, value: string) => {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (field === null) throw new Error(`no field ${label}`);
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const dialog = () => {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  if (d === null) throw new Error("no dialog");
  return d;
};
const google = () => {
  const r = document.querySelector<HTMLElement>('[role="listitem"][aria-label="Google"]');
  if (r === null) throw new Error(`no Google row in: ${document.body.textContent}`);
  return r;
};
const region = (name: string) => {
  const r = document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  if (r === null) throw new Error(`no ${name}`);
  return r;
};

describe("Administration › Google", () => {
  it("without a client: the steps with the exact redirect and scopes, then the form", async () => {
    await render(<AdminGoogle />);
    expect(region("OAuth client").textContent).toContain("No client yet");
    const guide = region("Set up the client").textContent;
    expect(guide).toContain("Desktop app");
    expect(guide).toContain("Redirect URIhttp://127.0.0.1");
    for (const scope of SCOPES) expect(guide).toContain(scope);
    expect(guide).toContain("Publish app");
    expect(button("Save and test").disabled).toBe(true);
  });

  it("seals the secret through main, never a hub call, then tests the client", async () => {
    await render(<AdminGoogle />);
    await type("Client ID", "GOCSPX-oops");
    expect(document.body.textContent).toContain("A Client ID ends in .apps.googleusercontent.com.");
    await type("Client ID", CLIENT_ID);
    await type("Client secret", SECRET);
    await click(button("Save and test"));
    expect(sealedRequests).toEqual([
      {
        clientId: CLIENT_ID,
        secret: SECRET,
        boxes: [
          { machineId: "buildbox", boxPubKey: BOX },
          { machineId: "devbox", boxPubKey: BOX },
        ],
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(calls.map((c) => c.tool)).toContain("google_client_test");
    expect(document.body.textContent).toContain("Google knows this client and its secret. Tested on devbox.");
  });

  it("with a client: who holds it, a machine that doesn't, and Test's answer either way", async () => {
    client = held("devbox");
    await render(<AdminGoogle />);
    const status = region("OAuth client");
    expect(status.textContent).toContain(CLIENT_ID);
    expect(status.textContent).toContain("Secret sealed on devbox.");
    expect(status.textContent).toContain("buildbox doesn't hold the secret");
    // The form to save it again is open for it.
    expect(document.querySelector("details")?.open).toBe(true);
    await click(button("Test", status));
    expect(status.querySelector('[role="status"]')?.textContent).toContain("Google knows this client and its secret.");
    check = { ok: false, problem: "Google doesn't know this client (invalid_client)." };
    await click(button("Test", status));
    expect(status.querySelector('[role="alert"]')?.textContent).toContain("invalid_client");
  });

  it("folds the steps away once every machine holds the client", async () => {
    client = held("buildbox", "devbox");
    await render(<AdminGoogle />);
    expect(document.querySelector("details")?.open).toBe(false);
    expect(region("OAuth client").textContent).not.toContain("doesn't hold");
  });
});

describe("a Navi's Google", () => {
  it("without a client, tells a member to ask an admin", async () => {
    await render(<IntegrationsSection projectRef={ref} />);
    expect(google().textContent).toContain("Ask an admin to set up Google");
    expect(hasButton("Set up Google", google())).toBe(false);
    expect(hasButton("Connect", google())).toBe(false);
  });

  it("without a client, sends an admin to Administration › Google", async () => {
    admin = true;
    await render(<IntegrationsSection projectRef={ref} />);
    await click(button("Set up Google", google()));
    expect(window.location.hash).toBe("#/admin/google");
  });

  it("says when the Navi's machine doesn't hold the client, and how to fix it", async () => {
    client = held("buildbox");
    await render(<IntegrationsSection projectRef={ref} />);
    expect(google().textContent).toContain("devbox doesn't hold the hub's Google client");
    expect(google().textContent).toContain("Ask an admin to save it again while it is online.");
    expect(hasButton("Connect", google())).toBe(false);
  });

  it("connects through main: what Google will ask first, then the account and its scopes", async () => {
    client = held("devbox");
    await render(<IntegrationsSection projectRef={ref} />);
    await click(button("Connect", google()));
    expect(dialog().textContent).toContain("Drafts, sends and replies. It can't delete mail or change labels.");
    expect(dialog().textContent).toContain("Seeing a warning or an error on Google’s page?");
    await click(button("Continue in browser", dialog()));
    expect(connects).toEqual([{ project: ref }]);
    // The code and its verifier stay in main: the page never calls google_connect.
    expect(calls.some((c) => c.tool === "google_connect")).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const text = google().textContent;
    expect(text).toContain("sam@example.com");
    expect(text).toContain("Connected");
    expect(text).toContain("gmail.readonly · gmail.compose · calendar.events · drive");
    expect(text).toContain("The Navi gets its Google tools from its next start.");
  });

  it("shows why a connect failed, with its fix, and lets the person try again; Cancel stops main waiting", async () => {
    client = held("devbox");
    connectAnswer = { ok: false, error: { code: "refused", message: "Google didn't connect: the consent page was cancelled.", fix: "Connect again and press Continue." } };
    await render(<IntegrationsSection projectRef={ref} />);
    await click(button("Connect", google()));
    await click(button("Continue in browser", dialog()));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Google didn't connect: the consent page was cancelled. Connect again and press Continue.");
    expect(hasButton("Try again", dialog())).toBe(true);
    connectAnswer = { ok: false, error: { code: "cancelled", message: "Connecting was cancelled." } };
    await click(button("Try again", dialog()));
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    await click(button("Cancel", dialog()));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(cancelled).toBe(0);
    // While main waits on the browser: no button to press twice, and Cancel tells main to stop.
    hang = true;
    await click(button("Connect", google()));
    await click(button("Continue in browser", dialog()));
    expect(dialog().textContent).toContain("Waiting for Google…");
    expect(hasButton("Continue in browser", dialog())).toBe(false);
    await click(button("Cancel", dialog()));
    expect(cancelled).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("names a scope unticked at Google, and offers Reconnect", async () => {
    client = held("devbox");
    linked = account({ scopes: SCOPES.filter((x) => !x.endsWith("/drive")) });
    await render(<IntegrationsSection projectRef={ref} />);
    expect(google().textContent).toContain("Without Drive: unticked on Google's page.");
    await click(button("Reconnect", google()));
    expect(dialog().textContent).toContain("Reconnect Google");
  });

  it("a lapsed connection says why, and Reconnect leads", async () => {
    client = held("devbox");
    linked = account({ lapsed: "Google answered invalid_grant: the access was revoked" });
    await render(<IntegrationsSection projectRef={ref} />);
    const text = google().textContent;
    expect(text).toContain("Needs reconnecting");
    expect(text).toContain("Google stopped taking this connection: Google answered invalid_grant: the access was revoked.");
    expect(button("Reconnect", google()).getAttribute("data-variant") ?? "").not.toBe("ghost");
  });

  it("disconnects with google_disconnect, saying what it revokes, and shows the hub's word after", async () => {
    client = held("devbox");
    linked = account();
    await render(<IntegrationsSection projectRef={ref} />);
    await click(button("Disconnect", google()));
    expect(dialog().textContent).toContain("revokes its access at Google, unless another Navi uses sam@example.com");
    await click(button("Disconnect", dialog()));
    expect(calls.find((c) => c.tool === "google_disconnect")?.input).toEqual({ project: ref });
    expect(google().textContent).toContain("Google revoked the Navi's access.");
    expect(hasButton("Connect", google())).toBe(true);
  });

  it("shows the hub's error with its fix, and nothing on a hub too old for Google", async () => {
    getError = { ok: false, error: { code: "forbidden", message: "Not allowed.", fix: "Ask for operate on devbox." } };
    await render(<IntegrationsSection projectRef={ref} />);
    expect(google().querySelector('[role="alert"]')?.textContent).toBe("Not allowed. Ask for operate on devbox.");
    act(() => root.unmount());
    root = createRoot(host);
    getError = { ok: false, error: { code: "not_found", message: "No tool google_get." } };
    await render(<IntegrationsSection projectRef={ref} />);
    expect(document.querySelector('[role="listitem"][aria-label="Google"]')).toBeNull();
  });
});

const KEY = JSON.stringify({ type: "service_account", project_id: "fleetd-devbox", private_key: "-----BEGIN PRIVATE KEY-----never_in_a_hub_call", client_email: "fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com" });

describe("real-time mail", () => {
  it("in Administration: off until set up, the key sealed through main and never in a hub call", async () => {
    client = held("devbox", "buildbox");
    await render(<AdminGoogle />);
    const mail = region("Real-time mail");
    expect(mail.textContent).toContain("Off. A Navi whose new mail wakes it hears of it within about a minute");
    const fold = [...mail.querySelectorAll("details")][0];
    if (fold === undefined) throw new Error("no fold");
    await act(async () => {
      fold.open = true;
      fold.dispatchEvent(new Event("toggle"));
      await Promise.resolve();
    });
    expect(mail.textContent).toContain("gmail-api-push@system.gserviceaccount.com");
    expect((mail.querySelector('[aria-label="Topic"]') as HTMLInputElement).value).toBe("projects/fleetd-devbox/topics/fleetd-gmail");
    await type("Service account key", "{ not json");
    expect(mail.textContent).toContain("That isn't JSON");
    await type("Service account key", KEY);
    await click(button("Save", mail));
    expect(pubsubRequests).toEqual([
      {
        topic: "projects/fleetd-devbox/topics/fleetd-gmail",
        subscription: "projects/fleetd-devbox/subscriptions/fleetd-gmail-hub",
        machineId: "buildbox",
        boxPubKey: BOX,
        key: KEY,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("never_in_a_hub_call");
    expect(document.body.textContent).not.toContain("never_in_a_hub_call");
    expect(mail.querySelector('[role="status"]')?.textContent).toContain("start watching their inbox within a minute");
  });

  it("in Administration: push, or polling with why, and Turn off after asking", async () => {
    client = held("devbox");
    pubsub = { topic: "projects/fleetd-devbox/topics/fleetd-gmail", subscription: "projects/fleetd-devbox/subscriptions/fleetd-gmail-hub", machineId: "devbox", fingerprint: "71d03a5e" };
    mailMode = "polling";
    mailProblem = "devbox is offline, and it holds the key";
    await render(<AdminGoogle />);
    const mail = region("Real-time mail");
    expect(mail.textContent).toContain("Read on devbox, whose node holds the key.");
    expect(mail.textContent).toContain("By checking about every minute for now: devbox is offline, and it holds the key.");
    await click(button("Turn off", mail));
    expect(dialog().textContent).toContain("devbox forgets the service account key");
    await click(button("Turn off", dialog()));
    expect(calls.find((c) => c.tool === "google_pubsub_set")?.input).toEqual({});
    expect(mail.textContent).toContain("The hub checks the mail of each Navi whose mail wakes it about every minute.");
  });

  it("on a Navi: off by default; All saves at once; a search saves with its button; and how mail arrives", async () => {
    client = held("devbox");
    linked = account();
    mailMode = "push";
    await render(<IntegrationsSection projectRef={ref} />);
    const wake = google().querySelector<HTMLElement>('[role="group"][aria-label="New mail"]');
    if (wake === null) throw new Error("no mail wake");
    expect(button("Off", wake).getAttribute("aria-pressed")).toBe("true");
    // Off says nothing of how mail arrives: nothing wakes the Navi.
    expect(wake.textContent).not.toContain("By push");
    await click(button("All new mail", wake));
    expect(calls.filter((c) => c.tool === "google_mail_set").map((c) => c.input)).toEqual([{ project: ref, rule: "all" }]);
    expect(wake.textContent).toContain("By push: new mail reaches it within seconds.");
    await click(button("Matching a search", wake));
    expect(calls.filter((c) => c.tool === "google_mail_set")).toHaveLength(1);
    await type("Gmail search", "from:ana@example.com OR is:important");
    await click(button("Save", wake));
    expect(calls.filter((c) => c.tool === "google_mail_set").map((c) => c.input)[1]).toEqual({ project: ref, rule: "query", query: "from:ana@example.com OR is:important" });
    expect(wake.querySelector('[role="status"]')?.textContent).toBe("New mail matching the query wakes the Navi.");
  });

  it("on a Navi: polling without real-time mail says so", async () => {
    client = held("devbox");
    linked = account({ mail: { rule: "query", query: "is:important" } });
    await render(<IntegrationsSection projectRef={ref} />);
    const wake = google().querySelector<HTMLElement>('[role="group"][aria-label="New mail"]');
    expect((wake?.querySelector('[aria-label="Gmail search"]') as HTMLInputElement | null)?.value).toBe("is:important");
    expect(wake?.textContent).toContain("By checking about every minute: real-time mail isn't set up on this hub.");
  });
});
