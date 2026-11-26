// Sign in to fleetd cloud against the repo's stand-in accounts service and WorkOS page (fleetd/test/fake-accounts.ts):
// the system's auth session is played by the fake's `authorize`, the round trip the person makes on WorkOS's page.
// Back from it, the person is asked who signed in and about each invitation before anything pairs. Then sign-out, its
// revoke of this phone's own key on a hub that closes the link on it, and the first screen.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAccounts } from "../../../../fleetd/test/fake-accounts.ts";
import { fakeHub } from "../hub/fake";
import {
  afterSignIn,
  authorizeUrl,
  makeWorkspace,
  needsComputer,
  pkce,
  queryOf,
  revokeDropped,
  revokeOver,
  signIn,
  signInAsking,
  shownAfterSignIn,
  shownHub,
  signOutAll,
  type AfterSignInAsk,
  type HeldAccount,
  type AuthResult,
  type KeptHub,
  type SignInPorts,
} from "./account";
import { billingShown, type BillingState } from "../billing";
import { deleteTeamShown } from "../team";
import { builtCloudConfig, cloudConfig, firstScreen, type CloudConfig } from "./config";

const random = (n: number) => new Uint8Array(randomBytes(n));

let fake: FakeAccounts;
let config: CloudConfig;

beforeEach(async () => {
  fake = await new FakeAccounts().start();
  config = cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl)!;
});
afterEach(() => fake.stop());

/** The ports, the auth session the person signing in as `email` on WorkOS's page; `answer` to play it otherwise. */
const ports = (email: string, answer?: (url: string) => AuthResult): SignInPorts & { opened: string[] } => {
  const opened: string[] = [];
  return {
    opened,
    config,
    local: true,
    fetch: (url, init) => fetch(url, init),
    authSession: (url, redirect) => {
      opened.push(url);
      expect(redirect).toBe("fleetd://signin/callback");
      return Promise.resolve(answer?.(url) ?? { type: "success", url: fake.authorize(url, email) });
    },
    random,
    deviceName: "Ada's iPhone",
  };
};

/** The person's answers after the page, and every question asked, in order. */
const answering = (me = true, join: (name: string) => boolean = () => false): AfterSignInAsk & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    signedInAs: (email) => {
      asked.push(`Signed in as ${email}`);
      return Promise.resolve(me);
    },
    invitation: (i) => {
      asked.push(`${i.invitedBy} invited you to ${i.name} as ${i.role}`);
      return Promise.resolve(join(i.name));
    },
  };
};

describe("in several teams", () => {
  it("shows the team picked on the sign-in page, not the first", async () => {
    await fake.team("acme", ["ada@example.com"]);
    const labUrl = await fake.team("lab", ["ada@example.com"]);
    fake.pickNext = "lab";
    const out = await signInAsking(ports("ada@example.com"), answering());
    if (!out.ok) throw new Error("not signed in");
    expect(out.picked).toBe(labUrl);
    const { hubs } = afterSignIn([], out.teams);
    expect(shownAfterSignIn(hubs, out.picked)?.hubName).toBe("lab");
    // No pick: the first team, as before.
    expect(shownAfterSignIn(hubs, undefined)?.hubName).toBe("acme");
  });
});

