// Members find nothing of the Hub group in Settings' search: the machine caps, machine roles, task profiles
// and the hub's accounts are its pages, which only owners and admins see (D211).
import { describe, expect, it, vi } from "vitest";
import { isHubTab } from "../shell/routes";
import { optionsFor, searchSettings } from "./search";

vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

describe("Settings' search for a member", () => {
  it("offers no Hub page or option", () => {
    expect(optionsFor(false).some((o) => isHubTab(o.tab))).toBe(false);
    for (const q of ["machine cap", "max agents", "machine roles", "people", "invite", "github app", "setup"]) {
      expect(searchSettings(q, optionsFor(false)).filter((o) => isHubTab(o.tab)), q).toEqual([]);
    }
  });

  it("offers an owner or admin every Hub page, and what was a page once on the page that holds it", () => {
    const pages = new Set(optionsFor(true).filter((o) => isHubTab(o.tab)).map((o) => o.tab));
    expect([...pages].sort()).toEqual(["hub.accounts", "hub.instructions", "hub.machines", "hub.people", "hub.profiles", "hub.setup", "hub.vault"]);
    const at = (key: string) => optionsFor(true).find((o) => o.key === key)?.tab;
    expect([at("hub.updates"), at("hub.tools"), at("hub.mcp"), at("hub.skills")]).toEqual(["hub.machines", "hub.profiles", "hub.profiles", "hub.profiles"]);
  });
});
