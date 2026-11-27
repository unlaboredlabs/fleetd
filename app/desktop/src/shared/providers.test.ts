import { describe, expect, it } from "vitest";
import { atOnceWord, computerStateWord, MAC_OWN_ONLY, providedChoices, providedValue } from "./provided";
import { canWords, keptRunning, KINDS, linuxChoices, linuxValue, machinesRun, ordered, PROVIDERS, RUNNER_ID, SCREEN_KINDS, serves, specOf } from "./providers";

describe("the providers, as one model", () => {
  it("says what each runs, so each group lists the ones that serve it", () => {
    const agents = PROVIDERS.filter((p) => serves(p, ["agents"])).map((p) => p.name);
    const screens = PROVIDERS.filter((p) => serves(p, SCREEN_KINDS)).map((p) => p.name);
    expect(agents).toEqual(["fleetd's computers"]);
    expect(screens).toEqual(["fleetd's computers"]);
    // One that does both is in each.
    const both = { id: "x", name: "X", can: ["agents", "mac"] as const };
    expect(serves(both, ["agents"]) && serves(both, SCREEN_KINDS)).toBe(true);
  });

  it("names one a newer hub has by its id, as a provider of agents, after the ones it knows", () => {
    expect(specOf("modal")).toEqual({ id: "modal", name: "modal", can: ["agents"] });
    expect(ordered(["modal", "boat"])).toEqual(["boat", "modal"]);
  });
});

describe("a share link's computer", () => {
  it("says a link on fleetd's computers keeps its computer running, and one on the team's own machine says nothing", () => {
    expect(keptRunning(RUNNER_ID)).toBe("Its computer keeps running, and uses computer time, while the link is open.");
    expect(keptRunning("devbox")).toBeUndefined();
  });
});

describe("what runs where", () => {
  it("lists every kind once, and says what each provider runs beside its name", () => {
    expect(KINDS).toEqual(["agents", "browser", "desktop", "android", "ios", "mac"]);
    expect(canWords(specOf("boat"))).toBe("Agents · Browser · Linux desktop · Android");
  });

  it("knows which kinds the team's own machines run now", () => {
    const linux = {
      roles: ["agents", "sessions"],
      hosts: [{ host: "browser", ready: true }, { host: "android", ready: false, off: "unsupported" }, { host: "desktop", ready: false, off: "missing" }, { host: "mac", ready: false, off: "unsupported" }],
    };
    const mac = { roles: [], mac: { on: true }, hosts: [{ host: "mac", ready: true }] };
    expect(machinesRun("agents", [linux])).toBe(true);
    expect(machinesRun("agents", [mac])).toBe(false);
    expect(machinesRun("browser", [linux])).toBe(true);
    // No KVM: it can't run Android at all. A desktop missing Xvfb runs once it is installed.
    expect(machinesRun("android", [linux])).toBe(false);
    expect(machinesRun("desktop", [linux])).toBe(true);
    expect(machinesRun("mac", [linux])).toBe(false);
    expect(machinesRun("ios", [linux])).toBe(false);
    expect(machinesRun("ios", [linux, mac])).toBe(true);
    expect(machinesRun("mac", [linux, mac])).toBe(true);
  });
});

describe("the Linux machine", () => {
  const p = (provider: string, connected: boolean) => ({ provider, connected });

  it("is a pick with a machine and a provider: machines, machines first, or the provider only", () => {
    expect(linuxChoices([p("boat", true)], true)).toEqual([
      { value: "ours_only", label: "Your machines" },
      { value: "ours_first", label: "Your machines first, then fleetd's computers" },
      { value: "boat", label: "fleetd's computers only" },
    ]);
  });

  it("is a plain value with nothing to choose: machines alone, one provider alone, or none yet", () => {
    expect(linuxChoices([p("boat", false)], true)).toEqual([{ value: "ours_only", label: "Your machines" }]);
    expect(linuxChoices([p("boat", true)], false)).toEqual([{ value: "ours_first", label: "fleetd's computers" }]);
    expect(linuxChoices([p("boat", false)], false)).toEqual([]);
    expect(linuxValue([p("boat", false)], false)).toBe("None yet");
    expect(linuxValue([p("boat", true)], false)).toBe("fleetd's computers");
    expect(linuxValue([], true)).toBe("Your machines");
  });

  it("keeps the pick in effect listed when it no longer is one, so it can be moved off", () => {
    // boat.dev only, then disconnected: still shown, beside what can be picked now.
    expect(linuxChoices([p("boat", false)], true, "boat")).toEqual([
      { value: "ours_only", label: "Your machines" },
      { value: "boat", label: "fleetd's computers only" },
    ]);
    // Your machines only, and the last machine went.
    expect(linuxChoices([p("boat", true)], false, "ours_only")).toEqual([
      { value: "boat", label: "fleetd's computers only" },
      { value: "ours_only", label: "Your machines" },
    ]);
  });
});

describe("fleetd's computers, on a fleetd cloud team", () => {
  it("offers the team's own machines and fleetd's computers, never a provider's name", () => {
    expect(providedChoices("boat", true)).toEqual([
      { value: "ours_only", label: "Your machines" },
      { value: "ours_first", label: "Your machines first, then fleetd's computers" },
      { value: "boat", label: "fleetd's computers only" },
    ]);
    // With no machine of the team's that runs agents, fleetd's computers alone: a value, not a choice.
    expect(providedChoices("boat", false)).toEqual([{ value: "boat", label: "fleetd's computers" }]);
  });

  it("says where bots run when the cloud doesn't answer the pick yet, and that Macs are the team's own", () => {
    expect(providedValue(false)).toBe("fleetd's computers");
    expect(providedValue(true)).toBe("Your machines and fleetd's computers");
    expect(MAC_OWN_ONLY).toBe("fleetd's computers don't run Macs");
  });

  it("counts what runs at once of what the plan allows, and nothing while it holds them", () => {
    expect(atOnceWord([{ limit: 3, running: 1 }])).toBe("1 of 3 at once");
    expect(atOnceWord([{ limit: 10 }])).toBe("0 of 10 at once");
    expect(atOnceWord([{ limit: 0, running: 0 }])).toBeNull();
    expect(atOnceWord([])).toBeNull();
  });

  it("says a bot's computer asleep or awake, with its agents at work", () => {
    expect(computerStateWord(true)).toBe("Asleep");
    expect(computerStateWord(false, 0)).toBe("Awake");
    expect(computerStateWord(false, 1)).toBe("Awake · 1 agent");
    expect(computerStateWord(true, 2)).toBe("Asleep · 2 agents");
  });
});
