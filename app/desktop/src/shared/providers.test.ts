import { describe, expect, it } from "vitest";
import { agentsWhere, canWords, KINDS, machinesRun, ordered, PROVIDERS, SCREEN_KINDS, serves, specOf } from "./providers";

describe("the providers, as one model", () => {
  it("says what each runs, so each group lists the ones that serve it", () => {
    const agents = PROVIDERS.filter((p) => serves(p, ["agents"])).map((p) => p.name);
    const screens = PROVIDERS.filter((p) => serves(p, SCREEN_KINDS)).map((p) => p.name);
    expect(agents).toEqual(["E2B", "boat.dev", "Daytona"]);
    expect(screens).toEqual([]);
    // One that does both is in each.
    const both = { id: "x", name: "X", can: ["agents", "mac"] as const };
    expect(serves(both, ["agents"]) && serves(both, SCREEN_KINDS)).toBe(true);
  });

  it("names one a newer hub has by its id, as a provider of agents, after the ones it knows", () => {
    expect(specOf("modal")).toEqual({ id: "modal", name: "modal", can: ["agents"] });
    expect(ordered(["modal", "daytona", "e2b"])).toEqual(["e2b", "daytona", "modal"]);
  });
});

describe("what runs where", () => {
  it("lists every kind once, and says what each provider runs beside its name", () => {
    expect(KINDS).toEqual(["agents", "browser", "desktop", "android", "ios", "mac"]);
    expect(canWords(specOf("e2b"))).toBe("Agents");
  });

  it("says where agents go: the machines, then each connected provider with room, in order", () => {
    const p = (provider: string, connected: boolean, limit: number) => ({ provider, connected, limit });
    expect(agentsWhere([])).toBe("Your machines");
    expect(agentsWhere([p("e2b", false, 0), p("boat", false, 0)])).toBe("Your machines");
    expect(agentsWhere([p("daytona", true, 5), p("boat", true, 0), p("e2b", true, 20)])).toBe("Your machines first, then E2B, then Daytona");
    // No machine of the team's: the providers alone, and with none connected either, none yet.
    expect(agentsWhere([p("daytona", true, 5), p("e2b", true, 20)], false)).toBe("E2B, then Daytona");
    expect(agentsWhere([p("e2b", true, 2)], false)).toBe("E2B");
    expect(agentsWhere([p("e2b", false, 0)], false)).toBe("None yet");
    expect(agentsWhere([], false)).toBe("None yet");
  });

  it("knows which kinds the team's own machines run now", () => {
    const linux = { roles: ["agents", "sessions"], hosts: [{ host: "browser", ready: true }, { host: "android", ready: false, on: false }, { host: "desktop", ready: false, on: true }] };
    const mac = { roles: [], mac: { on: true }, hosts: [{ host: "mac", ready: true }] };
    expect(machinesRun("agents", [linux])).toBe(true);
    expect(machinesRun("agents", [mac])).toBe(false);
    expect(machinesRun("browser", [linux])).toBe(true);
    expect(machinesRun("android", [linux])).toBe(false);
    expect(machinesRun("desktop", [linux])).toBe(true);
    expect(machinesRun("ios", [linux])).toBe(false);
    expect(machinesRun("ios", [linux, mac])).toBe(true);
    expect(machinesRun("mac", [linux, mac])).toBe(true);
  });
});
