//! The matcher's tables: true duplicates, near misses that must not match (or only weakly), and claims written as
//! paths, issues and free text. Then the calibration on fleetd's own frozen PR history.
use super::matcher::*;

fn scope() -> Scope {
    Scope {
        repo: Some("git@github.com:acme/shop.git".into()),
        base: Some("main".into()),
    }
}

/// A piece of work: `owner`, title, prompt body, declared keys (any text form, or `branch:x` / `item:P5`) and
/// declared paths.
fn work(owner: &str, title: &str, body: &str, keys: &[&str], paths: &[&str]) -> Work {
    let owner = (!owner.is_empty()).then(|| owner.to_string());
    let mut w = Work::read(owner, title, body, &scope());
    for k in keys {
        let key = if let Some(b) = k.strip_prefix("branch:") {
            vec![WorkKey::Branch(b.into())]
        } else if let Some(i) = k.strip_prefix("item:") {
            vec![WorkKey::Item(i.into())]
        } else {
            keys_in(k, &scope())
        };
        assert!(!key.is_empty(), "no key in {k}");
        w.keys.extend(key.into_iter().map(Key::declared));
    }
    w.paths.extend(paths.iter().map(|p| p.to_string()));
    w
}

fn one(intent: &Work, them: Work, weak_only: bool) -> Option<Match> {
    let c = Candidate {
        id: "C7".into(),
        work: them,
        weak_only,
    };
    let mut found = matches(intent, &[c], &scope());
    assert!(found.len() <= 1);
    found.pop()
}

use Strength::{Exact, Strong, Weak};

/// (case, intent, theirs, weak only, strength, words the why must hold)
type Case = (
    &'static str,
    Work,
    Work,
    bool,
    Option<Strength>,
    &'static str,
);

