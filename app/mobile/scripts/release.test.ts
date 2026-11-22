// mobile-release.yml's builds and the over-the-air updates they take (D219): the update certificate turns them on
// (app.config.ts), and only a build from main is given it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../../.github/workflows/mobile-release.yml", import.meta.url), "utf8");

describe("a release build from a branch", () => {
  it("takes no over-the-air updates, so it runs its own JavaScript rather than main's", () => {
    // TestFlight build 27, from #1871's branch, changed no native file: it had main's runtime version, and main's next
    // edge update replaced its JavaScript, so a real iPhone Duo showed main's one-pane layout, not the branch's.
    const given = workflow.match(/^\s*UPDATES_CERT_PEM:.*$/gmu) ?? [];
    expect(given).toEqual(["  UPDATES_CERT_PEM: ${{ github.ref == 'refs/heads/main' && vars.UPDATES_CERT_PEM || '' }}"]);
  });
});

describe("the screens run's flag", () => {
  it("is never set for a release build: a release asks for notifications", () => {
    // EXPO_PUBLIC_FLEETD_SCREENS skips the ask (src/notifications.ts) in mac.yml's ios screens build alone.
    expect(workflow).not.toContain("EXPO_PUBLIC_FLEETD_SCREENS");
    const build = readFileSync(new URL("../../../.github/workflows/build-release.yml", import.meta.url), "utf8");
    expect(build).not.toContain("EXPO_PUBLIC_FLEETD_SCREENS");
    const nightly = readFileSync(new URL("../../../.github/workflows/mac.yml", import.meta.url), "utf8");
    expect(nightly.match(/EXPO_PUBLIC_FLEETD_SCREENS: "1"/gu)).toHaveLength(1);
    const notifications = readFileSync(new URL("../src/notifications.ts", import.meta.url), "utf8");
    expect(notifications.match(/EXPO_PUBLIC_FLEETD_SCREENS/gu)).toHaveLength(1);
    expect(notifications).toContain('if (process.env.EXPO_PUBLIC_FLEETD_SCREENS === "1") return null;');
  });
});
