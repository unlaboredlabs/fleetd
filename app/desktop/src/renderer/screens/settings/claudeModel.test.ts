// Which Claude account work runs on, in words: whose an account is, what a person's radio shows when they never
// chose, where a secret is sealed, and a pause on one account only.
import { describe, expect, it } from "vitest";
import type { PersonClaude, UsageStatus } from "../../../shared/contracts";
import { accountWords, boxesOf, missingOn, pauseLine, runsOnLine, sealedLine, shownChoice, testLine, theirRunsOn } from "./claudeModel";

const bob = { personId: "p_cccccccc", name: "Bob Okafor" };
const sam = { personId: "p_aaaaaaaa", name: "Sam Rivera" };
const on = (machineId: string) => ({ machineId, fingerprint: "ab12cd34" });

describe("Claude accounts in words", () => {
  it("names an account by whose it is, never by its secret", () => {
    expect(accountWords({ kind: "hub" }, [])).toBe("the workspace's API key");
    expect(accountWords({ kind: "person", personId: sam.personId }, [sam, bob], bob.personId)).toBe("Sam Rivera's subscription");
    expect(accountWords({ kind: "person", personId: bob.personId }, [sam, bob], bob.personId)).toBe("your subscription");
    expect(runsOnLine({ kind: "machine_login" }, [])).toBe("Each machine's own Claude login.");
    // A team with no machine of its own (a fleetd cloud team before its first computer): a machine's login is nothing.
    expect(runsOnLine({ kind: "machine_login" }, [], undefined, true)).toBe("Not connected.");
    expect(theirRunsOn({ kind: "machine_login" }, true)).toBe("Not connected");
    expect(runsOnLine({ kind: "account", account: { kind: "person", personId: sam.personId } }, [sam])).toBe("Sam Rivera's subscription.");
    expect(theirRunsOn({ kind: "refused", message: "Connect your Claude to start this order.", fix: "" })).toBe("Nothing to run on");
  });

  it("shows the radio the default lands on when the person never chose", () => {
    const me = (p: Partial<PersonClaude>): PersonClaude => ({ person: bob, mayUseHubApi: true, runsOn: { kind: "machine_login" }, ...p });
    expect(shownChoice(me({ runsOn: { kind: "account", account: { kind: "hub" } } }))).toBe("hub_api");
    expect(shownChoice(me({ runsOn: { kind: "account", account: { kind: "person", personId: bob.personId } } }))).toBe("subscription");
    expect(shownChoice(me({ choice: "hub_api", runsOn: { kind: "refused", message: "", fix: "" } }))).toBe("hub_api");
    expect(shownChoice(me({}))).toBeUndefined();
  });

  it("says where a secret is sealed and which machines lack it, sealing only to machines with a box key", () => {
    expect(sealedLine([on("devbox")])).toBe("Sealed on devbox.");
    expect(sealedLine([on("devbox"), on("buildbox"), on("mac")])).toBe("Sealed on buildbox, devbox and mac.");
    expect(missingOn([on("devbox")], ["devbox", "buildbox"])).toEqual(["buildbox"]);
    expect(boxesOf({ devbox: { machineId: "devbox", boxPubKey: "K=" }, old: { machineId: "old" } })).toEqual([{ machineId: "devbox", boxPubKey: "K=" }]);
  });

  it("says an account's pause on each machine, and none for another account", () => {
    const usage: UsageStatus[] = [
      {
        machineId: "devbox",
        login: "subscription",
        breaker: { state: "open", message: "The machine's own limit." },
        parked: { leads: 0, tasks: 0 },
        accounts: [{ account: { kind: "hub" }, breaker: { state: "open", message: "Rate limited." }, parked: { leads: 1, tasks: 0 } }],
        lastEvents: [],
      },
    ];
    expect(pauseLine({ kind: "hub" }, usage, 0)).toBe("Paused on devbox: Rate limited.");
    expect(pauseLine({ kind: "person", personId: bob.personId }, usage, 0)).toBeNull();
  });
});

describe("on fleetd's computers", () => {
  it("names the hosted runner as fleetd's computers, never its id", () => {
    expect(sealedLine([{ machineId: "hosted" } as never])).toBe("Sealed on fleetd's computers.");
    expect(testLine({ at: "2026-10-27T12:14:00.000Z", machineId: "hosted", ok: true }, Date.parse("2026-10-27T12:20:00.000Z")).text).toMatch(/^Worked on fleetd's computers, /u);
    expect(sealedLine([{ machineId: "devbox" } as never])).toBe("Sealed on devbox.");
  });
});

describe("a cloud team's words", () => {
  it("calls the shared key the team's", () => {
    const team = { kind: "account", account: { kind: "hub" } } as const;
    expect(runsOnLine(team, [], undefined, false)).toBe("The workspace's API key.");
    expect(theirRunsOn(team, false)).toBe("Workspace API key");
    expect(runsOnLine(team, [])).toBe("The workspace's API key.");
  });
});
