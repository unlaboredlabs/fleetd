//! What a new head changed against the approved head it rebases, read from three diffs: the approved head's own
//! patch, the new head's, and what the base gained in between. The PR's own changes are compared block by block (each
//! run of removed and added lines) by their lines and their place: an approved block is unchanged where it sits where
//! the base's line shifts move it and the base changed nothing next to it, whatever the context lines around it say.
//! Pure; the gate feeds it GitHub's diffs.
use std::collections::BTreeMap;

/// How a new head's patch stands against the approved head's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rebase {
    /// The same changed lines in the same places of the same files: the approval carries over.
    Unchanged,
    /// The changed lines differ only next to lines the base changed since the approved head: a conflict resolution, in
    /// these files.
    Conflicts(Vec<String>),
    /// Anything else: a new, changed or moved block the base never touched.
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

/// One run of removed and added lines.
#[derive(Debug)]
struct Block {
    /// Where it sits on each side, as (first line, lines): the lines it removes from the old side, and adds on the
    /// new. A block that only adds sits before its old side's first line, with none.
    old: (u32, u32),
    new: (u32, u32),
    /// Its removed and added lines (and no-newline markers).
    body: Vec<String>,
}

#[derive(Debug, Default)]
struct File {
    /// Its header but the blob ids, which change with every edit to the file on either side; kept when it has no
    /// changed lines (a binary file), whose content they are.
    header: Vec<String>,
    blocks: Vec<Block>,
}

/// A diff's files by their `diff --git` line.
fn files(diff: &str) -> BTreeMap<String, File> {
    let mut files = BTreeMap::<String, File>::new();
    let mut at: Option<String> = None;
    let mut index = Vec::new();
    // In a hunk: the next line on each side, and whether the last line was a change.
    let mut pos: Option<(u32, u32, bool)> = None;
    for line in diff.lines() {
        if let Some(name) = line.strip_prefix("diff --git ") {
            at = Some(name.to_owned());
            files.entry(name.to_owned()).or_default();
            pos = None;
            continue;
        }
        let Some(file) = at.as_ref().and_then(|name| files.get_mut(name)) else {
            continue;
        };
        if let Some(range) = line.strip_prefix("@@ ") {
            let mut sides = range.split(' ');
            let old = first(sides.next().and_then(|s| s.strip_prefix('-')));
            let new = first(sides.next().and_then(|s| s.strip_prefix('+')));
            pos = Some((old, new, false));
            continue;
        }
        let Some((old, new, changing)) = pos.as_mut() else {
            if line.starts_with("index ") {
                index.push((at.clone().unwrap_or_default(), line.to_owned()));
            } else {
                file.header.push(line.to_owned());
            }
            continue;
        };
        let change = line.starts_with(['-', '+']);
        if change && !*changing {
            file.blocks.push(Block {
                old: (*old, 0),
                new: (*new, 0),
                body: Vec::new(),
            });
        }
        if change || (line.starts_with('\\') && *changing) {
            let block = file.blocks.last_mut().expect("a block");
            block.body.push(line.to_owned());
            if line.starts_with('-') {
                block.old.1 += 1;
                *old += 1;
            } else if line.starts_with('+') {
                block.new.1 += 1;
                *new += 1;
            }
            *changing = true;
        } else if !line.starts_with('\\') {
            *old += 1;
            *new += 1;
            *changing = false;
        }
    }
    for (name, line) in index {
        if let Some(file) = files.get_mut(&name).filter(|f| f.blocks.is_empty()) {
            file.header.push(line);
        }
    }
    files
}

/// The first line of a hunk side, `start,length`: an empty side's start is the line before it.
fn first(side: Option<&str>) -> u32 {
    let side = side.unwrap_or_default();
    let (start, len) = side.split_once(',').unwrap_or((side, "1"));
    let start: u32 = start.parse().unwrap_or(0);
    if len == "0" { start + 1 } else { start }
}

/// Whether two blocks' lines overlap or abut, as git's merge conflicts on.
fn touch(a: (u32, u32), b: (u32, u32)) -> bool {
    a.0 <= b.0 + b.1 && b.0 <= a.0 + a.1
}

