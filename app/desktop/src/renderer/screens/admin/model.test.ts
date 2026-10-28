import { describe, expect, it } from "vitest";
import type { AgentKeyInfo, Invite, Person, PersonClaude } from "../../../shared/contracts";
import { accountsLine, administers, devicesLine, expiresLine, nameProblem, openInvites, peopleRows } from "./model";

const AT = "2026-10-19T10:00:00.000Z";
const person = (personId: string, name: string, role: Person["role"]): Person => ({ personId, name, role, createdAt: AT });
const sam = person("p_aaaaaaaa", "Sam", "owner");
const alice = person("p_bbbbbbbb", "Alice", "admin");
const bob = person("p_cccccccc", "Bob", "member");
const dana = person("p_dddddddd", "Dana", "member");
const device = (keyId: string, name: string, p: Person): AgentKeyInfo => ({
  keyId,
  name,
  prefix: keyId,
  kind: "human",
  grants: [{ role: "admin", machines: "*" }],
  createdAt: AT,
  person: { personId: p.personId, name: p.name },
});
const invite = (inviteId: string, p: Person, state: Invite["state"], createdAt = AT): Invite => ({
  inviteId,
  person: { personId: p.personId, name: p.name },
  state,
  createdAt,
  expiresAt: "2026-10-26T10:00:00.000Z",
});
const list = {
  people: [sam, alice, bob, dana, { ...person("p_eeeeeeee", "Gone", "member"), removedAt: AT }],
  devices: [device("k1", "MacBook", sam), device("k2", "Pixel", sam), device("k3", "ThinkPad", alice), device("k4", "iMac", bob)],
  invites: [invite("inv_aaaaaaaa", dana, "open")],
};

describe("who sees Administration", () => {
  it("is an owner or admin whose device isn't capped below admin", () => {
    expect(administers({ me: sam, admin: true })).toBe(true);
    expect(administers({ me: alice, admin: true })).toBe(true);
    expect(administers({ me: bob, admin: false })).toBe(false);
    // An admin's read-only wall display.
    expect(administers({ me: alice, admin: false })).toBe(false);
  });

  it("falls back to the key's own admin grant on a hub from before people, to yes on one too old to say, and to no until hub_info answers", () => {
    expect(administers({ admin: true })).toBe(true);
    expect(administers({ admin: false })).toBe(false);
    expect(administers({})).toBe(true);
    expect(administers(undefined)).toBe(false);
  });
});

describe("People's rows", () => {
  it("lists everyone not removed with their devices, and marks you and who hasn't joined", () => {
    const rows = peopleRows(list, sam);
    expect(rows.map((r) => r.person.name)).toEqual(["Sam", "Alice", "Bob", "Dana"]);
    expect(rows[0]?.devices.map((d) => d.name)).toEqual(["MacBook", "Pixel"]);
    expect(rows[0]?.you).toBe(true);
    expect(rows[3]?.invited).toBe(true);
    expect(rows[2]?.invited).toBe(false);
  });

  it("lets an owner set any role and remove anyone but themselves", () => {
    const rows = peopleRows(list, sam);
    expect(rows[0]).toMatchObject({ roles: [], removable: false });
    expect(rows[1]).toMatchObject({ roles: ["owner", "admin", "member"], removable: true });
    expect(rows[2]).toMatchObject({ roles: ["owner", "admin", "member"], removable: true });
  });

  it("never lets an admin change or remove an owner, or make one", () => {
    const rows = peopleRows(list, alice);
    expect(rows[0]).toMatchObject({ roles: [], removable: false, why: "Only an owner changes an owner." });
    expect(rows[1]).toMatchObject({ roles: [], removable: false, you: true });
    expect(rows[2]).toMatchObject({ roles: ["admin", "member"], removable: true });
  });

  it("offers a member nothing", () => {
    for (const row of peopleRows(list, bob)) expect(row).toMatchObject({ roles: [], removable: false });
  });
});

describe("invites and words", () => {
  it("keeps the open invites, newest first", () => {
    const old = invite("inv_bbbbbbbb", bob, "open", "2026-10-18T10:00:00.000Z");
    const used = invite("inv_cccccccc", alice, "used");
    expect(openInvites([old, used, ...list.invites]).map((i) => i.inviteId)).toEqual(["inv_aaaaaaaa", "inv_bbbbbbbb"]);
  });

  it("says when an invite runs out", () => {
    const now = Date.parse(AT);
    expect(expiresLine("2026-10-26T10:00:00.000Z", now)).toBe("Expires in 7 days");
    expect(expiresLine("2026-10-19T15:30:00.000Z", now)).toBe("Expires in 5 h");
    expect(expiresLine("2026-10-19T10:20:00.000Z", now)).toBe("Expires within the hour");
    expect(expiresLine("2026-10-19T09:00:00.000Z", now)).toBe("Expired");
  });

  it("counts devices and checks a name the hub takes", () => {
    expect(devicesLine(0)).toBe("No device yet");
    expect(devicesLine(1)).toBe("1 device");
    expect(devicesLine(3)).toBe("3 devices");
    expect(nameProblem("  ")).toBe("Give them a name.");
    expect(nameProblem("x".repeat(81))).toBe("80 characters at most.");
    expect(nameProblem(" Dana ")).toBeUndefined();
  });
});

describe("a person's accounts on People", () => {
  const claude = (runsOn: PersonClaude["runsOn"], lastOk?: boolean): PersonClaude => ({
    person: { personId: "p_cccccccc", name: "Bob" },
    mayUseHubApi: true,
    runsOn,
    ...(lastOk === undefined ? {} : { subscription: { sealedOn: [], connectedAt: "2026-10-19T10:00:00.000Z", lastTest: { at: "2026-10-19T10:00:00.000Z", machineId: "devbox", ok: lastOk } } }),
  });
  const own = { kind: "account", account: { kind: "person", personId: "p_cccccccc" } } as PersonClaude["runsOn"];
  it("says what their Claude runs on and their GitHub, leaving out what the hub doesn't say", () => {
    const login = { login: "bob", userId: 2, connectedAt: "2026-10-19T10:00:00.000Z" };
    expect(accountsLine(claude(own), { account: login }, true)).toBe("Claude: Own subscription · GitHub: bob");
    expect(accountsLine(claude(own, false), {}, true)).toBe("Claude: Own subscription, its last Test failed · GitHub: not connected");
    expect(accountsLine(claude(own), { account: { ...login, lapsed: true } }, true)).toBe("Claude: Own subscription · GitHub: bob, to connect again");
    // No GitHub App: no GitHub part. An older hub: no Claude part.
    expect(accountsLine(claude({ kind: "machine_login" }), {}, false)).toBe("Claude: Machine's own login");
    expect(accountsLine(undefined, undefined, true)).toBeNull();
  });
});
