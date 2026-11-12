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
import { listInvites, revokeInvite, sendInvite, type KeyedTeam } from "./invites";

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

  it("asks only a hub that came with the account, with that hub's own key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invites-"));
    try {
      const keyed = (id: string, hubUrl: string, key: string) =>
        ({ id, label: "acme", service: { keyed: () => ({ url: hubUrl, key }) } as unknown as HubService }) as const;
      const cloudHub = keyed("hub", url, fake.keyFor("acme", "sam@acme.example"));
      const hubs = { cloudHubs: () => [cloudHub] } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      expect(await cloud.invite("hub", { email: "eve@example.com", role: "member" })).toMatchObject({ ok: true });
      expect(await cloud.invites("hub")).toMatchObject({ ok: true, invites: [{ email: "eve@example.com" }] });
      // A self-hosted hub (not one of the account's): refused here, the team never asked.
      expect(await cloud.invite("own", { email: "finn@example.com", role: "member" })).toEqual({
        ok: false,
        failure: { code: "", message: "That hub isn't one of your fleetd cloud teams." },
      });
      // A build without the cloud's values asks nobody.
      const off = realCloud(null, hubs, dir, true, () => Promise.resolve());
      expect(await off.invites("hub")).toMatchObject({ ok: false });
      expect(fake.sent.map((s) => s.email)).toEqual(["eve@example.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes only a hub id, an email and a role, and an invite id, from the page", () => {
    expect(parseRequest(IPC.cloudInvites, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "admin" }]).ok).toBe(true);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "owner" }]).ok).toBe(false);
    expect(parseRequest(IPC.cloudInvite, ["hub", { email: "eve@example.com", role: "member", url: "https://evil.example" }]).ok).toBe(false);
    expect(parseRequest(IPC.cloudRevokeInvite, ["hub", "inv_0123456789"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudRevokeInvite, ["hub", "../../pair"]).ok).toBe(false);
  });
});
