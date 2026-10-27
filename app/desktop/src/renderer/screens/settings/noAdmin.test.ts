// Settings is everyone's: nothing hub-wide lives in it. The fleet and machine caps, machine roles, task profiles and
// memory caps are on Administration, which only owners and admins see.
import { describe, expect, it, vi } from "vitest";
import { SETTINGS_TABS } from "../shell/routes";
import { OPTIONS, PAGE_LABEL } from "./search";

vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

describe("Settings without admin controls", () => {
  it("has no Machines page", () => {
    expect(SETTINGS_TABS).not.toContain("machines");
    expect(Object.values(PAGE_LABEL)).not.toContain("Machines");
  });

  it("offers no hub-wide option in its search", () => {
    const words = OPTIONS.flatMap((o) => [o.label, ...(o.keywords ?? [])]).map((w) => w.toLowerCase());
    for (const admin of ["whole fleet", "fleet cap", "machine cap", "machine roles", "memory caps", "admin"]) {
      expect(words).not.toContain(admin);
    }
  });
});
