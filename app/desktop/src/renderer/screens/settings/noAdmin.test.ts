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
    for (const q of ["machine cap", "max agents", "machine roles", "people", "invite", "github app", "workspace accounts", "claude api key", "setup"]) {
      expect(searchSettings(q, optionsFor(false)).filter((o) => isHubTab(o.tab)), q).toEqual([]);
    }
  });

  it("offers an owner or admin every Hub page, and what was a page once on the page that holds it", () => {
    const pages = new Set(optionsFor(true).filter((o) => isHubTab(o.tab)).map((o) => o.tab));
    expect([...pages].sort()).toEqual(["hub.agents", "hub.audit", "hub.instructions", "hub.machines", "hub.people", "hub.providers", "hub.setup", "hub.share", "hub.usage", "hub.vault"]);
    const at = (key: string) => optionsFor(true).find((o) => o.key === key)?.tab;
    expect([at("hub.updates"), at("hub.tools"), at("hub.skills")]).toEqual(["hub.machines", "hub.agents", "hub.agents"]);
    expect([at("hub.accounts"), at("admin.claude"), at("admin.claude.members"), at("admin.github")]).toEqual(["hub.setup", "hub.setup", "hub.setup", "hub.setup"]);
  });

  it("offers Billing only on a fleetd cloud team, so a self-hosted hub never names it", () => {
    for (const q of ["billing", "credits", "spend cap"]) expect(searchSettings(q, optionsFor(true)).filter((o) => o.tab === "hub.billing"), q).toEqual([]);
    expect(searchSettings("credits", optionsFor(true, true, true))[0]?.tab).toBe("hub.billing");
    expect(optionsFor(false, true, true).some((o) => o.tab === "hub.billing")).toBe(false);
  });

  it("finds Sign-in only on a fleetd cloud workspace, and a bot's spend limit only where Billing is", () => {
    expect(searchSettings("google only", optionsFor(true, true, false, true, false)).map((o) => o.tab)).not.toContain("hub.signin");
    expect(searchSettings("google only", optionsFor(true, true, false, true, true))[0]?.tab).toBe("hub.signin");
    expect(optionsFor(false, true, false, true, true).some((o) => o.tab === "hub.signin")).toBe(false);
    expect(searchSettings("spend limit", optionsFor(true, true, false)).map((o) => o.key)).not.toContain("projects.limit");
    expect(searchSettings("spend limit", optionsFor(true, true, true)).map((o) => o.key)).toContain("projects.limit");
  });
});
