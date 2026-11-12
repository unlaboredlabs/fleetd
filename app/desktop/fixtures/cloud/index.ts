// fleetd cloud's Sign in, on a build that has it (src/main/cloud/fixture.ts reads each fixture's `cloud` section):
// the first screen's two ways in, the wait for the browser and how a sign-in fails; Connect a computer on a team with
// no machine yet; the account's row in Settings; and People on a team, where owners and admins invite by email. Without
// a `cloud` section every other fixture is today's app.
import { alice, answerHub, bob, sam } from "../admin/index.ts";
import { Fixture, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";

const TEAM = "https://acme.fleetd.dev";
const EMAIL = "sam@example.com";

const unpaired = (name: string, note: string, cloud: JsonObject): Fixture => {
  const f = new Fixture(`cloud-${name}`, note);
  f.state = { phase: "unpaired" };
  f.cloud = cloud;
  return f;
};

/** A team of fleetd cloud just signed in to: no machine yet, its person an owner. */
const team = (base: Fixture, name: string, note: string, cloud: JsonObject): Fixture => {
  const f = Fixture.from(base, `cloud-${name}`, note);
  f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
  f.label = "acme";
  f.cloud = { email: EMAIL, hub: true, ...cloud };
  if (f.snapshot !== undefined) f.snapshot = { ...f.snapshot, machines: [] };
  f.live = f.live.map((l) => ({ ...l, machines: [] }));
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
  f.answer("machine_join", undefined, {
    hubUrl: TEAM,
    code: "fje_7QmK2xVd9LpR4sNw",
    expiresAt: "2026-10-19T09:16:00Z",
    line: `curl -fsSL https://fleetd.sh | sh -s -- --join ${TEAM} --code fje_7QmK2xVd9LpR4sNw`,
    next: "Run the line on the computer: it installs fleetd and joins under the computer's own name.",
  });
  return f;
};

/** Two invites by email waiting on the team: Kai's as a member, Lee's as an admin, newest first. */
const INVITES: JsonObject[] = [
  { inviteId: "inv_2b7c90d1e4", email: "lee@example.com", role: "admin", createdAt: "2026-10-18T15:40:00.000Z", expiresAt: "2026-10-25T15:40:00.000Z" },
  { inviteId: "inv_0a91f3c2b8", email: "kai@example.com", role: "member", createdAt: "2026-10-14T09:10:00.000Z", expiresAt: "2026-10-21T09:10:00.000Z" },
];

/** Settings › Hub › People on the team acme, as `me`, with its invites by email. */
const people = (base: Fixture, name: string, note: string, me: JsonObject, cloud: JsonObject = {}): Fixture => {
  const f = answerHub(Fixture.from(base, `cloud-people-${name}`, note), me, me !== bob);
  f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
  f.label = "acme";
  f.cloud = { email: EMAIL, hub: true, invites: INVITES, ...cloud };
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    unpaired("first-screen", "First launch on a build with fleetd cloud: Sign in, and Use your own hub under it.", {}),
    unpaired("sign-in-refused", "Sign in came back from the browser without signing in.", {
      signIn: { failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } },
    }),
    unpaired("sign-in-timeout", "The sign-in page was left unfinished and ran out.", {
      signIn: { failure: { code: "timeout", message: "The sign-in page wasn't finished, so it ran out after 10 minutes." } },
    }),
    team(base("empty"), "connect", "Signed in, the team has no machine: Connect a computer, and a terminal opens.", { terminal: "a terminal" }),
    team(base("empty"), "connect-no-terminal", "Connect a computer where no terminal opens: the line is the way.", {}),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account", "Settings with a fleetd account signed in, and its team acme.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = { email: EMAIL, hub: true };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
    people(base("chat-empty"), "owner", "People on a cloud team, as its owner: Invite by email, and two invites waiting.", sam),
    people(base("chat-empty"), "admin", "People on a cloud team, as an admin: the same field and list.", alice),
    people(base("chat-empty"), "member", "A member of a cloud team: no People page, so no field and no invites.", bob),
    people(base("chat-empty"), "limit", "People on a cloud team at its limit of people: the invite is refused by the field.", sam, {
      inviteFailure: { code: "failed", message: "This team has reached its limit of people (50).", fix: "Remove one first, or ask fleetd's operator for a higher limit." },
    }),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-signed-out", "Settings on a build with fleetd cloud, not signed in.");
      f.cloud = {};
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
  ],
});
