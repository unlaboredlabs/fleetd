// Members find nothing of the Hub group in Settings' search: the fleet and machine caps, machine roles, task profiles,
// memory caps and the hub's accounts are its pages, which only owners and admins see (D211).
import { describe, expect, it, vi } from "vitest";
import { isHubTab } from "../shell/routes";
import { optionsFor, searchSettings } from "./search";

vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

describe("Settings' search for a member", () => {
  it("offers no Hub page or option", () => {
    expect(optionsFor(false).some((o) => isHubTab(o.tab))).toBe(false);
    for (const q of ["whole fleet", "fleet cap", "machine roles", "memory caps", "people", "invite", "github app", "google client", "setup"]) {
      expect(searchSettings(q, optionsFor(false)).filter((o) => isHubTab(o.tab)), q).toEqual([]);
    }
  });

  it("offers an owner or admin every Hub page", () => {
    const pages = new Set(optionsFor(true).filter((o) => isHubTab(o.tab)).map((o) => o.tab));
    expect([...pages].sort()).toEqual(["hub.accounts", "hub.instructions", "hub.machines", "hub.people", "hub.profiles", "hub.prompts", "hub.setup", "hub.tools"]);
  });
});
