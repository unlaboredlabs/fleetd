// fleetd cloud's Sign in, on a build that has it (src/main/cloud/fixture.ts reads each fixture's `cloud` section):
// the first screen's two ways in, the wait for the browser and how a sign-in fails; Connect a computer on a team with
// no machine yet; and the account's row in Settings. Without a `cloud` section every other fixture is today's app.
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
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-signed-out", "Settings on a build with fleetd cloud, not signed in.");
      f.cloud = {};
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
  ],
});