#[test]
fn the_table() {
    let cases: Vec<Case> = vec![
        // ---- true duplicates ----
        (
            "the same issue in two titles",
            work(
                "lead",
                "fix: #42 login crashes on an empty password",
                "",
                &[],
                &[],
            ),
            work("laptop", "login crash (#42)", "", &[], &[]),
            false,
            Some(Exact),
            "same #42",
        ),
        (
            "a declared tracker key the other's title names",
            work("laptop", "billing retries", "", &["ABC-123"], &[]),
            work("lead", "ABC-123: retry failed card charges", "", &[], &[]),
            false,
            Some(Exact),
            "same ABC-123",
        ),
        (
            "a PR URL in this repo and the bare number in a squash subject",
            work(
                "laptop",
                "dark mode",
                "",
                &["https://github.com/acme/shop/pull/57"],
                &[],
            ),
            work("", "feat: dark mode toggle (#57)", "", &[], &[]),
            false,
            Some(Exact),
            "same #57",
        ),
        (
            "a GitLab merge request URL and its merge message",
            work(
                "laptop",
                "cache warmup",
                "",
                &["https://gitlab.com/acme/platform/shop/-/merge_requests/12"],
                &[],
            ),
            work(
                "",
                "Warm the cache on boot",
                "See merge request acme/platform/shop!12",
                &["acme/platform/shop!12"],
                &[],
            ),
            false,
            Some(Exact),
            "same acme/platform/shop!12",
        ),
        (
            "the same branch",
            work("laptop", "theme work", "", &["branch:ada-lovelace/dark-mode"], &[]),
            work(
                "lead",
                "settings polish",
                "",
                &["branch:ada-lovelace/dark-mode"],
                &[],
            ),
            false,
            Some(Exact),
            "same branch ada-lovelace/dark-mode",
        ),
        (
            "the same plan item held by another lead",
            work("lead-a", "export invoices", "", &["item:P5"], &[]),
            work("lead-b", "invoice export", "", &["item:P5"], &[]),
            false,
            Some(Exact),
            "same item P5",
        ),
        (
            "near-identical titles",
            work(
                "lead",
                "feat(settings): dark mode toggle in settings",
                "",
                &[],
                &[],
            ),
            work(
                "laptop",
                "Add a dark mode toggle to the settings page",
                "",
                &[],
                &[],
            ),
            false,
            Some(Strong),
            "4 shared words: dark, mode, toggle, settings",
        ),
        (
            "shared words and the same file",
            work(
                "lead",
                "theme colors follow the OS",
                "",
                &[],
                &["app/theme.ts"],
            ),
            work("laptop", "dark theme colors", "", &[], &["app/theme.ts"]),
            false,
            Some(Strong),
            "2 shared words: theme, colors; same file app/theme.ts",
        ),
        (
            "a claim's glob covers the file the prompt names",
            work(
                "lead",
                "settings screen theme picker",
                "Change app/settings/theme.tsx only.",
                &[],
                &[],
            ),
            work("laptop", "theme picker", "", &[], &["app/settings/**"]),
            false,
            Some(Strong),
            "same file app/settings/theme.tsx",
        ),
        (
            "a claim's directory covers the file",
            work(
                "lead",
                "picker for the theme",
                "",
                &[],
                &["./app/settings/theme.tsx"],
            ),
            work("laptop", "theme picker", "", &[], &["app/settings/"]),
            false,
            Some(Strong),
            "same file app/settings/theme.tsx",
        ),
        (
            "a revert and its redo",
            work(
                "lead",
                "feat(hub): the lead chat replaces orders, asks and the board",
                "",
                &[],
                &[],
            ),
            work(
                "",
                "revert: feat(hub): the lead chat replaces orders, asks and the board",
                "",
                &[],
                &[],
            ),
            false,
            Some(Strong),
            "6 shared words",
        ),
        (
            "a batch subject that carries the change",
            work(
                "lead",
                "fix(desktop): the recorder loads over app:// in the packaged app",
                "",
                &[],
                &[],
            ),
            work(
                "",
                "batch: fix(desktop): the app reports its full nightly version (#382); fix(desktop): the recorder loads over app:// in the packaged app (#383)",
                "",
                &[],
                &[],
            ),
            false,
            Some(Strong),
            "recorder",
        ),
        (
            "titles in another language",
            work(
                "lead",
                "Ajouter le mode sombre aux paramètres",
                "",
                &[],
                &[],
            ),
            work("laptop", "mode sombre dans les paramètres", "", &[], &[]),
            false,
            Some(Strong),
            "paramètres",
        ),
        (
            "the same title in a script without spaces",
            work("lead", "暗黑模式切换", "", &[], &[]),
            work("laptop", "暗黑模式切换", "", &[], &[]),
            false,
            Some(Strong),
            "same words",
        ),
        (
            "a short title said twice",
            work("lead", "refactor(hub): incidents go", "", &[], &[]),
            work("lead-b", "chore: incidents go", "", &[], &[]),
            false,
            Some(Strong),
            "same words: incidents",
        ),
        // ---- near misses: never exact, at most weak ----
        (
            "one shared word and the same script",
            work(
                "lead",
                "fix(scripts): demo-mac.sh writes the clip to ~/fleetd-demo/clip.mp4",
                "",
                &[],
                &["scripts/demo-mac.sh"],
            ),
            work(
                "",
                "fix(scripts): demo-mac.sh reads the nightly CLI's commit after the +",
                "",
                &[],
                &["scripts/demo-mac.sh"],
            ),
            false,
            Some(Weak),
            "same file scripts/demo-mac.sh",
        ),
        (
            "two changes that share one central file of several",
            work(
                "lead",
                "upload endpoint rate limits",
                "",
                &[],
                &[
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
                &[],
                &[
                    "src/api/upload.ts",
                    "web/progress.tsx",
                    "web/progress.css",
                    "web/upload_page.tsx",
                ],
            ),
            false,
            Some(Weak),
            "2 shared words: upload, endpoint; same file src/api/upload.ts",
        ),
        (
            "the same area and nothing else",
            work("lead", "feat(hub): the lead chat", "", &[], &[]),
            work("lead", "fix(hub): the merge train", "", &[], &[]),
            false,
            None,
            "",
        ),
        (
            "a standard's name is not a tracker key",
            work(
                "lead",
                "fix: UTF-8 decoding in the CSV importer",
                "",
                &[],
                &[],
            ),
            work(
                "laptop",
                "feat: UTF-8 file names in the uploader",
                "",
                &[],
                &[],
            ),
            false,
            None,
            "",
        ),
        (
            "a priority is not a plan item",
            work("lead", "P1: login crash", "", &[], &[]),
            work("laptop", "P1: dark mode", "", &[], &[]),
            false,
            None,
            "",
        ),
        (
            "a colour both prompts mention refuses once, never outright",
            work("lead", "card borders", "Make the border #333.", &[], &[]),
            work(
                "laptop",
                "footer text",
                "Text colour #333 on white.",
                &[],
                &[],
            ),
            false,
            Some(Strong),
            "both mention #333",
        ),
        (
            "a key one title names and the other prompt only mentions",
            work("lead", "#42 login crash", "", &[], &[]),
            work(
                "lead-b",
                "session cookies",
                "Unrelated to #42, which is the login crash.",
                &[],
                &[],
            ),
            false,
            Some(Strong),
            "both mention #42",
        ),
        (
            "an issue in another repo is not this repo's",
            work(
                "lead",
                "bump the parser",
                "",
                &["https://github.com/other/lib/issues/12"],
                &[],
            ),
            work("laptop", "checkout totals", "", &["#12"], &[]),
            false,
            None,
            "",
        ),
        (
            "both on the base branch",
            work("laptop", "checkout totals", "", &["branch:main"], &[]),
            work("desk", "search ranking", "", &["branch:main"], &[]),
            false,
            None,
            "",
        ),
        (
            "prose with slashes names no files",
            work(
                "lead",
                "read/write split for the cache",
                "See https://example.com/docs/setup.html and Node.js.",
                &[],
                &[],
            ),
            work(
                "laptop",
                "read/write locks in the store",
                "Uses Vue.js; due 10/25.",
                &[],
                &[],
            ),
            false,
            Some(Weak),
            "2 shared words: read, write",
        ),
        (
            "a lead splitting its own item",
            work("lead", "export invoices as CSV", "", &["item:P5"], &[]),
            work("lead", "export invoices as PDF", "", &["item:P5"], &[]),
            false,
            Some(Weak),
            "same item P5 (yours)",
        ),
        (
            "a planned item is listed, never more",
            work(
                "lead",
                "feat(settings): dark mode toggle in settings",
                "",
                &["#42"],
                &[],
            ),
            work(
                "lead-b",
                "dark mode toggle in the settings",
                "",
                &["#42"],
                &[],
            ),
            true,
            Some(Weak),
            "same #42",
        ),
        // ---- claims as free text, paths only, issues only ----
        (
            "a free-text claim that names the work loosely",
            work(
                "lead",
                "Dark-mode toggle for the settings screen",
                "",
                &[],
                &[],
            ),
            work("laptop", "dark mode", "", &[], &[]),
            false,
            Some(Weak),
            "2 shared words: dark, mode",
        ),
        (
            "a claim of paths only, and one of them",
            work(
                "lead",
                "checkout totals round half up",
                "",
                &[],
                &["src/checkout/totals.go"],
            ),
            work(
                "laptop",
                "",
                "",
                &[],
                &["src/checkout/totals.go", "src/checkout/tax.go"],
            ),
            false,
            Some(Weak),
            "same file src/checkout/totals.go",
        ),
        (
            "a claim of an issue only",
            work("lead", "Retry webhooks (closes #88)", "", &[], &[]),
            work("laptop", "", "", &["#88"], &[]),
            false,
            Some(Exact),
            "same #88",
        ),
        (
            "unrelated work in the same files' directory",
            work(
                "lead",
                "checkout totals round half up",
                "",
                &[],
                &["src/checkout/totals.go"],
            ),
            work(
                "laptop",
                "tax tables for 2027",
                "",
                &[],
                &["src/checkout/tax.go"],
            ),
            false,
            None,
            "",
        ),
    ];
    let mut failed = Vec::new();
    for (case, intent, theirs, weak_only, want, why) in cases {
        let got = one(&intent, theirs, weak_only);
        let ok = got.as_ref().map(|m| m.strength) == want
            && got.as_ref().is_none_or(|m| m.why.contains(why));
        if !ok {
            failed.push(format!("{case}: want {want:?} with {why:?}, got {got:?}"));
        }
    }
    assert!(failed.is_empty(), "\n{}", failed.join("\n"));
}

#[test]
fn matches_come_strongest_first_and_say_why() {
    let intent = work(
        "lead",
        "feat(settings): dark mode toggle in settings",
        "",
        &["#42"],
        &["app/theme.ts"],
    );
    let c = |id: &str, w: Work| Candidate {
        id: id.into(),
        work: w,
        weak_only: false,
    };
    let found = matches(
        &intent,
        &[
            c("T3", work("lead-b", "dark mode", "", &[], &[])),
            c("C7", work("laptop", "theme colors", "", &["#42"], &[])),
            c("T9", work("lead-b", "unrelated", "", &[], &[])),
            c(
                "T4",
                work(
                    "lead-b",
                    "a dark mode toggle in settings",
                    "",
                    &[],
                    &["app/theme.ts"],
                ),
            ),
        ],
        &scope(),
    );
    let got: Vec<(&str, Strength, &str)> = found
        .iter()
        .map(|m| (m.id.as_str(), m.strength, m.why.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            ("C7", Exact, "same #42"),
            (
                "T4",
                Strong,
                "4 shared words: dark, mode, toggle, settings; same file app/theme.ts"
            ),
            ("T3", Weak, "2 shared words: dark, mode"),
        ]
    );
}

#[test]
fn keys_in_text() {
    let s = scope();
    let r = |v: &str| WorkKey::Ref(v.into());
    let cases: &[(&str, &[WorkKey])] = &[
        (
            "Fix #12 and (#13), see ABC-123",
            &[r("#12"), r("#13"), r("ABC-123")],
        ),
        ("https://github.com/acme/shop/pull/57.", &[r("#57")]),
        (
            "https://github.com/Acme/Shop/issues/9#issuecomment-1",
            &[r("#9")],
        ),
        ("https://github.com/other/lib/pull/3", &[r("other/lib#3")]),
        ("https://gitea.example.org/acme/shop/pulls/4", &[r("#4")]),
        (
            "https://gitea.example.org/acme/web/pulls/4",
            &[r("acme/web#4")],
        ),
        (
            "https://bitbucket.org/acme/web/pull-requests/8/diff",
            &[r("acme/web#8")],
        ),
        (
            "https://gitlab.com/g/sub/proj/-/merge_requests/5",
            &[r("g/sub/proj!5")],
        ),
        ("https://gitlab.com/g/proj/-/issues/6", &[r("g/proj#6")]),
        ("https://acme.atlassian.net/browse/SHOP-77", &[r("SHOP-77")]),
        (
            "See merge request g/proj!12, and acme/shop#5",
            &[r("g/proj!12"), r("#5")],
        ),
        ("Merged in feature (pull request !3)", &[r("!3")]),
        ("UTF-8, SHA-256, ISO-8601-1, CVE-2024-1234, X-1.2", &[]),
        ("colour &#123; in C#12, wow!12, #0 and #12345678", &[]),
        ("P1 priority, P5", &[]),
    ];
    for (text, want) in cases {
        assert_eq!(&keys_in(text, &s), want, "{text}");
    }
}

#[test]
fn paths_in_text() {
    let cases: &[(&str, &[&str])] = &[
        (
            "Change `app/settings/theme.tsx` and ./lib/util.py.",
            &["app/settings/theme.tsx", "lib/util.py"],
        ),
        (
            "Everything under docs/ and src/**/*.rs, plus a/b/c",
            &["docs/", "src/**/*.rs", "a/b/c"],
        ),
        ("read/write, TCP/IP, 10/25/2026, and/or", &[]),
        ("README.md, Cargo.toml and Node.js", &[]),
        ("https://example.com/docs/setup.html", &[]),
        ("(see crates/fleetd/src/hub/mod.rs:12)", &[]),
    ];
    for (text, want) in cases {
        assert_eq!(paths_in(text), *want, "{text}");
    }
}

// ---- calibration on fleetd's own history ----

/// fleetd's first 401 PRs, frozen: number, merged or closed, title, files (indexes into fleetd_paths.txt).
struct Pr {
    number: u32,
    merged: bool,
    title: String,
    paths: Vec<String>,
}

fn history() -> Vec<Pr> {
    let paths: Vec<&str> = include_str!("testdata/fleetd_paths.txt").lines().collect();
    include_str!("testdata/fleetd_prs.tsv")
        .lines()
        .map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            Pr {
                number: f[0].parse().unwrap(),
                merged: f[1] == "merged",
                title: f[2].to_string(),
                paths: f[3]
                    .split_whitespace()
                    .map(|i| paths[i.parse::<usize>().unwrap()].to_string())
                    .collect(),
            }
        })
        .collect()
}

