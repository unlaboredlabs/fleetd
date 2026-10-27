//! What a new head changed against the approved head it rebases, read from three diffs: the approved head's own
//! patch, the new head's, and what the base gained in between. The PR's own changes are compared hunk by hunk by their
//! changed lines alone, so context that moved or that main edited around them is no change. Pure; the gate feeds it
//! GitHub's diffs.
use std::collections::BTreeMap;

/// Lines around a change of main's within which the PR's hunk counts as resolving a conflict with it: git conflicts on
/// changes that touch or abut, and context this close is what a resolution edits.
const NEAR: u32 = 3;

/// How a new head's patch stands against the approved head's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rebase {
    /// The same changed lines in the same files: the approval carries over.
    Unchanged,
    /// The changed lines differ only where the base changed since the approved head: a conflict resolution, in these
    /// files.
    Conflicts(Vec<String>),
    /// Anything else: a new or changed hunk the base never touched.
    Changed,
}

impl Rebase {
    pub fn name(&self) -> &'static str {
        match self {
            Rebase::Unchanged => "unchanged",
            Rebase::Conflicts(_) => "conflicts",
            Rebase::Changed => "changed",
        }
    }
}

#[derive(Debug)]
struct Hunk {
    /// Where it sits on each side, as `(start, length)` in its `@@` line.
    old: (u32, u32),
    new: (u32, u32),
    /// Its removed and added lines (and no-newline markers), context left out.
    body: Vec<String>,
}

#[derive(Debug, Default)]
struct File {
    /// Its header but the blob ids, which change with every edit to the file on either side; kept when it has no hunks
    /// (a binary file), whose content they are.
    header: Vec<String>,
    hunks: Vec<Hunk>,
}

/// A diff's files by their `diff --git` line.
fn files(diff: &str) -> BTreeMap<String, File> {
    let mut files = BTreeMap::<String, File>::new();
    let mut at: Option<String> = None;
    let mut index = Vec::new();
    for line in diff.lines() {
        if let Some(name) = line.strip_prefix("diff --git ") {
            at = Some(name.to_owned());
            files.entry(name.to_owned()).or_default();
            continue;
        }
        let Some(file) = at.as_ref().and_then(|name| files.get_mut(name)) else {
            continue;
        };
        if let Some(range) = line.strip_prefix("@@ ") {
            let mut sides = range.split(' ');
            let old = span(sides.next().and_then(|s| s.strip_prefix('-')));
            let new = span(sides.next().and_then(|s| s.strip_prefix('+')));
            file.hunks.push(Hunk {
                old,
                new,
                body: Vec::new(),
            });
        } else if let Some(hunk) = file.hunks.last_mut() {
            if line.starts_with(['-', '+', '\\']) {
                hunk.body.push(line.to_owned());
            }
        } else if line.starts_with("index ") {
            index.push((at.clone().unwrap_or_default(), line.to_owned()));
        } else {
            file.header.push(line.to_owned());
        }
    }
    for (name, line) in index {
        if let Some(file) = files.get_mut(&name).filter(|f| f.hunks.is_empty()) {
            file.header.push(line);
        }
    }
    files
}

/// `start,length` of a hunk side; a bare `start` is one line.
fn span(side: Option<&str>) -> (u32, u32) {
    let side = side.unwrap_or_default();
    let (start, len) = side.split_once(',').unwrap_or((side, "1"));
    (start.parse().unwrap_or(0), len.parse().unwrap_or(1))
}

fn near(a: (u32, u32), b: (u32, u32)) -> bool {
    let end = |(start, len): (u32, u32)| start + len;
    a.0 <= end(b) + NEAR && b.0 <= end(a) + NEAR
}

/// How `own`, the new head's patch, stands against `reviewed`, the approved head's, given `base`, the diff from the
/// approved head's base to the new head's. A hunk of the new patch that the approved one lacks must sit by a change of
/// the base (on the new base's lines), and so must a hunk of the approved patch the new one dropped (on the old base's
/// lines), else it is `Changed`.
pub fn compare(reviewed: &str, own: &str, base: &str) -> Rebase {
    let (reviewed, own, base) = (files(reviewed), files(own), files(base));
    let none = File::default();
    let mut conflicts = Vec::new();
    for name in reviewed
        .keys()
        .chain(own.keys().filter(|n| !reviewed.contains_key(*n)))
    {
        let (r, o) = (
            reviewed.get(name).unwrap_or(&none),
            own.get(name).unwrap_or(&none),
        );
        let bodies = |f: &File| f.hunks.iter().map(|h| h.body.clone()).collect::<Vec<_>>();
        if r.header == o.header && bodies(r) == bodies(o) {
            continue;
        }
        let Some(main) = base.get(name) else {
            return Rebase::Changed;
        };
        let resolved = unmatched(o, r)
            .map(|h| main.hunks.iter().any(|m| near(h.old, m.new)))
            .chain(unmatched(r, o).map(|h| main.hunks.iter().any(|m| near(h.old, m.old))))
            .all(|by_main| by_main);
        if !resolved {
            return Rebase::Changed;
        }
        conflicts.push(path_of(name));
    }
    if conflicts.is_empty() {
        Rebase::Unchanged
    } else {
        Rebase::Conflicts(conflicts)
    }
}

