//! A readable unified diff: one header per file with its +/- counts, quiet hunk headers, old and new line
//! numbers in two grey gutters, and tinted added and removed lines. `git diff`'s index/---/+++ lines carry
//! nothing a reader needs, so they are dropped. Virtualised, so a long diff costs only what is on screen. Long
//! lines scroll sideways rather than being cut off.
//!
//! `uniform_list` gives every row the height of the one it measures, here the widest; so every row, the file
//! header included, is exactly one line tall.

use gpui::{Context, Div, ListHorizontalSizingBehavior, SharedString, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list};

use crate::diff::{DiffKind, DiffLine, parse_unified};
use crate::theme::{STRONG, metric, size, theme};

/// What a reader sees per row.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Row {
    File { path: String, added: usize, removed: usize },
    Hunk(String),
    Line(DiffLine),
}

pub struct DiffView {
    rows: Vec<Row>,
    /// The row with the most characters: the list takes its width from it.
    widest: usize,
    scroll: UniformListScrollHandle,
}

impl DiffView {
    pub fn new(text: &str) -> Self {
        let rows = rows(&parse_unified(text));
        Self { widest: widest(&rows), rows, scroll: UniformListScrollHandle::new() }
    }

    /// (files, lines added, lines removed), for a summary line.
    pub fn totals(&self) -> (usize, usize, usize) {
        self.rows.iter().fold((0, 0, 0), |(f, a, r), row| match row {
            Row::File { added, removed, .. } => (f + 1, a + added, r + removed),
            _ => (f, a, r),
        })
    }

    fn row(&self, ix: usize, cx: &Context<Self>) -> Div {
        let t = theme(cx);
        let line = div().w_full().h(px(metric::LINE)).flex().items_center().whitespace_nowrap().overflow_hidden();
        let gutter = |n: Option<u32>| {
            div()
                .w(px(44.))
                .flex_none()
                .pr_2()
                .flex()
                .justify_end()
                .text_color(t.quiet)
                .text_size(px(size::XS))
                .child(n.map(|n| n.to_string()).unwrap_or_default())
        };
        match &self.rows[ix] {
            Row::File { path, added, removed } => div()
                .w_full()
                .h(px(metric::LINE))
                .px_3()
                .flex()
                .items_center()
                .gap_3()
                .border_b_1()
                .border_color(t.hairline)
                .font_family(t.ui_font.clone())
                .child(div().font_weight(STRONG).text_size(px(size::MD)).child(path.clone()))
                .child(div().text_size(px(size::XS)).text_color(t.success).child(format!("+{added}")))
                .child(div().text_size(px(size::XS)).text_color(t.danger).child(format!("−{removed}"))),
            Row::Hunk(text) => line.bg(t.hover).text_color(t.quiet).child(div().w(px(88.)).flex_none()).child(text.clone()),
            Row::Line(l) => {
                let (bg, sign, sign_color) = match l.kind {
                    DiffKind::Added => (Some(t.diff_add), "+", t.success),
                    DiffKind::Removed => (Some(t.diff_del), "−", t.danger),
                    _ => (None, " ", t.quiet),
                };
                line.when_some(bg, |d, bg| d.bg(bg))
                    .child(gutter(l.old))
                    .child(gutter(l.new))
                    .child(div().w(px(14.)).flex_none().text_color(sign_color).child(sign))
                    .child(SharedString::from(l.text.clone()))
            }
        }
    }
}

impl Render for DiffView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme(cx);
        if self.rows.is_empty() {
            return div().p_4().text_color(t.quiet).child("No changes.").into_any_element();
        }
        uniform_list(
            "diff",
            self.rows.len(),
            cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.row(ix, cx)).collect::<Vec<_>>()),
        )
        .track_scroll(&self.scroll)
        .with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained)
        .with_width_from_item(Some(self.widest))
        .size_full()
        .font_family(t.mono_font.clone())
        .text_size(px(size::SM))
        .text_color(t.text)
        .into_any_element()
    }
}

/// True when `text` reads as a unified diff (an Edit's or `git diff`'s output in a lead log).
pub fn looks_like_diff(text: &str) -> bool {
    text.lines().any(|l| l.starts_with("@@ -")) && text.lines().any(|l| l.starts_with('+') || l.starts_with('-'))
}

fn widest(rows: &[Row]) -> usize {
    let width = |row: &Row| match row {
        Row::File { path, .. } => path.chars().count() + 12,
        Row::Hunk(text) => text.chars().count(),
        Row::Line(l) => l.text.chars().count() + 10,
    };
    rows.iter().enumerate().max_by_key(|(_, r)| width(r)).map_or(0, |(ix, _)| ix)
}

fn rows(lines: &[DiffLine]) -> Vec<Row> {
    let mut out = Vec::new();
    let mut file_ix = None;
    for line in lines {
        match line.kind {
            DiffKind::File => {
                if let Some(path) = line.text.strip_prefix("diff --git a/").and_then(|rest| rest.split_once(" b/")).map(|(_, b)| b) {
                    file_ix = Some(out.len());
                    out.push(Row::File { path: path.to_string(), added: 0, removed: 0 });
                } else if let Some(path) = line.text.strip_prefix("+++ b/").filter(|_| file_ix.is_none()) {
                    // A bare diff with no `diff --git` line: name the file from its +++ header.
                    file_ix = Some(out.len());
                    out.push(Row::File { path: path.to_string(), added: 0, removed: 0 });
                }
            }
            DiffKind::Hunk => out.push(Row::Hunk(line.text.clone())),
            kind => {
                if let Some(Row::File { added, removed, .. }) = file_ix.and_then(|ix| out.get_mut(ix)) {
                    match kind {
                        DiffKind::Added => *added += 1,
                        DiffKind::Removed => *removed += 1,
                        _ => {}
                    }
                }
                out.push(Row::Line(line.clone()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_FILES: &str = "\
diff --git a/src/a.rs b/src/a.rs
index 1111111..2222222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,2 +1,2 @@ fn main() {
 let a = 1;
-let b = 2;
+let b = 3;
diff --git a/src/b.rs b/src/b.rs
--- a/src/b.rs
+++ b/src/b.rs
@@ -0,0 +1,2 @@
+x
+y
";

    #[test]
    fn one_header_per_file_with_its_counts_and_no_git_plumbing() {
        let rows = rows(&parse_unified(TWO_FILES));
        assert_eq!(rows[0], Row::File { path: "src/a.rs".into(), added: 1, removed: 1 });
        assert!(matches!(&rows[1], Row::Hunk(h) if h.starts_with("@@ -1,2")));
        assert_eq!(rows.iter().filter(|r| matches!(r, Row::File { .. })).count(), 2);
        assert!(rows.contains(&Row::File { path: "src/b.rs".into(), added: 2, removed: 0 }));
        assert!(!rows.iter().any(|r| matches!(r, Row::Line(l) if l.text.starts_with("index") || l.text.starts_with("--- "))));
        let view = DiffView { widest: widest(&rows), rows, scroll: UniformListScrollHandle::new() };
        assert_eq!(view.totals(), (2, 3, 1));
    }

    #[test]
    fn a_bare_hunk_is_named_from_its_plus_header() {
        let rows = rows(&parse_unified("--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n+new\n"));
        assert_eq!(rows[0], Row::File { path: "x.md".into(), added: 1, removed: 1 });
    }

    #[test]
    fn recognises_diffs_in_tool_output() {
        assert!(looks_like_diff("@@ -1 +1 @@\n-a\n+b"));
        assert!(!looks_like_diff("test result: ok. 3 passed\n- not a hunk"));
    }
}
