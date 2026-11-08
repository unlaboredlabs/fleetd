// The matcher's tables (crates/fleetd/src/hub/work/matcher_tests.rs, the case table converted as written): true
// duplicates, near misses that must not match (or only weakly), claims written as paths, issues and free text; then the
// calibration on fleetd's own frozen PR history, read from the Rust tree's testdata.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Candidate, declared, keysIn, type Match, type MatchKey, matches, pathsIn, readWork, type Scope, Strength, type Work } from "../src/hub/work/matcher.ts";

const scope = (): Scope => ({ repo: "git@github.com:acme/shop.git", base: "main" });

/** A piece of work: `owner`, title, prompt body, declared keys (any text form, or `branch:x`) and declared paths. */
function work(owner: string, title: string, body: string, keys: string[], paths: string[]): Work {
  const w = readWork(owner === "" ? undefined : owner, title, body, scope());
  for (const k of keys) {
    const key: MatchKey[] = k.startsWith("branch:") ? [{ branch: k.slice(7) }] : keysIn(k, scope());
    if (key.length === 0) throw new Error(`no key in ${k}`);
    w.keys.push(...key.map(declared));
  }
  w.paths.push(...paths);
  return w;
}

function one(intent: Work, them: Work, weakOnly: boolean): Match | undefined {
  const found = matches(intent, [{ id: "C7", work: them, weakOnly }], scope());
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0];
}

type Case = [string, Work, Work, boolean, Strength | undefined, string];