fn as_work(pr: &Pr, owner: &str) -> Work {
    let mut w = Work::read(Some(owner.into()), &pr.title, "", &scope());
    w.paths = pr.paths.clone();
    w
}

#[test]
fn distinct_merged_prs_almost_never_pair_as_strong() {
    let prs: Vec<Pr> = history()
        .into_iter()
        .filter(|p| p.merged && !p.title.starts_with("batch"))
        .collect();
    let works: Vec<Work> = prs
        .iter()
        .map(|p| as_work(p, &format!("o{}", p.number)))
        .collect();
    let (mut pairs, mut strong, mut exact) = (0usize, Vec::new(), Vec::new());
    for (i, a) in works.iter().enumerate() {
        let later: Vec<Candidate> = works[i + 1..]
            .iter()
            .zip(&prs[i + 1..])
            .map(|(w, p)| Candidate {
                id: format!("#{}", p.number),
                work: w.clone(),
                weak_only: false,
            })
            .collect();
        pairs += later.len();
        for m in matches(a, &later, &scope()) {
            let line = format!("#{} ~ {}: {}", prs[i].number, m.id, m.why);
            match m.strength {
                Exact => exact.push(line),
                Strong => strong.push(line),
                Weak => {}
            }
        }
    }
    assert!(pairs > 25_000);
    assert!(
        exact.is_empty(),
        "distinct PRs paired as exact:\n{}",
        exact.join("\n")
    );
    // 1 in 500: about 1 in 700 today, nearly all a port or a redo of the same feature.
    eprintln!("{} of {pairs} pairs strong", strong.len());
    assert!(
        strong.len() * 500 <= pairs,
        "{} of {pairs} pairs strong:\n{}",
        strong.len(),
        strong.join("\n")
    );
}

