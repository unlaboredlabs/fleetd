//! Clickable URLs and file paths inside text the hub sends (asks, lead logs, doctor messages). URLs open in
//! the browser. A path opens in the OS's default app for it when the file is on this computer; when it is on
//! another machine it is copied instead, and the caller says so.

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui::{App, ClipboardItem, HighlightStyle, InteractiveText, SharedString, StyledText, UnderlineStyle, Window, px};

use crate::theme::Theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    Url(String),
    /// As written, without a trailing `:line[:col]`.
    Path {
        path: String,
        line: Option<u32>,
    },
}

/// Finds links in `text`; ranges are byte offsets.
pub fn find(text: &str) -> Vec<(Range<usize>, Link)> {
    tokens(text)
        .filter_map(|(start, end)| link_at(text, start, end))
        .map(|(range, url)| {
            let token = &text[range.clone()];
            let link = if url {
                Link::Url(token.to_string())
            } else {
                let (path, line) = split_line(token);
                Link::Path { path: path.to_string(), line }
            };
            (range, link)
        })
        .collect()
}

/// Whether `text` has any link, without allocating (the log asks this of every line it holds).
pub fn has_link(text: &str) -> bool {
    tokens(text).any(|(start, end)| link_at(text, start, end).is_some())
}

/// Runs of text between whitespace, brackets, quotes and commas.
fn tokens(text: &str) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut start = None;
    text.char_indices().chain(std::iter::once((text.len(), ' '))).filter_map(move |(i, ch)| {
        let delimiter = ch.is_whitespace() || matches!(ch, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '"' | '\'' | '`' | ',');
        match (delimiter, start) {
            (false, None) => {
                start = Some(i);
                None
            }
            (true, Some(s)) => {
                start = None;
                Some((s, i))
            }
            _ => None,
        }
    })
}

/// The link in a token, without trailing punctuation, and whether it is a URL (else a path).
fn link_at(text: &str, start: usize, end: usize) -> Option<(Range<usize>, bool)> {
    let token = text[start..end].trim_end_matches(['.', ';', '!', '?']);
    let token = token.strip_suffix(':').unwrap_or(token);
    let range = start..start + token.len();
    if token.starts_with("https://") || token.starts_with("http://") {
        return (token.len() > "https://".len()).then_some((range, true));
    }
    if token.contains("://") {
        return None;
    }
    looks_like_path(split_line(token).0).then_some((range, false))
}

/// `src/a.rs:12:4` -> ("src/a.rs", Some(12)).
fn split_line(token: &str) -> (&str, Option<u32>) {
    let mut path = token;
    let mut line = None;
    for _ in 0..2 {
        match path.rsplit_once(':') {
            Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
                line = n.parse().ok();
                path = head;
            }
            _ => break,
        }
    }
    (path, line)
}

/// A path has a slash and either an anchored start (`/`, `./`, `../`, `~/`) with two or more parts or an
/// extension (`./run.sh`), or two or more parts ending in an extension (`crates/a/b.rs`). That keeps "and/or", "/healthz" and "1/2" plain text.
fn looks_like_path(s: &str) -> bool {
    if !s.contains('/') || s.contains("//") || !s.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~' | '+' | '@')) {
        return false;
    }
    let (mut parts, mut last) = (0, "");
    for part in s.split('/').filter(|p| !p.is_empty() && *p != "." && *p != ".." && *p != "~") {
        parts += 1;
        last = part;
    }
    let anchored = s.starts_with('/') || s.starts_with("./") || s.starts_with("../") || s.starts_with("~/");
    let has_ext = last.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && !ext.is_empty() && ext.chars().all(char::is_alphanumeric));
    (anchored && (parts >= 2 || has_ext)) || (parts >= 2 && has_ext)
}

/// Where a path from `machine`'s project at `workspace_root` would be on this computer, if it is here.
pub fn local_path(path: &str, workspace_root: Option<&str>, home: Option<&Path>) -> PathBuf {
    if let (Some(rest), Some(home)) = (path.strip_prefix("~/"), home) {
        return home.join(rest);
    }
    let p = Path::new(path);
    match workspace_root {
        Some(root) if p.is_relative() => Path::new(root).join(p),
        _ => p.to_path_buf(),
    }
}

