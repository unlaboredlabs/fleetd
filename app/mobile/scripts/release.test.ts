// mobile-release.yml's builds and the over-the-air updates they take (D219): the update certificate turns them on
// (app.config.ts), only a build from main is given it, and a merge goes out as an update or a build by its native
// fingerprint (D800, .github/release/mobile-due.sh).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// mobile-due.sh against a stand-in for gh: each `gh api <path> --jq <filter>` answers the path's canned JSON through
// jq, so the script reads this workflow's runs and their jobs as GitHub would give them.
const DUE = fileURLToPath(new URL("../../../.github/release/mobile-due.sh", import.meta.url));
const REPO = "unlaboredlabs/fleetd";
const sha = (c: string) => c.repeat(40);
type Run = { id: number; commit: string; jobs: { name: string; steps: { name: string; conclusion: string }[] }[] };
const passed = (...names: string[]) => names.map((name) => ({ name, conclusion: "success" }));
/** A run that sent a build to TestFlight, naming its native fingerprint (none: a build from before builds named it). */
const built = (id: number, commit: string, fingerprint?: { ios: string; android: string }): Run => ({
  id,
  commit,
  jobs: [{ name: "ios", steps: passed(...(fingerprint ? [`Native fingerprint ios ${fingerprint.ios} android ${fingerprint.android}`] : []), "Upload to TestFlight") }],
});
const updated = (id: number, commit: string): Run => ({ id, commit, jobs: [{ name: "update", steps: passed("Publish the update") }] });

function due(command: "due" | "release", runs: Run[], env: Record<string, string>, compare: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mobile-due-"));
  const answers: Record<string, unknown> = {
    [`repos/${REPO}/actions/workflows/mobile-release.yml/runs?branch=main&status=success&per_page=100`]: {
      workflow_runs: runs.map((r) => ({ id: r.id, display_title: `Mobile release of ${r.commit}`, head_sha: sha("f") })),
    },
  };
  for (const r of runs) answers[`repos/${REPO}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`] = { jobs: r.jobs };
  for (const [range, status] of Object.entries(compare)) answers[`repos/${REPO}/compare/${range}`] = { status };
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash\n[ "$1" = api ] && [ "$3" = --jq ] || exit 2\njq -e --arg p "$2" '.[$p]' "${join(dir, "answers.json")}" > "${dir}/answer" || { echo "no answer for $2" >&2; exit 1; }\njq -r "$4" "${dir}/answer"\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync("bash", [DUE, command], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, GITHUB_REF_NAME: "main", BUILD_SHA: sha("b"), ...env },
  });
  expect(r.status, r.stderr).toBe(0);
  return { out: r.stdout.trim(), why: r.stderr.trim() };
}

describe("what a merge releases", () => {
  const same = { RUNTIME_IOS: "i1", RUNTIME_ANDROID: "a1", UPDATES: "true" };
  const release = (runs: Run[], env: Record<string, string> = {}) => due("release", runs, { ...same, ...env });

  it("is an over-the-air update when the native fingerprint is the newest TestFlight build's", () => {
    const r = release([built(2, sha("a"), { ios: "i1", android: "a1" })]);
    expect(r.out).toBe("release=update");
    expect(r.why).toBe(`Publishing bbbbbbbbb as an over-the-air update: its native fingerprint is the one the TestFlight build of aaaaaaaaa embeds (ios i1 android a1).`);
  });

  it("looks past updates to the build they were for", () => {
    expect(release([updated(4, sha("c")), updated(3, sha("d")), built(2, sha("a"), { ios: "i1", android: "a1" })]).out).toBe("release=update");
  });

  it("is a new TestFlight build when either platform's native fingerprint changed", () => {
    const ios = release([updated(3, sha("c")), built(2, sha("a"), { ios: "i0", android: "a1" })]);
    expect(ios.out).toBe("release=testflight");
    expect(ios.why).toContain("the native fingerprint changed since the build of aaaaaaaaa (it embeds ios i0 android a1, this is ios i1 android a1)");
    expect(release([built(2, sha("a"), { ios: "i1", android: "a0" })]).out).toBe("release=testflight");
  });

  it("is a new build when the newest one doesn't name its fingerprint, or there is none", () => {
    // Builds from before this, and an older one that names the same fingerprint doesn't count: the newest decides.
    const legacy = release([built(3, sha("a")), built(2, sha("d"), { ios: "i1", android: "a1" })]);
    expect(legacy.out).toBe("release=testflight");
    expect(legacy.why).toContain("doesn't name its native fingerprint");
    expect(release([]).out).toBe("release=testflight");
    expect(release([updated(3, sha("c"))]).out).toBe("release=testflight");
  });

  it("is a new build when no update can be published here", () => {
    const r = release([built(2, sha("a"), { ios: "i1", android: "a1" })], { UPDATES: "false" });
    expect(r.out).toBe("release=testflight");
    expect(r.why).toContain("over-the-air updates aren't published here");
  });

  it("counts an update as released, so the same commit isn't sent twice", () => {
    const r = due("due", [updated(3, sha("b")), built(2, sha("a"), { ios: "i1", android: "a1" })], { UPLOAD: "true" }, { [`${sha("b")}...${sha("b")}`]: "identical" });
    expect(r.out).toBe("due=false");
    expect(r.why).toBe("Nothing new: bbbbbbbbb is in the release of bbbbbbbbb, which went out already.");
  });

  it("releases when nothing went out before, and nothing without TestFlight set up", () => {
    expect(due("due", [], { UPLOAD: "true" }).out).toBe("due=true");
    expect(due("due", [], { UPLOAD: "false" }).out).toBe("due=false");
  });
});