#[test]
fn a_change_matches_the_batch_that_merged_it() {
    let prs = history();
    let (mut text, mut keyed) = (0, 0);
    for batch in prs
        .iter()
        .filter(|p| p.merged && p.title.starts_with("batch"))
    {
        for part in prs
            .iter()
            .filter(|p| !p.merged && batch.title.contains(&format!("#{})", p.number)))
        {
            let against = [Candidate {
                id: format!("#{}", batch.number),
                work: as_work(batch, "train"),
                weak_only: false,
            }];
            // By its words and files, when the batch subject carries its title.
            if batch.title.contains(&part.title) {
                let got = matches(&as_work(part, "lead"), &against, &scope());
                assert!(
                    got.first().is_some_and(|m| m.strength >= Strong),
                    "#{} {:?} ~ #{}: {got:?}",
                    part.number,
                    part.title,
                    batch.number
                );
                text += 1;
            }
            // By its number, always.
            let mut w = as_work(part, "lead");
            w.keys
                .push(Key::declared(WorkKey::Ref(format!("#{}", part.number))));
            let got = matches(&w, &against, &scope());
            assert_eq!(
                got.first().map(|m| m.strength),
                Some(Exact),
                "#{} ~ #{}",
                part.number,
                batch.number
            );
            keyed += 1;
        }
    }
    assert!(
        text >= 30 && keyed >= 50,
        "{text} by text, {keyed} by number"
    );
}