/// Called with the clicked link.
pub type OnOpen = Rc<dyn Fn(&Link, &mut Window, &mut App)>;

/// What happened when a link was clicked, for the caller to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opened {
    Browser,
    App,
    /// Not on this computer: copied to the clipboard.
    Copied(String),
}

/// Opens a link. `workspace_root` resolves relative paths (the project's root, which is local only when the
/// project's machine is this computer).
pub fn open(link: &Link, workspace_root: Option<&str>, cx: &mut App) -> Opened {
    match link {
        Link::Url(url) => {
            cx.open_url(url);
            Opened::Browser
        }
        Link::Path { path, .. } => {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let local = local_path(path, workspace_root, home.as_deref());
            if local.exists() {
                cx.open_with_system(&local);
                Opened::App
            } else {
                cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
                Opened::Copied(path.clone())
            }
        }
    }
}

/// `text` with its links clickable. Loud links (in an ask) are accent and underlined; quiet ones (in a log, where
/// most lines name a file) keep the text colour over a faint underline. `on_open` gets the clicked link.
pub fn text(t: &Theme, id: impl Into<SharedString>, text: impl Into<SharedString>, loud: bool, on_open: OnOpen) -> InteractiveText {
    let text = text.into();
    let links = find(&text);
    let style = HighlightStyle {
        color: loud.then_some(t.accent),
        underline: Some(UnderlineStyle {
            thickness: px(1.),
            color: Some(if loud { t.accent.opacity(0.4) } else { t.faint.opacity(0.6) }),
            wavy: false,
        }),
        ..Default::default()
    };
    let ranges: Vec<Range<usize>> = links.iter().map(|(r, _)| r.clone()).collect();
    let styled = StyledText::new(text).with_highlights(ranges.iter().map(|r| (r.clone(), style)));
    InteractiveText::new(gpui::ElementId::Name(id.into()), styled).on_click(ranges, move |ix, window, cx| {
        if let Some((_, link)) = links.get(ix) {
            on_open(link, window, cx);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str) -> Vec<(&str, Link)> {
        find(text).into_iter().map(|(r, l)| (&text[r], l)).collect()
    }

    fn path(p: &str, line: Option<u32>) -> Link {
        Link::Path { path: p.into(), line }
    }

    #[test]
    fn finds_urls_without_trailing_punctuation() {
        assert_eq!(
            found("See https://github.com/a/b/pull/12. Or (http://127.0.0.1:4790/healthz)!"),
            vec![
                ("https://github.com/a/b/pull/12", Link::Url("https://github.com/a/b/pull/12".into())),
                ("http://127.0.0.1:4790/healthz", Link::Url("http://127.0.0.1:4790/healthz".into())),
            ]
        );
    }

    #[test]
    fn finds_paths_with_line_numbers_inside_tool_calls() {
        assert_eq!(
            found("● Read(crates/fleetd/src/hub/train/mod.rs)"),
            vec![("crates/fleetd/src/hub/train/mod.rs", path("crates/fleetd/src/hub/train/mod.rs", None))]
        );
        assert_eq!(found("error at src/a.rs:12:4: boom"), vec![("src/a.rs:12:4", path("src/a.rs", Some(12)))]);
        assert_eq!(
            found("wrote ~/notes/today and ./run.sh."),
            vec![("~/notes/today", path("~/notes/today", None)), ("./run.sh", path("./run.sh", None))]
        );
        assert_eq!(found("/home/wynn/src/fleetd"), vec![("/home/wynn/src/fleetd", path("/home/wynn/src/fleetd", None))]);
    }

    #[test]
    fn leaves_prose_and_api_routes_alone() {
        assert!(found("and/or 1/2 the /healthz route, w/o tests, ok/fail").is_empty());
        assert!(found("ssh://forge/repo git@github.com:a/b").is_empty());
    }

    #[test]
    fn resolves_relative_paths_against_the_workspace() {
        let home = Path::new("/home/u");
        assert_eq!(local_path("src/a.rs", Some("/w/fleetd"), Some(home)), Path::new("/w/fleetd/src/a.rs"));
        assert_eq!(local_path("/etc/hosts", Some("/w/fleetd"), Some(home)), Path::new("/etc/hosts"));
        assert_eq!(local_path("~/x/y.md", None, Some(home)), Path::new("/home/u/x/y.md"));
    }
}
