// A cloud team's invites by email against the repo's stand-in (fleetd/test/fake-accounts.ts), which answers and refuses
// as fleetd cloud's accounts area does: invite, list, revoke, and each refusal in the team's own words. Only a hub that
// came with the account is ever asked; a self-hosted one is refused before any request goes out.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAccounts } from "../../../../../fleetd/test/fake-accounts.ts";
import { IPC } from "../../shared/channels";
import { parseRequest } from "../../shared/ipc";
import type { Hubs } from "../hub/hubs";
import type { HubService } from "../hub/service";
import { cloudConfig } from "./config";
import { realCloud } from "./index";
import { deleteTeam, listInvites, makeWorkspace, revokeInvite, sendInvite, type KeyedTeam } from "./invites";

// The stand-in's clock, so nothing here reads today's date.
const NOW = Date.parse("2026-10-19T10:30:00.000Z");

describe("a cloud team's invites by email", () => {
  let fake: FakeAccounts;
  let url: string;
  const as = (email: string): KeyedTeam => ({ origin: url, key: fake.keyFor("acme", email), name: "acme" });
  beforeEach(async () => {
    fake = await new FakeAccounts().start();
    fake.now = () => NOW;
    url = await fake.team("acme", ["sam@acme.example", "alice@acme.example", "bob@acme.example"], {
      roles: { "alice@acme.example": "admin" },
      peopleLimit: 6,
    });
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("an owner invites, lists and revokes; WorkOS's email goes out once", async () => {
    const sam = as("sam@acme.example");
    const sent = await sendInvite(fetch, sam, { email: "  Eve@Example.com ", role: "admin" });
    expect(sent).toMatchObject({ ok: true, invite: { email: "eve@example.com", role: "admin", expiresAt: "2026-10-26T10:30:00.000Z" } });
    expect(fake.sent).toEqual([{ team: "acme", email: "eve@example.com", role: "admin" }]);
    await sendInvite(fetch, sam, { email: "finn@example.com", role: "member" });
    const listed = await listInvites(fetch, sam);
    expect(listed.ok && listed.invites.map((i) => [i.email, i.role])).toEqual([
      ["eve@example.com", "admin"],
      ["finn@example.com", "member"],
    ]);
    if (!sent.ok) throw new Error("not sent");
    expect(await revokeInvite(fetch, sam, sent.invite.inviteId)).toEqual({ ok: true });
    expect(fake.invitesOf("acme").map((i) => i.email)).toEqual(["finn@example.com"]);
    // Revoked already: the team says so.
    expect(await revokeInvite(fetch, sam, sent.invite.inviteId)).toMatchObject({ ok: false, failure: { code: "not_found" } });
  });

  it("an admin invites too", async () => {
    expect(await sendInvite(fetch, as("alice@acme.example"), { email: "gus@example.com", role: "member" })).toMatchObject({ ok: true });
  });

  it("refuses a member, in the team's words", async () => {
    const bob = as("bob@acme.example");
    const refused = { ok: false, failure: { code: "forbidden", message: "Only an owner or admin invites people.", fix: "Ask an owner or admin of this team." } };
    expect(await sendInvite(fetch, bob, { email: "gus@example.com", role: "member" })).toEqual(refused);
    expect(await listInvites(fetch, bob)).toEqual(refused);
    expect(fake.sent).toEqual([]);
  });

  it("refuses what isn't an email, someone already here or invited, and a team at its limit", async () => {
    const sam = as("sam@acme.example");
    expect(await sendInvite(fetch, sam, { email: "not an email", role: "member" })).toEqual({
      ok: false,
      failure: { code: "invalid", message: "That isn't an email address.", fix: "Type the person's email." },
    });
    expect(await sendInvite(fetch, sam, { email: "Bob@acme.example", role: "member" })).toEqual({
      ok: false,
      failure: { code: "already_member", message: "bob@acme.example is on this team already." },
    });
    await sendInvite(fetch, sam, { email: "eve@example.com", role: "member" });
    expect(await sendInvite(fetch, sam, { email: "eve@example.com", role: "admin" })).toMatchObject({ ok: false, failure: { code: "already_invited", message: "eve@example.com is invited already." } });
    // Three people and three open invites reach the limit of six.
    await sendInvite(fetch, sam, { email: "finn@example.com", role: "member" });
    await sendInvite(fetch, sam, { email: "gus@example.com", role: "member" });
    expect(await sendInvite(fetch, sam, { email: "hal@example.com", role: "member" })).toEqual({
      ok: false,
      failure: { code: "failed", message: "This team has reached its limit of people (6).", fix: "Remove one first, or ask fleetd's operator for a higher limit." },
    });
    expect(fake.sent.map((s) => s.email)).toEqual(["eve@example.com", "finn@example.com", "gus@example.com"]);
  });

  it("says plainly when the team can't be reached", async () => {
    const team = as("sam@acme.example");
    await fake.stop();
    expect(await listInvites(fetch, team)).toEqual({ ok: false, failure: { code: "offline", message: "Can't reach acme.", fix: "Check your connection, then try again." } });
  });

  it("asks only a hub at a team address, with that hub's own key: one of the account's or one paired with a code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invites-"));
    try {
      const services: Record<string, HubService> = {
        hub: { keyed: () => ({ url, key: fake.keyFor("acme", "sam@acme.example") }) } as unknown as HubService,
        // Paired with a code: no sign-in marked it, its address says it is a team.
        coded: { keyed: () => ({ url, key: fake.keyFor("acme", "sam@acme.example") }) } as unknown as HubService,
        own: { keyed: () => ({ url: "http://devbox:4790", key: "fld_own" }) } as unknown as HubService,
      };
      const hubs = { get: (id: string) => services[id], list: () => Object.keys(services).map((id) => ({ id, label: "acme" })) } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      expect(await cloud.invite("hub", { email: "eve@example.com", role: "member" })).toMatchObject({ ok: true });
      expect(await cloud.invites("hub")).toMatchObject({ ok: true, invites: [{ email: "eve@example.com" }] });
      expect(await cloud.invites("coded")).toMatchObject({ ok: true, invites: [{ email: "eve@example.com" }] });
      // A self-hosted hub (not at a team address): refused here, the team never asked.
      expect(await cloud.invite("own", { email: "finn@example.com", role: "member" })).toEqual({
        ok: false,
        failure: { code: "", message: "That workspace isn't one of your fleetd cloud workspaces." },
      });
      // A build without the cloud's values asks nobody.
      const off = realCloud(null, hubs, dir, true, () => Promise.resolve());
      expect(await off.invites("hub")).toMatchObject({ ok: false });
      expect(fake.sent.map((s) => s.email)).toEqual(["eve@example.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes the team for its owner alone, the name typed again, never while an agent runs; then the app forgets it", async () => {
    const forbidden = { ok: false, failure: { code: "forbidden", message: "Only the team's owner deletes the team.", fix: "Ask an owner of this team." } };
    expect(await deleteTeam(fetch, as("alice@acme.example"), "acme")).toEqual(forbidden);
    expect(await deleteTeam(fetch, as("bob@acme.example"), "acme")).toEqual(forbidden);
    const sam = as("sam@acme.example");
    expect(await deleteTeam(fetch, sam, "acne")).toEqual({ ok: false, failure: { code: "wrong_name", message: "That isn't this team's name.", fix: "Type acme to delete it." } });
    fake.setRunning("acme", 2);
    expect(await deleteTeam(fetch, sam, "acme")).toEqual({
      ok: false,
      failure: { code: "running", message: "2 agents are running in this team.", fix: "Stop them, then delete the team." },
    });
    fake.setRunning("acme", 0);
    expect(fake.deleted).toEqual([]);
    // Through main: the team deleted, and its hub gone from the app; a refusal keeps it.
    const dir = mkdtempSync(join(tmpdir(), "fleetd-cloud-"));
    try {
      const removed: string[] = [];
      const service = { keyed: () => ({ url, key: sam.key }) } as unknown as HubService;
      const hubs = { get: (id: string) => (id === "hub" ? service : undefined), list: () => [{ id: "hub", label: "acme" }], remove: (id: string) => removed.push(id) } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      expect(await cloud.deleteTeam("hub", "nope")).toMatchObject({ ok: false, failure: { code: "wrong_name" } });
      expect(removed).toEqual([]);
      expect(await cloud.deleteTeam("hub", " acme ")).toEqual({ ok: true });
      expect([fake.deleted, removed]).toEqual([["acme"], ["hub"]]);
      expect(await cloud.deleteTeam("own", "acme")).toEqual({ ok: false, failure: { code: "", message: "That workspace isn't one of your fleetd cloud workspaces." } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a new empty workspace of the person's own, connects it as one they made, and opens nothing past the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetd-cloud-"));
    try {
      const connected: Array<{ url: string; key: string; label: string; invited: boolean; id: string }> = [];
      const service = { keyed: () => ({ url, key: fake.keyFor("acme", "bob@acme.example") }) } as unknown as HubService;
      const hubs = {
        get: (id: string) => (id === "hub" ? service : undefined),
        list: () => [{ id: "hub", label: "acme" }],
        connectCloud: (request: { url: string; key: string }, label: string, invited: boolean) => {
          connected.push({ ...request, label, invited, id: `h${String(connected.length + 2)}` });
          return { ok: true };
        },
        heldAt: (origin: string) => {
          const held = connected.find((c) => c.url === origin);
          return held === undefined ? null : { id: held.id, label: held.label, service: { url: () => held.url } as unknown as HubService };
        },
      } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      // Any key of the person's says who asks: a member of acme makes one of their own.
      expect(await cloud.newWorkspace("hub", " Side project ")).toEqual({ ok: true, hub: "h2" });
      expect(connected).toMatchObject([{ label: "side-project", invited: false }]);
      expect(fake.keys.map((k) => `${k.team} ${k.email}`)).toContain("side-project bob@acme.example");
      // No name: after the person, as a first one is.
      expect(await cloud.newWorkspace("hub", "")).toEqual({ ok: true, hub: "h3" });
      expect(connected[1]?.label).toBe("bobs-workspace");
      fake.workspaceCap = 2;
      expect(await cloud.newWorkspace("hub", "Third")).toEqual({
        ok: false,
        failure: { code: "workspace_cap", message: "You've made 2 workspaces, the most one person can have.", fix: "Delete one you don't use in Settings › Workspace, then make a new one." },
      });
      expect(connected).toHaveLength(2);
      // A self-hosted hub asks nobody.
      expect(await cloud.newWorkspace("own", "x")).toEqual({ ok: false, failure: { code: "", message: "That workspace isn't one of your fleetd cloud workspaces." } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a name only when one is typed, and the cloud's refusal of a long one as written", async () => {
    const bob = as("bob@acme.example");
    expect(await makeWorkspace(fetch, bob, "x".repeat(61))).toMatchObject({ ok: false, failure: { code: "invalid", message: "A workspace's name is 60 characters at most." } });
    expect(await makeWorkspace(fetch, bob, "   ")).toMatchObject({ ok: true, body: { team: { name: "bobs-workspace", made: true } } });
  });

  it("takes only a hub id, an email and a role, and an invite id, from the page", () => {
    expect(parseRequest(IPC.cloudDeleteTeam, ["hub", "acme"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudDeleteTeam, ["hub", "x".repeat(201)]).ok).toBe(false);
    expect(parseRequest(IPC.cloudNewWorkspace, ["hub", "Side project"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudNewWorkspace, ["../hub", "Side project"]).ok).toBe(false);
    expect(parseRequest(IPC.cloudInvites, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "admin" }]).ok).toBe(true);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "owner" }]).ok).toBe(false);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "member", url: "https://evil.example" }]).ok).toBe(false);
    expect(parseRequest(IPC.cloudRevokeInvite, ["hub", "inv_0123456789"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudRevokeInvite, ["hub", "../../pair"]).ok).toBe(false);
  });
});
