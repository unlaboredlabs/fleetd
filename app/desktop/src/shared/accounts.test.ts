import { describe, expect, it } from "vitest";
import { cloudDomain, inCloud, madeTeam, readAccepted, readSignIn, teamOrigin } from "./accounts";

const TEAM = { id: "team_1", name: "acme", url: "https://acme.fleetd.dev", pairingCode: "ABCD-2345" };
const INVITATION = { name: "side", invitedBy: "eve@other.example", role: "admin", accept: "a".repeat(24) };

describe("the accounts service's answers", () => {
  it("reads the sign-in's teams, and its invitations apart, with no pairing code on them", () => {
    expect(readSignIn({ email: "sam@acme.example", sessionId: "s1", teams: [TEAM], invitations: [INVITATION] })).toEqual({
      email: "sam@acme.example",
      sessionId: "s1",
      teams: [TEAM],
      invitations: [INVITATION],
    });
    // An invitation that carries a pairing code is still only an invitation: the code isn't read.
    expect(readSignIn({ email: "sam@acme.example", sessionId: "s1", teams: [], invitations: [{ ...INVITATION, pairingCode: "ABCD-2345" }] })?.invitations).toEqual([INVITATION]);
  });

  it("reads an answer without invitations as none, and no team with one invitation as a question to ask", () => {
    expect(readSignIn({ email: "sam@acme.example", sessionId: "s1", teams: [TEAM] })?.invitations).toEqual([]);
    expect(readSignIn({ email: "new@acme.example", sessionId: "s1", teams: [], invitations: [INVITATION] })).toMatchObject({ teams: [], invitations: [INVITATION] });
  });

  it("leaves out an invitation it can't trust and keeps the rest, so one bad invitation never stops a sign-in", () => {
    const base = { email: "sam@acme.example", sessionId: "s1", teams: [TEAM] };
    const bad = [{ ...INVITATION, accept: "short" }, { ...INVITATION, invitedBy: "" }, { ...INVITATION, role: "r".repeat(33) }, "nope"];
    expect(readSignIn({ ...base, invitations: [...bad, INVITATION] })?.invitations).toEqual([INVITATION]);
    expect(readSignIn({ ...base, invitations: bad })).toMatchObject({ teams: [TEAM], invitations: [] });
  });

  it("reads whether the person made each team, and an older answer without it by how the team was joined", () => {
    expect(readSignIn({ email: "sam@acme.example", sessionId: "s1", teams: [{ ...TEAM, made: true }, { ...TEAM, made: false }, { ...TEAM, made: "yes" }] })?.teams.map((t) => t.made)).toEqual([true, false, undefined]);
    expect(readAccepted({ team: { ...TEAM, made: false } })?.made).toBe(false);
    expect([madeTeam({ made: true }, true), madeTeam({ made: false }, false), madeTeam({}, false), madeTeam({}, true)]).toEqual([true, false, true, false]);
  });

  it("refuses an answer it can't trust: a bad code, too many teams", () => {
    const base = { email: "sam@acme.example", sessionId: "s1", teams: [TEAM] };
    expect(readSignIn({ ...base, invitations: {} })).toBeNull();
    expect(readSignIn({ ...base, teams: [{ ...TEAM, pairingCode: "nope" }] })).toBeNull();
    expect(readSignIn({ ...base, teams: Array.from({ length: 51 }, () => TEAM) })).toBeNull();
    expect(readSignIn(null)).toBeNull();
  });

  it("reads the accept's answer as one team entry, the sign-in's shape", () => {
    expect(readAccepted({ team: TEAM })).toEqual(TEAM);
    expect(readAccepted({ team: { ...TEAM, pairingCode: "ABCD-2345-WXYZ-6789" } })?.pairingCode).toBe("ABCD-2345-WXYZ-6789");
    expect(readAccepted(TEAM)).toBeNull();
    expect(readAccepted({ team: { ...TEAM, url: "" } })).toBeNull();
  });
});

describe("which addresses are fleetd cloud's", () => {
  const ACCOUNTS = "https://accounts.fleetd.dev";

  it("takes a team address only under the accounts host's parent domain", () => {
    expect(cloudDomain(ACCOUNTS)).toBe("fleetd.dev");
    expect(teamOrigin("https://acme.fleetd.dev", ACCOUNTS, false)).toBe("https://acme.fleetd.dev");
    expect(teamOrigin("https://Acme.fleetd.dev/", ACCOUNTS, false)).toBe("https://acme.fleetd.dev");
    for (const url of [
      "https://acme.fleetd.dev.evil.example",
      "https://evilfleetd.dev",
      "https://fleetd.dev",
      "https://acme.example",
      "http://acme.fleetd.dev",
      "https://acme.fleetd.dev/x",
      "https://u@acme.fleetd.dev",
      "https://acme.fleetd.dev/?x=1",
    ]) {
      expect(teamOrigin(url, ACCOUNTS, false), url).toBeNull();
    }
  });

  it("keeps the local stand-in's exception: http on 127.0.0.1, in a local build only", () => {
    expect(teamOrigin("http://127.0.0.1:4790", "http://127.0.0.1:9", true)).toBe("http://127.0.0.1:4790");
    expect(teamOrigin("http://127.0.0.1:4790", ACCOUNTS, false)).toBeNull();
    expect(teamOrigin("http://10.0.0.1", ACCOUNTS, true)).toBeNull();
  });

  it("says a hub is a cloud team when its host is under the cloud's domain", () => {
    expect(inCloud("https://security.fleetd.dev", ACCOUNTS)).toBe(true);
    expect(inCloud("https://hub.example:4790", ACCOUNTS)).toBe(false);
    expect(inCloud("https://fleetd.dev.example", ACCOUNTS)).toBe(false);
    expect(inCloud("http://127.0.0.1:4790", "http://127.0.0.1:9")).toBe(false);
  });
});
