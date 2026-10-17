//! Unified diff parsing into display rows with old/new line numbers.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffKind {
    File,
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

/// Parses `git diff` output. Lines outside a hunk (`diff --git`, `index`, `---`, `+++`) are file
/// headers; inside a hunk the old/new counters advance per the `@@ -a,b +c,d @@` header.
pub fn parse_unified(input: &str) -> Vec<DiffLine> {
    let mut out = Vec::new();
    let (mut old, mut new) = (0u32, 0u32);
    let (mut old_left, mut new_left) = (0u32, 0u32);
    for raw in input.lines() {
        let in_hunk = old_left > 0 || new_left > 0;
        if !in_hunk || raw.starts_with("@@") {
            if let Some((o, n, oc, nc)) = parse_hunk_header(raw) {
                (old, new, old_left, new_left) = (o, n, oc, nc);
                out.push(line(DiffKind::Hunk, None, None, raw));
            } else {
                out.push(line(DiffKind::File, None, None, raw));
            }
            continue;
        }
        let (kind, body) = match raw.as_bytes().first() {
            Some(b'+') => (DiffKind::Added, &raw[1..]),
            Some(b'-') => (DiffKind::Removed, &raw[1..]),
            Some(b' ') => (DiffKind::Context, &raw[1..]),
            Some(b'\\') => {
                out.push(line(DiffKind::File, None, None, raw));
                continue;
            }
            _ => (DiffKind::Context, raw),
        };
        let row = match kind {
            DiffKind::Added => {
                new_left = new_left.saturating_sub(1);
                new += 1;
                line(kind, None, Some(new - 1), body)
            }
            DiffKind::Removed => {
                old_left = old_left.saturating_sub(1);
                old += 1;
                line(kind, Some(old - 1), None, body)
            }
            _ => {
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
                old += 1;
                new += 1;
                line(kind, Some(old - 1), Some(new - 1), body)
            }
        };
        out.push(row);
    }
    out
}

fn line(kind: DiffKind, old: Option<u32>, new: Option<u32>, text: &str) -> DiffLine {
    DiffLine { kind, old, new, text: text.to_string() }
}

/// `@@ -12,7 +12,9 @@ ...` -> (12, 12, 7, 9). A missing count means 1.
fn parse_hunk_header(s: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = s.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |r: &str| -> Option<(u32, u32)> {
        match r.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((r.parse().ok()?, 1)),
        }
    };
    let (o, oc) = range(old)?;
    let (n, nc) = range(new)?;
    Some((o, n, oc, nc))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,5 @@ export function train() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
 }
@@ -40 +41 @@
-x
+y
";

    #[test]
    fn numbers_lines_per_hunk_header() {
        let rows = parse_unified(SAMPLE);
        let numbered: Vec<_> = rows.iter().map(|r| (r.kind, r.old, r.new)).collect();
        use DiffKind::*;
        assert_eq!(
            numbered,
            vec![
                (File, None, None),
                (File, None, None),
                (File, None, None),
                (File, None, None),
                (Hunk, None, None),
                (Context, Some(10), Some(10)),
                (Removed, Some(11), None),
                (Added, None, Some(11)),
                (Added, None, Some(12)),
                (Context, Some(12), Some(13)),
                (Context, Some(13), Some(14)),
                (Hunk, None, None),
                (Removed, Some(40), None),
                (Added, None, Some(41)),
            ]
        );
        assert_eq!(rows[7].text, "const b = 3;");
    }

    #[test]
    fn header_lines_after_a_hunk_are_not_hunk_body() {
        let two_files = format!("{SAMPLE}diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-p\n+q\n");
        let rows = parse_unified(&two_files);
        let kinds: Vec<_> = rows[14..].iter().map(|r| r.kind).collect();
        use DiffKind::*;
        assert_eq!(kinds, vec![File, File, File, Hunk, Removed, Added]);
    }

    #[test]
    fn generated_fixture_is_consistent() {
        let text = crate::fake::diff_text();
        let rows = parse_unified(&text);
        assert!(rows.len() >= 1000, "fixture should be ~1k lines, got {}", rows.len());
        // Every body line was claimed by a hunk header: no `+`/`-` lines leak out as file headers.
        assert!(
            rows.iter().filter(|r| r.kind == DiffKind::File).all(|r| r.text.starts_with("diff --git")
                || r.text.starts_with("index ")
                || r.text.starts_with("--- ")
                || r.text.starts_with("+++ "))
        );
    }
}