test("the table", () => {
  const cases: Case[] = [
    
        // ---- true duplicates ----
        [
            "an issue the intent declares and a title names",
            work(
                "lead",
                "login crashes on an empty password",
                "",
                ["#42"],
                [],
            ),
            work("laptop", "login crash (#42)", "", [], []),
            false,
            Strength.Exact,
            "same #42",
        ],
        [
            "a declared tracker key the other's title names",
            work("laptop", "billing retries", "", ["ABC-123"], []),
            work("lead", "ABC-123: retry failed card charges", "", [], []),
            false,
            Strength.Exact,
            "same ABC-123",
        ],
        [
            "a PR URL in this repo and the bare number in a squash subject",
            work(
                "laptop",
                "dark mode",
                "",
                ["https://github.com/acme/shop/pull/57"],
                [],
            ),
            work("", "feat: dark mode toggle (#57)", "", [], []),
            false,
            Strength.Exact,
            "same #57",
        ],
        [
            "a GitLab merge request URL and its merge message",
            work(
                "laptop",
                "cache warmup",
                "",
                ["https://gitlab.com/acme/platform/shop/-/merge_requests/12"],
                [],
            ),
            work(
                "",
                "Warm the cache on boot",
                "See merge request acme/platform/shop!12",
                ["acme/platform/shop!12"],
                [],
            ),
            false,
            Strength.Exact,
            "same acme/platform/shop!12",
        ],
        [
            "the same branch",
            work(
                "laptop",
                "theme work",
                "",
                ["branch:ada-lovelace/dark-mode"],
                [],
            ),
            work(
                "lead",
                "settings polish",
                "",
                ["branch:ada-lovelace/dark-mode"],
                [],
            ),
            false,
            Strength.Exact,
            "same branch ada-lovelace/dark-mode",
        ],
        [
            "near-identical titles",
            work(
                "lead",
                "feat(settings): dark mode toggle in settings",
                "",
                [],
                [],
            ),
            work(
                "laptop",
                "Add a dark mode toggle to the settings page",
                "",
                [],
                [],
            ),
            false,
            Strength.Strong,
            "4 shared words: dark, mode, toggle, settings",
        ],
        [
            "shared words and the same file",
            work(
                "lead",
                "theme colors follow the OS",
                "",
                [],
                ["app/theme.ts"],
            ),
            work("laptop", "dark theme colors", "", [], ["app/theme.ts"]),
            false,
            Strength.Strong,
            "2 shared words: theme, colors; same file app/theme.ts",
        ],
        [
            "a claim's glob covers the file the prompt names",
            work(
                "lead",
                "settings screen theme picker",
                "Change app/settings/theme.tsx only.",
                [],
                [],
            ),
            work("laptop", "theme picker", "", [], ["app/settings/**"]),
            false,
            Strength.Strong,
            "same file app/settings/theme.tsx",
        ],
        [
            "a claim's directory covers the file",
            work(
                "lead",
                "picker for the theme",
                "",
                [],
                ["./app/settings/theme.tsx"],
            ),
            work("laptop", "theme picker", "", [], ["app/settings/"]),
            false,
            Strength.Strong,
            "same file app/settings/theme.tsx",
        ],
        [
            "a revert and its redo",
            work(
                "lead",
                "feat(hub): the lead chat replaces orders, asks and the board",
                "",
                [],
                [],
            ),
            work(
                "",
                "revert: feat(hub): the lead chat replaces orders, asks and the board",
                "",
                [],
                [],
            ),
            false,
            Strength.Strong,
            "6 shared words",
        ],
        [
            "a batch subject that carries the change",
            work(
                "lead",
                "fix(desktop): the recorder loads over app:// in the packaged app",
                "",
                [],
                [],
            ),
            work(
                "",
                "batch: fix(desktop): the app reports its full nightly version (#382); fix(desktop): the recorder loads over app:// in the packaged app (#383)",
                "",
                [],
                [],
            ),
            false,
            Strength.Strong,
            "recorder",
        ],
        [
            "titles in another language",
            work(
                "lead",
                "Ajouter le mode sombre aux paramètres",
                "",
                [],
                [],
            ),
            work("laptop", "mode sombre dans les paramètres", "", [], []),
            false,
            Strength.Strong,
            "paramètres",
        ],
        [
            "the same title in a script without spaces",
            work("lead", "暗黑模式切换", "", [], []),
            work("laptop", "暗黑模式切换", "", [], []),
            false,
            Strength.Strong,
            "same words",
        ],
        [
            "a short title said twice",
            work("lead", "refactor(hub): incidents go", "", [], []),
            work("lead-b", "chore: incidents go", "", [], []),
            false,
            Strength.Strong,
            "same words: incidents",
        ],
        // ---- near misses: never exact, at most weak ----
        [
            "one shared word and the same script",
            work(
                "lead",
                "fix(scripts): demo-mac.sh writes the clip to ~/fleetd-demo/clip.mp4",
                "",
                [],
                ["scripts/demo-mac.sh"],
            ),
            work(
                "",
                "fix(scripts): demo-mac.sh reads the nightly CLI's commit after the +",
                "",
                [],
                ["scripts/demo-mac.sh"],
            ),
            false,
            Strength.Weak,
            "same file scripts/demo-mac.sh",
        ],
        [
            "two changes that share one central file of several",
            work(
                "lead",
                "upload endpoint rate limits",
                "",
                [],
                [
                    "src/api/router.ts",
                    "src/api/upload.ts",
                    "src/limits.ts",
                    "src/limits_test.ts",
                ],
            ),
            work(
                "laptop",
                "upload endpoint progress bar",
                "",
                [],
                [
                    "src/api/upload.ts",
                    "web/progress.tsx",
                    "web/progress.css",
                    "web/upload_page.tsx",
                ],
            ),
            false,
            Strength.Weak,
            "2 shared words: upload, endpoint; same file src/api/upload.ts",
        ],
        [
            "the same area and nothing else",
            work("lead", "feat(hub): the lead chat", "", [], []),
            work("lead", "fix(hub): the merge train", "", [], []),
            false,
            undefined,
            "",
        ],
        [
            "a standard's name is not a tracker key",
            work(
                "lead",
                "fix: UTF-8 decoding in the CSV importer",
                "",
                [],
                [],
            ),
            work(
                "laptop",
                "feat: UTF-8 file names in the uploader",
                "",
                [],
                [],
            ),
            false,
            undefined,
            "",
        ],
        [
            "a priority is not a plan item",
            work("lead", "P1: login crash", "", [], []),
            work("laptop", "P1: dark mode", "", [], []),
            false,
            undefined,
            "",
        ],
        [
            "a colour both prompts mention refuses once, never outright",
            work("lead", "card borders", "Make the border #333.", [], []),
            work(
                "laptop",
                "footer text",
                "Text colour #333 on white.",
                [],
                [],
            ),
            false,
            Strength.Strong,
            "both mention #333",
        ],
        [
            "a follow-up names the PR it follows",
            work("lead", "fix: regression from #57", "", [], []),
            work("", "feat: dark mode toggle (#57)", "", ["#57"], []),
            false,
            Strength.Strong,
            "both mention #57",
        ],
        [
            "the same issue in two titles",
            work(
                "lead",
                "fix: #42 login crashes on an empty password",
                "",
                [],
                [],
            ),
            work("laptop", "login crash (#42)", "", [], []),
            false,
            Strength.Strong,
            "both mention #42",
        ],
        [
            "a product version is not a tracker key",
            work("lead", "Upgrade the build to JDK-21", "", [], []),
            work(
                "laptop",
                "JDK-21 virtual threads in the worker pool",
                "",
                [],
                [],
            ),
            false,
            undefined,
            "",
        ],
        [
            "a key one title names and the other prompt only mentions",
            work("lead", "#42 login crash", "", [], []),
            work(
                "lead-b",
                "session cookies",
                "Unrelated to #42, which is the login crash.",
                [],
                [],
            ),
            false,
            Strength.Strong,
            "both mention #42",
        ],
        [
            "an issue in another repo is not this repo's",
            work(
                "lead",
                "bump the parser",
                "",
                ["https://github.com/other/lib/issues/12"],
                [],
            ),
            work("laptop", "checkout totals", "", ["#12"], []),
            false,
            undefined,
            "",
        ],
        [
            "both on the base branch",
            work("laptop", "checkout totals", "", ["branch:main"], []),
            work("desk", "search ranking", "", ["branch:main"], []),
            false,
            undefined,
            "",
        ],
        [
            "prose with slashes names no files",
            work(
                "lead",
                "read/write split for the cache",
                "See https://example.com/docs/setup.html and Node.js.",
                [],
                [],
            ),
            work(
                "laptop",
                "read/write locks in the store",
                "Uses Vue.js; due 10/25.",
                [],
                [],
            ),
            false,
            Strength.Weak,
            "2 shared words: read, write",
        ],
        [
            "a lead splitting its own branch",
            work(
                "lead",
                "export invoices as CSV",
                "",
                ["branch:invoices"],
                [],
            ),
            work(
                "lead",
                "export invoices as PDF",
                "",
                ["branch:invoices"],
                [],
            ),
            false,
            Strength.Weak,
            "same branch invoices (yours)",
        ],
        [
            "an expired claim is listed, never more",
            work(
                "lead",
                "feat(settings): dark mode toggle in settings",
                "",
                ["#42"],
                [],
            ),
            work(
                "lead-b",
                "dark mode toggle in the settings",
                "",
                ["#42"],
                [],
            ),
            true,
            Strength.Weak,
            "same #42",
        ],
        // ---- claims as free text, paths only, issues only ----
        [
            "a free-text claim that names the work loosely",
            work(
                "lead",
                "Dark-mode toggle for the settings screen",
                "",
                [],
                [],
            ),
            work("laptop", "dark mode", "", [], []),
            false,
            Strength.Weak,
            "2 shared words: dark, mode",
        ],
        [
            "a claim of paths only, and one of them",
            work(
                "lead",
                "checkout totals round half up",
                "",
                [],
                ["src/checkout/totals.go"],
            ),
            work(
                "laptop",
                "",
                "",
                [],
                ["src/checkout/totals.go", "src/checkout/tax.go"],
            ),
            false,
            Strength.Weak,
            "same file src/checkout/totals.go",
        ],
        [
            "a claim of an issue only",
            work("lead", "Retry webhooks", "", ["#88"], []),
            work("laptop", "", "", ["#88"], []),
            false,
            Strength.Exact,
            "same #88",
        ],
        [
            "an issue only the intent's title names refuses once, never outright",
            work("lead", "Retry webhooks (closes #88)", "", [], []),
            work("laptop", "", "", ["#88"], []),
            false,
            Strength.Strong,
            "both mention #88",
        ],
        [
            "unrelated work in the same files' directory",
            work(
                "lead",
                "checkout totals round half up",
                "",
                [],
                ["src/checkout/totals.go"],
            ),
            work(
                "laptop",
                "tax tables for 2027",
                "",
                [],
                ["src/checkout/tax.go"],
            ),
            false,
            undefined,
            "",
        ],
  ];
  const failed: string[] = [];
  for (const [name, intent, theirs, weakOnly, want, why] of cases) {
    const got = one(intent, theirs, weakOnly);
    if (got?.strength !== want || (got !== undefined && !got.why.includes(why))) {
      failed.push(`${name}: want ${want} with ${JSON.stringify(why)}, got ${JSON.stringify(got)}`);
    }
  }
  expect(failed).toEqual([]);
});