describe("No team yet", () => {
  it("someone invited who passes on it: Make a Team makes one of their own and keeps it", async () => {
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "new@example.com", "eve@other.example");
    const ask = { ...answering(), makeTeam: (email: string) => (ask.asked.push(`No team yet for ${email}`), Promise.resolve(true)) };
    const out = await signInAsking(ports("new@example.com"), ask);
    expect(ask.asked).toEqual(["Signed in as new@example.com", "eve@other.example invited you to acme as member", "No team yet for new@example.com"]);
    expect(out).toMatchObject({ ok: true, teams: [{ name: "new", ok: true }] });
    expect(fake.madeOnAsking).toEqual(["new new@example.com"]);
  });

  it("removed from their team: No Workspace Yet is asked, and its Delete Account reads what goes and deletes with the make value", async () => {
    await fake.team("acme", ["sam@acme.example", "bob@acme.example"]);
    fake.remove("acme", "bob@acme.example");
    const ask = {
      ...answering(),
      makeTeam: async (email: string, account: HeldAccount) => {
        ask.asked.push(`No team yet for ${email}`);
        expect(await account.preview()).toEqual({ ok: true, value: { email: "bob@acme.example", deletes: [], leaves: [], blocked: [] } });
        expect(await account.remove("someone@else.example")).toMatchObject({ code: "wrong_email" });
        expect(await account.remove("bob@acme.example")).toBeNull();
        return "deleted" as const;
      },
    };
    const out = await signInAsking(ports("bob@acme.example"), ask);
    expect(ask.asked).toEqual(["Signed in as bob@acme.example", "No team yet for bob@acme.example"]);
    expect(out).toEqual({ ok: false, cancelled: true });
    expect(fake.deletedAccounts).toEqual(["bob@acme.example"]);
    expect(fake.madeOnAsking).toEqual([]);
  });

  it("Not Now makes nothing, and isn't asked of someone with a team", async () => {
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "new@example.com", "eve@other.example");
    const ask = { ...answering(), makeTeam: () => Promise.resolve(false) };
    expect(await signInAsking(ports("new@example.com"), ask)).toMatchObject({ ok: false, failure: { code: "none_joined" } });
    expect(fake.madeOnAsking).toEqual([]);
    await fake.team("lab", ["ada@example.com"]);
    let asked = false;
    const out = await signInAsking(ports("ada@example.com"), { ...answering(), makeTeam: () => ((asked = true), Promise.resolve(true)) });
    expect(out.ok).toBe(true);
    expect(asked).toBe(false);
  });
});

