// Sign in to fleetd cloud against the repo's stand-in accounts service and WorkOS page (fleetd/test/fake-accounts.ts):
// the system's auth session is played by the fake's `authorize`, the round trip the person makes on WorkOS's page.
// Then sign-out, its revoke of this phone's own key on a hub that closes the link on it, and the first screen.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAccounts } from "../../../../fleetd/test/fake-accounts.ts";
import { fakeHub } from "../hub/fake";
import { afterSignIn, authorizeUrl, needsComputer, pkce, queryOf, revokeOver, signIn, signOutAll, type AuthResult, type KeptHub, type SignInPorts } from "./account";
import { builtCloudConfig, cloudConfig, firstScreen, teamOrigin, type CloudConfig } from "./config";

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

describe("Sign In", () => {
  it("one team: the page with PKCE, one call to the accounts service, and the team's key from its own /pair", async () => {
    const url = await fake.team("acme", ["ada@example.com"]);
    const p = ports("ada@example.com");
    const out = await signIn(p);
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
    const out = await signIn(ports("ada@example.com"));
    if (!out.ok) throw new Error("not signed in");
    expect(out.teams.map((t) => t.ok && t.hub.hubName)).toEqual(["acme", "lab"]);
    const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };
    const stale: KeptHub = { hub: "https://old.example", key: "fld_old", hubName: "old", cloud: true };
    expect(afterSignIn([own, stale], out.teams).map((h) => h.hubName)).toEqual(["devbox", "acme", "lab"]);
  });

  it("a first sign-in's team has no computer yet: the chats list says to connect one from the desktop", async () => {
    const out = await signIn(ports("new@example.com"));
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
    const some = await signIn(ports("ada@example.com"));
    expect(some).toMatchObject({ ok: true, teams: [{ name: "acme", ok: true }, { name: "lab", ok: false, failure: { message: "lab refused this phone's code." } }] });

    const unreached = { ...ports("ada@example.com") };
    unreached.fetch = (url, init) => (url.endsWith("/pair") ? Promise.reject(new TypeError("Network request failed")) : fetch(url, init));
    const none = await signIn(unreached);
    expect(none).toMatchObject({ ok: false, failure: { code: "offline", message: "Can't reach acme." } });
    await vi.waitFor(() => expect(fake.ended).toHaveLength(1));
  });

  it("keeps the page's link to WorkOS's own parameters, the verifier's S256 challenge among them", () => {
    const { verifier, challenge } = pkce(random);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const q = queryOf(authorizeUrl(config, { challenge, state: "st" }));
    expect(Object.fromEntries(q)).toEqual({
      client_id: "client_fake",
      redirect_uri: "fleetd://signin/callback",
      response_type: "code",
      provider: "authkit",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  });
});

describe("Sign Out", () => {
  const team = (name: string): KeptHub => ({ hub: `https://${name}.fleetd.dev`, key: `fld_${name}`, hubName: name, cloud: true });
  const own: KeptHub = { hub: "http://devbox:4790", key: "fld_own", hubName: "devbox" };

  it("revokes the key on every team kept, not only the one shown, then ends the session; the own hub stays", async () => {
    const out = await signIn(ports("new@example.com"));
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
    expect(teamOrigin("https://Acme.fleetd.dev", false)).toBe("https://acme.fleetd.dev");
    expect(teamOrigin("https://acme.fleetd.dev/?x=1", false)).toBeNull();
    expect(teamOrigin("http://10.0.0.1", true)).toBeNull();
  });
});
