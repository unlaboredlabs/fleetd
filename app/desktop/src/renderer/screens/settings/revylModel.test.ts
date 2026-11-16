import { describe, expect, it } from "vitest";
import { installCommand, keyOf, REVYL_KINDS, revylLine, routeChoices, routeOffLine, usesRevyl } from "./revylModel";

const at = "2026-10-19T09:00:00.000Z";
/** The hub's own words for a missing CLI (fleetd/src/hub/revyl, shared/revyl.ts INSTALL). */
/** The same where the key is tested on the team's machines: the sentence names the one to install on. */
const MACHINE_INSTALL =
  "install Revyl's CLI on devbox, and on each machine whose agents get Revyl screens: curl -fsSL https://revyl.com/install.sh | sh (or brew install RevylAI/tap/revyl, or pip install revyl)";
const HUB_INSTALL = "install Revyl's CLI on the hub's machine and on each machine whose agents get Revyl screens: curl -fsSL https://revyl.com/install.sh | sh (or brew install RevylAI/tap/revyl, or pip install revyl)";

describe("where each phone kind's agent screens run", () => {
  it("offers the three routes for iOS simulators and Android only", () => {
    expect(REVYL_KINDS.map((k) => k.kind)).toEqual(["ios", "android"]);
    expect(routeChoices(true, "ours_first")).toEqual([
      { value: "ours_first", label: "Our machines first, then Revyl" },
      { value: "ours_only", label: "Our machines only" },
      { value: "revyl_only", label: "Revyl only" },
    ]);
  });

  it("keeps the Revyl routes listed but off before a key is connected, each saying what it needs", () => {
    const off = routeChoices(false, "ours_only");
    expect(off.filter((o) => o.disabled === true).map((o) => o.value)).toEqual(["ours_first", "revyl_only"]);
    for (const o of off.filter((c) => c.disabled === true)) expect(o.label).toContain("needs a Revyl key");
    expect(off.find((o) => o.value === "ours_only")?.disabled).toBeUndefined();
    expect(usesRevyl("ours_only")).toBe(false);
  });

  it("says why they're off: an admin gets Connect beside it, anyone else whom to ask; nothing once connected", () => {
    expect(routeOffLine(false, true)).toBe("Revyl choices need a Revyl key.");
    expect(routeOffLine(false, false)).toContain("ask an admin");
    expect(routeOffLine(true, true)).toBeNull();
    expect(routeOffLine(true, false)).toBeNull();
  });

  it("lists a route a newer hub has, so the choice shows what is in effect", () => {
    expect(routeChoices(true, "ours_then_theirs").at(-1)).toEqual({ value: "ours_then_theirs", label: "ours_then_theirs" });
  });
});

describe("the Revyl row's line", () => {
  it("says nothing at rest while the key works or no key is connected, and Works just after a check", () => {
    expect(revylLine({ connected: false }, true)).toBeNull();
    expect(revylLine({ connected: true, check: { ok: true, at } }, false)).toBeNull();
    expect(revylLine({ connected: true, check: { ok: true, at } }, true)).toEqual({ text: "Works", tone: "quiet" });
  });

  it("names no machine of its own when the hub gives no words for a missing CLI", () => {
    expect(revylLine({ connected: true, check: { ok: false, at, reason: "no_cli" } }, false)?.text).not.toContain("hub's machine");
  });

  it("says what a failed check found, in the hub's words else its reason's, with its fix", () => {
    expect(revylLine({ connected: true, check: { ok: false, at, reason: "invalid_key" } }, false)?.text).toContain("refused the key");
    const noCli = revylLine({ connected: true, check: { ok: false, at, reason: "no_cli", message: "The hub's machine has no revyl command.", fix: HUB_INSTALL } }, false);
    expect(noCli).toEqual({ text: "The hub's machine has no revyl command.", tone: "danger", fix: HUB_INSTALL });
  });

  it("copies only the install command out of the hub's sentence, never the sentence", () => {
    const check = { ok: false, at, reason: "no_cli", message: "The hub's machine has no revyl command.", fix: HUB_INSTALL };
    expect(installCommand({ check })).toBe("curl -fsSL https://revyl.com/install.sh | sh");
    // The wording that names the team machine to install on (the key tested on the team's machines).
    expect(installCommand({ check: { ...check, message: "No machine of the team's online has the revyl command (devbox, box2).", fix: MACHINE_INSTALL } })).toBe("curl -fsSL https://revyl.com/install.sh | sh");
    expect(installCommand({ check: { ...check, fix: "run brew install RevylAI/tap/revyl, then test again" } })).toBe("brew install RevylAI/tap/revyl");
    // Words with no command in them stay words: nothing to copy.
    expect(installCommand({ check: { ...check, fix: "install Revyl's CLI from revyl.com" } })).toBeNull();
    expect(installCommand({ check: { ...check, reason: "invalid_key" } })).toBeNull();
    expect(installCommand({})).toBeNull();
  });
});

describe("a pasted key", () => {
  it("is trimmed, and empty is none", () => {
    expect(keyOf("  rvl_abc\n")).toBe("rvl_abc");
    expect(keyOf(" \n")).toBeNull();
  });
});
