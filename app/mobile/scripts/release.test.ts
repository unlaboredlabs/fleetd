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