describe("New Workspace", () => {
  it("asks one of the account's workspaces with this phone's key, and pairs the new one as a workspace they made", async () => {
    const url = await fake.team("acme", ["eve@other.example", "ada@example.com"]);
    const acme: KeptHub = { hub: url, key: fake.keyFor("acme", "ada@example.com"), hubName: "acme", cloud: true };
    const out = await makeWorkspace(ports("ada@example.com"), acme, "  Side project ");
    expect(out).toMatchObject({ name: "side-project", ok: true, hub: { hubName: "side-project", cloud: true } });
    expect(out.ok && out.hub.invited).toBeUndefined();
    expect(fake.keys.at(-1)).toMatchObject({ team: "side-project", email: "ada@example.com", deviceName: "Ada's iPhone" });
    // No name: the cloud names it after the person.
    expect(await makeWorkspace(ports("ada@example.com"), acme, "")).toMatchObject({ ok: true, hub: { hubName: "adas-workspace" } });
  });

  it("says the cloud's refusal as written, with what to do, and no network as no network", async () => {
    const url = await fake.team("acme", ["ada@example.com"]);
    const acme: KeptHub = { hub: url, key: fake.keyFor("acme", "ada@example.com"), hubName: "acme", cloud: true };
    fake.workspaceCap = 1;
    expect(await makeWorkspace(ports("ada@example.com"), acme, "More")).toEqual({
      name: "More",
      ok: false,
      failure: { code: "workspace_cap", message: "You've made 1 workspaces, the most one person can have.", fix: "Delete one you don't use in Settings › Workspace, then make a new one." },
    });
    // A status alone (an older cloud, or something in between): said as the workspace's, not as the sign-in's.
    const bare = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${String((bare.address() as AddressInfo).port)}`;
    expect(await makeWorkspace(ports("ada@example.com"), { ...acme, hub: at }, "More")).toEqual({ name: "More", ok: false, failure: { code: "", message: "acme answered HTTP 404.", fix: "Try again in a minute." } });
    bare.close();
    await fake.stop();
    expect(await makeWorkspace(ports("ada@example.com"), acme, "More")).toMatchObject({ ok: false, failure: { code: "offline", message: "Can't reach acme." } });
  });
});

describe("Sign In", () => {
  it("one team: the page with PKCE, one call to the accounts service, and the team's key from its own /pair", async () => {
    const url = await fake.team("acme", ["ada@example.com"]);
    const p = ports("ada@example.com");
    const ask = answering();
    const out = await signInAsking(p, ask);
    expect(ask.asked).toEqual(["Signed in as ada@example.com"]);
    expect(out).toMatchObject({ ok: true, account: { email: "ada@example.com" } });
    if (!out.ok) return;
    expect(fake.sessions.has(out.account.sessionId)).toBe(true);
    expect(out.teams).toEqual([{ name: "acme", ok: true, hub: { hub: url, key: fake.keys[0]!.key, hubName: "acme", cloud: true } }]);
    expect(fake.keys).toMatchObject([{ team: "acme", deviceName: "Ada's iPhone" }]);
    // The verifier goes to the service alone, never in the page's address.
    const [sent] = fake.signIns;
    expect(sent).toMatchObject({ redirectUri: "fleetd://signin/callback", deviceName: "Ada's iPhone" });
    expect(p.opened[0]).not.toContain(sent!.codeVerifier);
    expect(p.opened[0]).toContain(`redirect_uri=${encodeURIComponent("fleetd://signin/callback")}`);
  });

  it("several teams: every one becomes a hub this phone keeps, beside a hub of the person's own", async () => {
    await fake.team("acme", ["ada@example.com"]);
    await fake.team("lab", ["ada@example.com"]);
    const out = await signInAsking(ports("ada@example.com"), answering());
    if (!out.ok) throw new Error("not signed in");
    expect(out.teams.map((t) => t.ok && t.hub.hubName)).toEqual(["acme", "lab"]);
    const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };
    const stale: KeptHub = { hub: "https://old.example", key: "fld_old", hubName: "old", cloud: true };
    expect(afterSignIn([own, stale], out.teams).hubs.map((h) => h.hubName)).toEqual(["devbox", "acme", "lab"]);
  });

  it("a first sign-in's team has no computer yet: the chats list says to connect one from the desktop", async () => {
    const out = await signInAsking(ports("new@example.com"), answering());
    if (!out.ok) throw new Error("not signed in");
    const team = out.teams[0];
    if (team?.ok !== true) throw new Error("no team");
    expect(fake.teamsOf("new@example.com")).toEqual(["new"]);
    expect(needsComputer(team.hub, { projects: {}, machines: [] })).toBe(true);
    expect(needsComputer(team.hub, { projects: {}, machines: [{ machineId: "m1" }] })).toBe(false);
    // Not before the snapshot says, and never on a hub of the person's own.
    expect(needsComputer(team.hub, { projects: undefined, machines: [] })).toBe(false);
    expect(needsComputer({ hub: "http://devbox:4790", key: "k", hubName: "devbox" }, { projects: {}, machines: [] })).toBe(false);
  });

  it("closed sheet, or Cancel on WorkOS's page: cancelled quietly, nothing asked of the service", async () => {
    await fake.team("acme", ["ada@example.com"]);
    expect(await signIn(ports("ada@example.com", () => ({ type: "cancel" })))).toEqual({ ok: false, cancelled: true });
    expect(await signIn(ports("ada@example.com", (url) => ({ type: "success", url: fake.authorize(url, "ada@example.com", true) })))).toEqual({ ok: false, cancelled: true });
    expect(fake.signIns).toEqual([]);
  });

  it("refuses an answer whose state isn't the one this app sent", async () => {
    await fake.team("acme", ["ada@example.com"]);
    const forged = (url: string): AuthResult => ({ type: "success", url: fake.authorize(url, "ada@example.com").replace(/state=[^&]+/u, "state=someone-else") });
    expect(await signIn(ports("ada@example.com", forged))).toMatchObject({ ok: false, failure: { code: "state" } });
    const none = (url: string): AuthResult => ({ type: "success", url: fake.authorize(url, "ada@example.com").replace(/[?&]state=[^&]+/u, "") });
    expect(await signIn(ports("ada@example.com", none))).toMatchObject({ ok: false, failure: { code: "state" } });
    expect(fake.signIns).toEqual([]);
    expect(fake.keys).toEqual([]);
  });

  it("says the service's refusal in its words, and no network as no network", async () => {
    await fake.team("acme", ["ada@example.com"]);
    fake.refuseNext = { status: 429, failure: { code: "rate_limited", message: "Too many sign-ins from here.", fix: "Try again in a minute." } };
    expect(await signIn(ports("ada@example.com"))).toEqual({ ok: false, failure: { code: "rate_limited", message: "Too many sign-ins from here.", fix: "Try again in a minute." } });
    const offline = { ...ports("ada@example.com"), fetch: () => Promise.reject(new TypeError("Network request failed")) };
    expect(await signIn(offline)).toMatchObject({ ok: false, failure: { code: "offline", message: "This phone can't reach fleetd." } });
  });

  it("a team's hub that won't pair is named; with none paired, the session ends", async () => {
    await fake.team("acme", ["ada@example.com"]);
    await fake.team("lab", ["ada@example.com"], { refusePairing: true });
    const some = await signInAsking(ports("ada@example.com"), answering());
    expect(some).toMatchObject({ ok: true, teams: [{ name: "acme", ok: true }, { name: "lab", ok: false, failure: { message: "lab refused this phone's code." } }] });

    const unreached = { ...ports("ada@example.com") };
    unreached.fetch = (url, init) => (url.endsWith("/pair") ? Promise.reject(new TypeError("Network request failed")) : fetch(url, init));
    const none = await signInAsking(unreached, answering());
    expect(none).toMatchObject({ ok: false, failure: { code: "offline", message: "Can't reach acme." } });
    await vi.waitFor(() => expect(fake.ended).toHaveLength(1));
  });

  it("an invitation pairs nothing until Join: asked after who signed in, Not Now leaves it for the next sign-in", async () => {
    await fake.team("ada", ["ada@example.com"]);
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "ada@example.com", "eve@other.example", "admin");
    const later = answering();
    const out = await signInAsking(ports("ada@example.com"), later);
    expect(later.asked).toEqual(["Signed in as ada@example.com", "eve@other.example invited you to acme as admin"]);
    expect(out).toMatchObject({ ok: true, teams: [{ name: "ada", ok: true }] });
    expect(fake.keys.map((k) => k.team)).toEqual(["ada"]);
    expect(fake.accepted).toEqual([]);
    const join = answering(true, (name) => name === "acme");
    const again = await signInAsking(ports("ada@example.com"), join);
    expect(again).toMatchObject({ ok: true, teams: [{ name: "ada", ok: true }, { name: "acme", ok: true }] });
    expect(fake.accepted).toEqual(["acme ada@example.com"]);
    expect(fake.keys.map((k) => k.team)).toEqual(["ada", "ada", "acme"]);
    // Someone else's fresh team, joined by invitation (the service's made: false): its chats list never says to connect a
    // computer to it.
    if (!again.ok) throw new Error("not signed in");
    const [own, joined] = again.teams.map((t) => (t.ok ? t.hub : null));
    if (own === null || own === undefined || joined === null || joined === undefined) throw new Error("both teams should have paired");
    expect([own.invited, joined.invited]).toEqual([undefined, true]);
    const empty = { projects: {}, machines: [] };
    expect(needsComputer(own, empty)).toBe(true);
    expect(needsComputer(joined, empty)).toBe(false);
    // Its hub saying they own it changes nothing; a team marked cloud with no sign-in's word (one paired with a code), only
    // its owner is told to connect one: a member sees No Chats Yet.
    expect(needsComputer(own, { ...empty, meRole: "owner" })).toBe(true);
    const coded = { hub: "https://acme.fleetd.dev", key: "fld_code", hubName: "acme", cloud: true as const };
    expect(needsComputer(coded, { ...empty, meRole: "member" })).toBe(false);
    expect(needsComputer(coded, { ...empty, meRole: "admin" })).toBe(false);
    expect(needsComputer(coded, { ...empty, meRole: "owner" })).toBe(true);
    // A later sign-in brings it among the person's teams, and the service still says they didn't make it.
    const third = await signInAsking(ports("ada@example.com"), answering());
    expect(third.ok && third.teams.map((t) => t.ok && [t.name, t.hub.invited])).toEqual([["ada", undefined], ["acme", true]]);
  });

  it("no team of their own and one invitation: still asked, and Not Now pairs nothing and ends the session", async () => {
    await fake.team("acme", ["eve@other.example"]);
    fake.invite("acme", "new@example.com", "eve@other.example");
    const ask = answering();
    const out = await signInAsking(ports("new@example.com"), ask);
    expect(ask.asked).toEqual(["Signed in as new@example.com", "eve@other.example invited you to acme as member"]);
    expect(out).toMatchObject({ ok: false, failure: { code: "none_joined" } });
    expect(fake.keys).toEqual([]);
    expect(fake.teamsOf("new@example.com")).toEqual([]);
    await vi.waitFor(() => expect(fake.ended).toHaveLength(1));
  });

  it("Sign Out at Signed in as: nothing asked after, nothing paired, the session ended", async () => {
    await fake.team("acme", ["ada@example.com"]);
    fake.invite("acme", "ada@example.com", "eve@other.example");
    const ask = answering(false);
    expect(await signInAsking(ports("ada@example.com"), ask)).toEqual({ ok: false, cancelled: true });
    expect(ask.asked).toEqual(["Signed in as ada@example.com"]);
    expect(fake.keys).toEqual([]);
    await vi.waitFor(() => expect(fake.ended).toHaveLength(1));
  });

  it("revokes each key a sign-in replaces and an earlier account's teams, and a hub that can't be told doesn't stop it", async () => {
    await fake.team("acme", ["ada@example.com"]);
    const out = await signInAsking(ports("ada@example.com"), answering());
    if (!out.ok) throw new Error("not signed in");
    const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };
    const acme = out.teams[0]?.ok === true ? out.teams[0].hub : null;
    if (acme === null) throw new Error("no team");
    const replaced: KeptHub = { ...acme, key: "fld_before" };
    const other: KeptHub = { hub: "https://kim.fleetd.dev", key: "fld_kim", hubName: "kim", cloud: true };
    const { hubs, dropped } = afterSignIn([own, replaced, other], out.teams);
    expect(hubs.map((h) => h.key)).toEqual(["fld_own", acme.key]);
    expect(dropped.map((h) => h.key)).toEqual(["fld_before", "fld_kim"]);
    const revoked: string[] = [];
    const unreached = await revokeDropped((h) => (revoked.push(h.key), h.hubName === "kim" ? Promise.reject(new Error("offline")) : Promise.resolve(true)), dropped);
    expect(revoked).toEqual(["fld_before", "fld_kim"]);
    expect(unreached).toEqual(["kim"]);
  });

  it("keeps the page's link to WorkOS's own parameters, the verifier's S256 challenge, max_age=0 and prompt=login among them", () => {
    const { verifier, challenge } = pkce(random);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const q = queryOf(authorizeUrl(config, { challenge, state: "st" }));
    expect(Object.fromEntries(q)).toEqual({
      client_id: "client_fake",
      redirect_uri: "fleetd://signin/callback",
      response_type: "code",
      provider: "authkit",
      prompt: "login",
      max_age: "0",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  });
});

describe("App Review's review code (D737)", () => {
  it("signs the demo address in to the demo team with no page, after the same Signed in as", async () => {
    await fake.team("demo", ["owner@fleetd.dev"]);
    fake.demo = { email: "review@fleetd.dev", code: "review-code-123", team: "demo" };
    const p = ports("nobody@example.com");
    const ask = answering();
    const out = await signInAsking(p, ask, { email: "  Review@Fleetd.dev ", code: "review-code-123" });
    expect(p.opened).toEqual([]);
    expect(ask.asked).toEqual(["Signed in as review@fleetd.dev"]);
    expect(out).toMatchObject({ ok: true, account: { email: "review@fleetd.dev" }, teams: [{ name: "demo", ok: true }] });
    if (!out.ok) throw new Error("not signed in");
    expect(out.teams[0]!.ok && out.teams[0]!.hub.invited).toBeUndefined();
  });

  it("shows a wrong code, a closed demo and a busy service in the service's words", async () => {
    await fake.team("demo", ["owner@fleetd.dev"]);
    const typed = { email: "review@fleetd.dev", code: "review-code-123" };
    expect(await signInAsking(ports("x@example.com"), answering(), typed)).toMatchObject({ ok: false, failure: { code: "signin_closed" } });
    fake.demo = { ...typed, team: "demo" };
    expect(await signInAsking(ports("x@example.com"), answering(), { ...typed, code: "wrong-code" })).toMatchObject({ ok: false, failure: { code: "signin_refused", fix: "Check both, then try again." } });
    fake.refuseNext = { status: 429, failure: { code: "rate_limited", message: "Too many tries.", fix: "Try again in 10 minutes." } };
    expect(await signInAsking(ports("x@example.com"), answering(), typed)).toMatchObject({ ok: false, failure: { code: "rate_limited", fix: "Try again in 10 minutes." } });
  });
});

describe("Sign Out", () => {
  const team = (name: string): KeptHub => ({ hub: `https://${name}.fleetd.dev`, key: `fld_${name}`, hubName: name, cloud: true });
  const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };

  it("revokes the key on every team kept, not only the one shown, then ends the session; the own hub stays", async () => {
    const out = await signInAsking(ports("new@example.com"), answering());
    if (!out.ok) throw new Error("not signed in");
    const revoked: string[] = [];
    const left = await signOutAll(
      { config, fetch: (url, init) => fetch(url, init), revoke: (h) => (revoked.push(h.hubName), Promise.resolve(h.hubName !== "lab")) },
      out.account,
      [own, team("acme"), team("lab")],
    );
    expect(revoked.sort()).toEqual(["acme", "lab"]);
    expect(left).toEqual({ hubs: [own], kept: ["lab"] });
    expect(fake.ended).toEqual([out.account.sessionId]);
  });

  it("counts a hub that closes the link on the key it just revoked as revoked, not as unreached", async () => {
    vi.useFakeTimers();
    try {
      const hub = fakeHub();
      const done = revokeOver({ hub: "https://acme.fleetd.dev", key: "fld_abcdefxyz", transport: hub.transport });
      hub.ready();
      await vi.advanceTimersByTimeAsync(0);
      const key = (keyId: string, prefix: string) => ({ keyId, prefix, kind: "human", name: keyId, grants: [], createdAt: "2026-10-28T10:00:00Z", person: { personId: "pr_ada", name: "Ada" } });
      hub.answer("people_list", { me: "pr_ada", people: [], invites: [], devices: [key("k1", "fld_qqqqqq"), key("k2", "fld_abcdef")] });
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.sentOf("call").at(-1)).toMatchObject({ tool: "device_revoke", input: { keyId: "k2" } });
      // As a hub does: no answer, the link closed as unauthorized.
      hub.link.close(4401, "key revoked");
      expect(await done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a team whose hub can't be reached", async () => {
    vi.useFakeTimers();
    try {
      const hub = fakeHub();
      const done = revokeOver({ hub: "https://acme.fleetd.dev", key: "fld_abcdefxyz", transport: hub.transport });
      hub.link.close(1006);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await done).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a team paired with a code", () => {
  // As qa-sweep's Pair a phone pairs it: the team's own address and a key, nothing of the account.
  const paired: KeptHub = { hub: "https://qa-sweep.fleetd.dev", key: "fld_code", hubName: "qa-sweep" };
  const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };
  const CLOUD_LEFT_OUT = ["hub_update", "hub_update_status", "hub_restart", "machine_add"];
  const on = { providedOn: true } as BillingState;

  it("is a team once its hub_info leaves tools out, as only fleetd cloud does: Team, Billing and Delete Team show", () => {
    const shown = shownHub(paired, CLOUD_LEFT_OUT);
    expect(shown).toEqual({ ...paired, cloud: true });
    expect(deleteTeamShown(shown, "owner")).toBe(true);
    expect(billingShown(shown, true, on)).toBe(true);
    // Before the hub says so, and on a self-run hub, which leaves nothing out, it is a hub.
    expect(shownHub(paired, [])).toBe(paired);
    expect(billingShown(shownHub(own, []), true, on)).toBe(false);
    expect(deleteTeamShown(shownHub(own, []), "owner")).toBe(false);
  });

  it("keeps a team of the account as it is", () => {
    const team: KeptHub = { ...paired, cloud: true, invited: true };
    expect(shownHub(team, CLOUD_LEFT_OUT)).toBe(team);
    expect(shownHub(team, [])).toBe(team);
  });

  it("stays out of the account's teams: a sign-in or sign-out never drops its key", async () => {
    const left = await signOutAll({ config: null, fetch: () => Promise.reject(new Error("no call")), revoke: () => Promise.reject(new Error("not revoked")) }, null, [own, paired]);
    expect(left).toEqual({ hubs: [own, paired], kept: [] });
    expect(afterSignIn([own, paired], []).dropped).toEqual([]);
  });
});

describe("the build's values", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("without both, the first screen is today's pairing alone", () => {
    vi.stubEnv("EXPO_PUBLIC_FLEETD_ACCOUNTS_URL", "");
    vi.stubEnv("EXPO_PUBLIC_FLEETD_WORKOS_CLIENT_ID", "client_123");
    expect(builtCloudConfig()).toBeNull();
    expect(firstScreen(builtCloudConfig(), false)).toBe("pair");
    vi.stubEnv("EXPO_PUBLIC_FLEETD_ACCOUNTS_URL", "https://accounts.fleetd.dev");
    vi.stubEnv("EXPO_PUBLIC_FLEETD_WORKOS_CLIENT_ID", "");
    expect(firstScreen(builtCloudConfig(), false)).toBe("pair");
  });

  it("with both, it offers Sign In and Use Your Own Hub, which opens the pairing", () => {
    vi.stubEnv("EXPO_PUBLIC_FLEETD_ACCOUNTS_URL", "https://accounts.fleetd.dev/");
    vi.stubEnv("EXPO_PUBLIC_FLEETD_WORKOS_CLIENT_ID", "client_123");
    expect(builtCloudConfig()).toEqual({ accountsUrl: "https://accounts.fleetd.dev", clientId: "client_123", authorizeUrl: "https://api.workos.com/user_management/authorize" });
    expect(firstScreen(builtCloudConfig(), false)).toBe("ways");
    expect(firstScreen(builtCloudConfig(), true)).toBe("pair");
  });

  it("takes only an https origin, and http on 127.0.0.1 in a development build", () => {
    expect(cloudConfig("http://accounts.fleetd.dev", "c", false)).toBeNull();
    expect(cloudConfig("https://accounts.fleetd.dev/v1", "c", false)).toBeNull();
    expect(cloudConfig("https://user@accounts.fleetd.dev", "c", false)).toBeNull();
    expect(cloudConfig("http://127.0.0.1:4100", "c", false)).toBeNull();
    expect(cloudConfig("http://127.0.0.1:4100", "c", true)?.accountsUrl).toBe("http://127.0.0.1:4100");
  });
});