test("matches come strongest first and say why", () => {
  const intent = work("lead", "feat(settings): dark mode toggle in settings", "", ["#42"], ["app/theme.ts"]);
  const c = (id: string, w: Work): Candidate => ({ id, work: w, weakOnly: false });
  const found = matches(
    intent,
    [
      c("T3", work("lead-b", "dark mode", "", [], [])),
      c("C7", work("laptop", "theme colors", "", ["#42"], [])),
      c("T9", work("lead-b", "unrelated", "", [], [])),
      c("T4", work("lead-b", "a dark mode toggle in settings", "", [], ["app/theme.ts"])),
    ],
    scope(),
  );
  expect(found.map((m) => [m.id, m.strength, m.why])).toEqual([
    ["C7", Strength.Exact, "same #42"],
    ["T4", Strength.Strong, "4 shared words: dark, mode, toggle, settings; same file app/theme.ts"],
    ["T3", Strength.Weak, "2 shared words: dark, mode"],
  ]);
});

test("keys in text", () => {
  const r = (ref: string): MatchKey => ({ ref });
  const cases: [string, MatchKey[]][] = [
    ["Fix #12 and (#13), see ABC-123", [r("#12"), r("#13"), r("ABC-123")]],
    ["https://github.com/acme/shop/pull/57.", [r("#57")]],
    ["https://github.com/Acme/Shop/issues/9#issuecomment-1", [r("#9")]],
    ["https://github.com/other/lib/pull/3", [r("other/lib#3")]],
    ["https://gitea.example.org/acme/shop/pulls/4", [r("#4")]],
    ["https://gitea.example.org/acme/web/pulls/4", [r("acme/web#4")]],
    ["https://bitbucket.org/acme/web/pull-requests/8/diff", [r("acme/web#8")]],
    ["https://gitlab.com/g/sub/proj/-/merge_requests/5", [r("g/sub/proj!5")]],
    ["https://gitlab.com/g/proj/-/issues/6", [r("g/proj#6")]],
    ["https://acme.atlassian.net/browse/SHOP-77", [r("SHOP-77")]],
    ["See merge request g/proj!12, and acme/shop#5", [r("g/proj!12"), r("#5")]],
    ["Merged in feature (pull request !3)", [r("!3")]],
    ["UTF-8, SHA-256, ISO-8601-1, CVE-2024-1234, X-1.2", []],
    ["JDK-21, JEP-444, PY-3, GCC-14, IOS-18, SDK-35", []],
    ["colour &#123; in C#12, wow!12, #0 and #12345678", []],
    ["P1 priority, P5", []],
    // Rust's `\b` is Unicode: a ref run into a letter isn't one.
    ["see #12é", []],
  ];
  for (const [text, want] of cases) expect([text, keysIn(text, scope())]).toEqual([text, want]);
});

