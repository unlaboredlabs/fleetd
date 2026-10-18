//! Applying a model-written unified diff to one file's text. Hunks are placed by their context and removed lines,
//! not their line numbers, which models get wrong; whitespace at line ends is ignored when nothing matches exactly.
//! Pure.
use regex::Regex;
use std::sync::LazyLock;

static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@").unwrap());

struct Hunk {
    old_start: usize,
    ops: Vec<(char, String)>,
}

fn parse(diff: &str) -> Result<Vec<Hunk>, String> {
    let normalised = diff.replace("\r\n", "\n");
    let mut lines: Vec<&str> = normalised.split('\n').collect();
    while lines.last() == Some(&"") {
        lines.pop();
    }
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in lines {
        if let Some(c) = HEADER.captures(line) {
            hunks.push(Hunk {
                old_start: c[1].parse().unwrap_or(0),
                ops: Vec::new(),
            });
            continue;
        }
        // ---, +++, diff --git and index lines before the first hunk.
        let Some(hunk) = hunks.last_mut() else {
            continue;
        };
        // "\ No newline at end of file".
        if line.starts_with('\\') {
            continue;
        }
        // A blank context line whose leading space was lost.
        let op = line.chars().next().unwrap_or(' ');
        if !matches!(op, ' ' | '-' | '+') {
            let shown: String = line.chars().take(60).collect();
            return Err(format!(
                "line \"{shown}\" is not part of a unified diff hunk"
            ));
        }
        hunk.ops.push((op, line.get(1..).unwrap_or("").to_string()));
    }
    if hunks.is_empty() {
        return Err("it has no @@ hunk".into());
    }
    Ok(hunks)
}

fn find(
    lines: &[String],
    needle: &[&str],
    from: usize,
    same: impl Fn(&str, &str) -> bool,
) -> Option<usize> {
    (from..=lines.len().checked_sub(needle.len())?).find(|&at| {
        needle
            .iter()
            .enumerate()
            .all(|(i, l)| same(&lines[at + i], l))
    })
}

/// The patched text, or why the diff does not apply.
pub fn apply_unified_diff(text: &str, diff: &str) -> Result<String, String> {
    let hunks = parse(diff).map_err(|e| format!("the diff is not a unified diff: {e}"))?;
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let mut cursor = 0;
    for (i, hunk) in hunks.iter().enumerate() {
        let old: Vec<&str> = hunk
            .ops
            .iter()
            .filter(|(op, _)| *op != '+')
            .map(|(_, l)| l.as_str())
            .collect();
        let at = if old.is_empty() {
            hunk.old_start.max(cursor).min(lines.len())
        } else {
            find(&lines, &old, cursor, |a, b| a == b)
                .or_else(|| find(&lines, &old, cursor, |a, b| a.trim_end() == b.trim_end()))
                .ok_or_else(|| {
                    format!(
                        "hunk {} of the diff does not match the current playbook",
                        i + 1
                    )
                })?
        };
        // Context lines keep the file's own text.
        let mut k = at;
        let mut next = Vec::new();
        for (op, line) in &hunk.ops {
            match op {
                ' ' => {
                    next.push(lines[k].clone());
                    k += 1;
                }
                '-' => k += 1,
                _ => next.push(line.clone()),
            }
        }
        let added = next.len();
        lines.splice(at..at + old.len(), next);
        cursor = at + added;
    }
    Ok(lines.join("\n"))
}