/// How `own`, the new head's patch, stands against `reviewed`, the approved head's, given `base`, the diff from the
/// approved head's base to the new head's. An approved block is matched by a new block of the same lines where the
/// base's blocks above it move it to, unless a base block touches it. A new block left unmatched must touch a base
/// block (on the new base's lines), and so must an approved block left unmatched (on the old base's), else it is
/// `Changed`.
pub fn compare(reviewed: &str, own: &str, base: &str) -> Rebase {
    let (reviewed, own, base) = (files(reviewed), files(own), files(base));
    let none = File::default();
    let mut conflicts = Vec::new();
    for name in reviewed
        .keys()
        .chain(own.keys().filter(|n| !reviewed.contains_key(*n)))
    {
        let r = reviewed.get(name).unwrap_or(&none);
        let o = own.get(name).unwrap_or(&none);
        let main = base.get(name).unwrap_or(&none);
        let touched = |b: &Block| main.blocks.iter().any(|m| touch(b.old, m.old));
        // Where each approved block the base left alone sits now: moved by the base's blocks above it.
        let spots: Vec<Option<u32>> = r
            .blocks
            .iter()
            .map(|b| {
                let shift: i64 = main
                    .blocks
                    .iter()
                    .filter(|m| m.old.0 + m.old.1 < b.old.0)
                    .map(|m| i64::from(m.new.1) - i64::from(m.old.1))
                    .sum();
                let at = u32::try_from(i64::from(b.old.0) + shift).unwrap_or(0);
                (!touched(b)).then_some(at)
            })
            .collect();
        let mut kept = vec![false; r.blocks.len()];
        let mut added = Vec::new();
        for b in &o.blocks {
            let same = (0..r.blocks.len())
                .find(|&i| !kept[i] && spots[i] == Some(b.old.0) && r.blocks[i].body == b.body);
            match same {
                Some(i) => kept[i] = true,
                None => added.push(b),
            }
        }
        // An approved block the base left alone that is gone, changed or moved.
        let stray = (0..r.blocks.len()).any(|i| spots[i].is_some() && !kept[i]);
        let touched_any = spots.iter().any(Option::is_none);
        if r.header == o.header && added.is_empty() && !stray && !touched_any {
            continue;
        }
        let resolved = !stray
            && (r.header == o.header || base.contains_key(name))
            && added
                .iter()
                .all(|b| main.blocks.iter().any(|m| touch(b.old, m.new)));
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
    fn the_same_blocks_where_mains_shifts_move_them_are_unchanged() {
        let reviewed = diff(
            "a.rs",
            &[("-10,3 +10,4", &[" one", "-two", "+2", "+2b", " three"])],
        );
        // Main added 20 lines above: the block sits 20 lines down, as approved; blob ids differ.
        let added = vec!["+new"; 20];
        let base = diff("a.rs", &[("-0,0 +1,20", &added)]);
        let own = diff(
            "a.rs",
            &[("-30,3 +30,4", &[" one", "-two", "+2", "+2b", " three"])],
        )
        .replace("1111111..2222222", "3333333..4444444");
        assert_eq!(compare(&reviewed, &own, &base), Rebase::Unchanged);
        assert_eq!(compare(&reviewed, &reviewed, ""), Rebase::Unchanged);
        // Main edited a context line, with a line between it and the block: git merges it cleanly.
        let base = diff("a.rs", &[("-9,1 +9,1", &["-nine", "+NINE"])]);
        let own = diff(
            "a.rs",
            &[("-10,3 +10,4", &[" one", "-two", "+2", "+2b", " three"])],
        );
        assert_eq!(compare(&reviewed, &own, &base), Rebase::Unchanged);
        // The same block, but not where main's shifts put it.
        let off = diff(
            "a.rs",
            &[("-12,3 +12,4", &[" one", "-two", "+2", "+2b", " three"])],
        );
        assert_eq!(compare(&reviewed, &off, ""), Rebase::Changed);
    }

    #[test]
    fn the_same_lines_moved_elsewhere_are_changed() {
        let reviewed = diff(
            "a.rs",
            &[("-20,2 +20,3", &[" fn a() {", "+    check_auth()?;", " }"])],
        );
        let own = diff(
            "a.rs",
            &[("-40,2 +40,3", &[" fn b() {", "+    check_auth()?;", " }"])],
        );
        assert_eq!(compare(&reviewed, &own, ""), Rebase::Changed);
        let base = diff("a.rs", &[("-80,1 +80,1", &["-x", "+y"])]);
        assert_eq!(compare(&reviewed, &own, &base), Rebase::Changed);
    }

    #[test]
    fn both_sides_adding_at_one_spot_is_a_conflict_resolution() {
        let reviewed = diff("a.rs", &[("-5,2 +5,3", &[" a", "+mine", " b"])]);
        let base = diff("a.rs", &[("-5,2 +5,3", &[" a", "+theirs", " b"])]);
        // The added line is the same, after main's now: still a resolution, which is looked at.
        let after = diff("a.rs", &[("-5,3 +5,4", &[" a", " theirs", "+mine", " b"])]);
        assert_eq!(
            compare(&reviewed, &after, &base),
            Rebase::Conflicts(vec!["a.rs".into()])
        );
        let before = diff("a.rs", &[("-5,3 +5,4", &[" a", "+mine", " theirs", " b"])]);
        assert_eq!(
            compare(&reviewed, &before, &base),
            Rebase::Conflicts(vec!["a.rs".into()])
        );
    }

    #[test]
    fn a_block_that_changed_where_main_changed_is_a_conflict_resolution() {
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
    fn a_block_away_from_mains_changes_or_in_a_file_main_left_is_changed() {
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
