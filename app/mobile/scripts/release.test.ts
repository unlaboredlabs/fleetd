// mobile-release.yml's builds and the over-the-air updates they take (D219): the update certificate turns them on
// (app.config.ts), and only a build from main is given it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** The app's own source files: what Metro bundles from. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const at = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(at);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [at] : [];
  });
}

describe("the scheduled TestFlight build", () => {
  it("watches every file outside the app the app imports, and Metro's folders", () => {
    // .github/release/mobile-due.sh builds only when one of its paths changed: one it misses ships no build.
    const mobile = fileURLToPath(new URL("..", import.meta.url));
    const root = join(mobile, "../..");
    const due = spawnSync("bash", [join(root, ".github/release/mobile-due.sh"), "paths"], { encoding: "utf8" });
    const watched = due.stdout.trim().split("\n");
    const covered = (file: string) => watched.some((p) => file === p || file.startsWith(`${p}/`));
    const outside = new Set<string>();
    for (const file of [...sources(join(mobile, "src")), join(mobile, "App.tsx"), join(mobile, "index.ts")]) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
        const to = relative(root, resolve(dirname(file), spec!));
        if (!to.startsWith("app/mobile/")) outside.add(to);
      }
    }
    expect(outside.size).toBeGreaterThan(0);
    expect([...outside].filter((f) => !covered(f))).toEqual([]);
    const metro = readFileSync(join(mobile, "metro.config.js"), "utf8");
    const folders = [...metro.matchAll(/path\.join\(desktop, "([^"]+)"\)/g)].map(([, f]) => `app/desktop/src/${f}`);
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) expect(watched).toContain(folder);
  });
});
