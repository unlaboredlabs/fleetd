import { describe, expect, it } from "vitest";
import { canWords, KINDS, linuxChoices, linuxValue, machinesRun, ordered, PROVIDERS, SCREEN_KINDS, serves, specOf } from "./providers";

describe("the providers, as one model", () => {
  it("says what each runs, so each group lists the ones that serve it", () => {
    const agents = PROVIDERS.filter((p) => serves(p, ["agents"])).map((p) => p.name);
    const screens = PROVIDERS.filter((p) => serves(p, SCREEN_KINDS)).map((p) => p.name);
    expect(agents).toEqual(["boat.dev"]);
    expect(screens).toEqual(["boat.dev"]);
    // One that does both is in each.
    const both = { id: "x", name: "X", can: ["agents", "mac"] as const };
    expect(serves(both, ["agents"]) && serves(both, SCREEN_KINDS)).toBe(true);
  });

  it("names one a newer hub has by its id, as a provider of agents, after the ones it knows", () => {
    expect(specOf("modal")).toEqual({ id: "modal", name: "modal", can: ["agents"] });
    expect(ordered(["modal", "boat"])).toEqual(["boat", "modal"]);
  });
});

describe("what runs where", () => {
  it("lists every kind once, and says what each provider runs beside its name", () => {
    expect(KINDS).toEqual(["agents", "browser", "desktop", "android", "ios", "mac"]);
    expect(canWords(specOf("boat"))).toBe("Agents · Browser · Linux desktop");
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

describe("the Linux machine", () => {
  const p = (provider: string, connected: boolean) => ({ provider, connected });

  it("is a pick with a machine and a provider: machines, machines first, or the provider only", () => {
    expect(linuxChoices([p("boat", true)], true)).toEqual([
      { value: "ours_only", label: "Your machines" },
      { value: "ours_first", label: "Your machines first, then boat.dev" },
      { value: "boat", label: "boat.dev only" },
    ]);
  });

  it("is a plain value with nothing to choose: machines alone, one provider alone, or none yet", () => {
    expect(linuxChoices([p("boat", false)], true)).toEqual([{ value: "ours_only", label: "Your machines" }]);
    expect(linuxChoices([p("boat", true)], false)).toEqual([{ value: "ours_first", label: "boat.dev" }]);
    expect(linuxChoices([p("boat", false)], false)).toEqual([]);
    expect(linuxValue([p("boat", false)], false)).toBe("None yet");
    expect(linuxValue([p("boat", true)], false)).toBe("boat.dev");
    expect(linuxValue([], true)).toBe("Your machines");
  });

  it("keeps the pick in effect listed when it no longer is one, so it can be moved off", () => {
    // boat.dev only, then disconnected: still shown, beside what can be picked now.
    expect(linuxChoices([p("boat", false)], true, "boat")).toEqual([
      { value: "ours_only", label: "Your machines" },
      { value: "boat", label: "boat.dev only" },
    ]);
    // Your machines only, and the last machine went.
    expect(linuxChoices([p("boat", true)], false, "ours_only")).toEqual([
      { value: "boat", label: "boat.dev only" },
      { value: "ours_only", label: "Your machines" },
    ]);
  });
});