test("paths in text", () => {
  const cases: [string, string[]][] = [
    ["Change `app/settings/theme.tsx` and ./lib/util.py.", ["app/settings/theme.tsx", "lib/util.py"]],
    ["Everything under docs/ and src/**/*.rs, plus a/b/c", ["docs/", "src/**/*.rs", "a/b/c"]],
    ["read/write, TCP/IP, 10/25/2026, and/or", []],
    ["README.md, Cargo.toml and Node.js", []],
    ["https://example.com/docs/setup.html", []],
    ["(see crates/fleetd/src/hub/mod.rs:12)", []],
  ];
  for (const [text, want] of cases) expect([text, pathsIn(text)]).toEqual([text, want]);
});

test("star runs cost no more than one star", () => {
  const name = "x".repeat(30);
  const file = `a/${name}`;
  const stars = `a/${"*".repeat(40)}q`;
  const dirs = `${Array(40).fill("**").join("/")}/q`;
  const deep = Array(40).fill(name).join("/");
  const mixed = `${Array(20).fill("*x**").join("/")}/q`;
  for (const [pattern, path] of [
    [stars, file],
    [dirs, deep],
    [mixed, deep],
  ] as const) {
    const intent = work("lead", "picker", `Touch ${pattern} only.`, [], []);
    expect(intent.paths).toEqual([pattern]);
    expect(one(intent, work("laptop", "", "", [], [path]), false)).toBeUndefined();
  }
  expect(one(work("lead", "picker", "", [], [`a/${"*".repeat(40)}x`]), work("laptop", "", "", [], [file]), false)?.strength).toBe(Strength.Weak);
  expect(one(work("lead", "picker", "", [], [`${Array(40).fill("**").join("/")}/x*`]), work("laptop", "", "", [], [deep]), false)?.strength).toBe(
    Strength.Weak,
  );
});