/// The hunks of `a` with no hunk of the same lines in `b`, each of `b`'s matching one at most.
fn unmatched<'a>(a: &'a File, b: &File) -> impl Iterator<Item = &'a Hunk> {
    let mut left: Vec<&Vec<String>> = b.hunks.iter().map(|h| &h.body).collect();
    a.hunks.iter().filter(
        move |h| match left.iter().position(|body| **body == h.body) {
            Some(i) => {
                left.swap_remove(i);
                false
            }
            None => true,
        },
    )
}

/// The path a `diff --git a/<path> b/<path>` line names, its new side.
fn path_of(name: &str) -> String {
    match name.rsplit_once(" b/") {
        Some((_, path)) => path.to_owned(),
        None => name.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(path: &str, hunks: &[(&str, &[&str])]) -> String {
        let mut text = format!(
            "diff --git a/{path} b/{path}\nindex 1111111..2222222 100644\n--- a/{path}\n+++ b/{path}\n"
        );
        for (range, lines) in hunks {
            text.push_str(&format!("@@ {range} @@ fn context()\n"));
            for line in *lines {
                text.push_str(line);
                text.push('\n');
            }
        }
        text
    }

    #[test]
    fn the_same_changed_lines_with_other_context_and_lines_are_unchanged() {
        let reviewed = diff(
            "a.rs",
            &[("-10,4 +10,5", &[" one", "-two", "+2", "+2b", " three"])],
        );
        // Main added lines above and edited the context: the PR's own lines are as approved, and blob ids differ.
        let own = diff(
            "a.rs",
            &[("-30,4 +30,5", &[" ONE", "-two", "+2", "+2b", " three"])],
        )
        .replace("1111111..2222222", "3333333..4444444");
        let base = diff("a.rs", &[("-1,0 +1,20", &["+new"])]);
        assert_eq!(compare(&reviewed, &own, &base), Rebase::Unchanged);
        assert_eq!(compare(&reviewed, &reviewed, ""), Rebase::Unchanged);
    }

    #[test]
    fn a_hunk_that_changed_where_main_changed_is_a_conflict_resolution() {
        let reviewed = format!(
            "{}{}",
            diff("a.rs", &[("-10,3 +10,3", &[" x", "-old", "+mine", " y"])]),
            diff("b.rs", &[("-5,1 +5,1", &["-b", "+B"])])
        );
        // Main changed line 11 of a.rs; the new head resolves it: its removed line is main's now.
        let own = format!(
            "{}{}",
            diff(
                "a.rs",
                &[("-10,3 +10,3", &[" x", "-theirs", "+mine and theirs", " y"])]
            ),
            diff("b.rs", &[("-5,1 +5,1", &["-b", "+B"])])
        );
        let base = diff("a.rs", &[("-11,1 +11,1", &["-old", "+theirs"])]);
        assert_eq!(
            compare(&reviewed, &own, &base),
            Rebase::Conflicts(vec!["a.rs".into()])
        );
    }

    #[test]
    fn a_hunk_away_from_mains_changes_or_in_a_file_main_left_is_changed() {
        let reviewed = diff("a.rs", &[("-10,1 +10,1", &["-old", "+mine"])]);
        let base = diff("a.rs", &[("-11,1 +11,1", &["-x", "+y"])]);
        // A new hunk far from main's change.
        let far = diff(
            "a.rs",
            &[
                ("-10,1 +10,1", &["-old", "+mine"]),
                ("-200,1 +200,1", &["-z", "+sneaked"]),
            ],
        );
        assert_eq!(compare(&reviewed, &far, &base), Rebase::Changed);
        // The same hunk once more, far from main's change.
        let twice = diff(
            "a.rs",
            &[
                ("-10,1 +10,1", &["-old", "+mine"]),
                ("-200,1 +200,1", &["-old", "+mine"]),
            ],
        );
        assert_eq!(compare(&reviewed, &twice, &base), Rebase::Changed);
        // A new file main never touched.
        let more = format!("{reviewed}{}", diff("c.rs", &[("-0,0 +1,1", &["+new"])]));
        assert_eq!(compare(&reviewed, &more, &base), Rebase::Changed);
        // The same hunk rewritten, in a file main left alone.
        let other = diff("a.rs", &[("-10,1 +10,1", &["-old", "+mine, rewritten"])]);
        assert_eq!(compare(&reviewed, &other, ""), Rebase::Changed);
        // A hunk dropped away from main's change.
        let two = diff(
            "a.rs",
            &[
                ("-10,1 +10,1", &["-old", "+mine"]),
                ("-200,1 +200,1", &["-z", "+w"]),
            ],
        );
        assert_eq!(compare(&two, &reviewed, &base), Rebase::Changed);
    }

    #[test]
    fn a_binary_file_is_compared_by_its_blob_ids() {
        let bin = |ids: &str| {
            format!(
                "diff --git a/i.png b/i.png\nindex {ids} 100644\nBinary files a/i.png and b/i.png differ\n"
            )
        };
        assert_eq!(compare(&bin("1..2"), &bin("1..2"), ""), Rebase::Unchanged);
        assert_eq!(compare(&bin("1..2"), &bin("1..3"), ""), Rebase::Changed);
        let base = "diff --git a/i.png b/i.png\nindex 1..5 100644\nBinary files a/i.png and b/i.png differ\n";
        assert_eq!(
            compare(&bin("1..2"), &bin("5..3"), base),
            Rebase::Conflicts(vec!["i.png".into()])
        );
    }
}