// ---- calibration on fleetd's own history ----

const TESTDATA = join(import.meta.dir, "../../../crates/fleetd/src/hub/work/testdata");

type Pr = { number: number; merged: boolean; title: string; paths: string[] };

function history(): Pr[] {
  const paths = readFileSync(join(TESTDATA, "fleetd_paths.txt"), "utf8").split("\n");
  return readFileSync(join(TESTDATA, "fleetd_prs.tsv"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((line) => {
      const f = line.split("\t");
      return {
        number: Number(f[0]),
        merged: f[1] === "merged",
        title: f[2] ?? "",
        paths: (f[3] ?? "").split(/\s+/).filter(Boolean).map((i) => paths[Number(i)] ?? ""),
      };
    });
}

function asWork(pr: Pr, owner: string): Work {
  const w = readWork(owner, pr.title, "", scope());
  w.paths = [...pr.paths];
  return w;
}

test("distinct merged PRs almost never pair as strong", () => {
  const prs = history().filter((p) => p.merged && !p.title.startsWith("batch"));
  const works = prs.map((p) => asWork(p, `o${p.number}`));
  let pairs = 0;
  const strong: string[] = [];
  const exact: string[] = [];
  works.forEach((a, i) => {
    const later: Candidate[] = works.slice(i + 1).map((w, j) => ({ id: `#${prs[i + 1 + j]!.number}`, work: w, weakOnly: false }));
    pairs += later.length;
    for (const m of matches(a, later, scope())) {
      const line = `#${prs[i]!.number} ~ ${m.id}: ${m.why}`;
      if (m.strength === Strength.Exact) exact.push(line);
      else if (m.strength === Strength.Strong) strong.push(line);
    }
  });
  expect(pairs).toBeGreaterThan(25_000);
  expect(exact).toEqual([]);
  // 1 in 500: about 1 in 700 today, nearly all a port or a redo of the same feature.
  expect(strong.length * 500).toBeLessThanOrEqual(pairs);
});

test("a change matches the batch that merged it", () => {
  const prs = history();
  let text = 0;
  let keyed = 0;
  for (const batch of prs.filter((p) => p.merged && p.title.startsWith("batch"))) {
    for (const part of prs.filter((p) => !p.merged && batch.title.includes(`#${p.number})`))) {
      const against: Candidate[] = [{ id: `#${batch.number}`, work: asWork(batch, "train"), weakOnly: false }];
      // By its words and files, when the batch subject carries its title.
      if (batch.title.includes(part.title)) {
        const got = matches(asWork(part, "lead"), against, scope());
        expect([part.number, (got[0]?.strength ?? -1) >= Strength.Strong]).toEqual([part.number, true]);
        text++;
      }
      // By its number, always.
      const w = asWork(part, "lead");
      w.keys.push(declared({ ref: `#${part.number}` }));
      expect([part.number, matches(w, against, scope())[0]?.strength]).toEqual([part.number, Strength.Exact]);
      keyed++;
    }
  }
  expect(text).toBeGreaterThanOrEqual(30);
  expect(keyed).toBeGreaterThanOrEqual(50);
});
