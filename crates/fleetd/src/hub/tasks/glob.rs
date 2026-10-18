//! Repo-relative path globs for policy areas. `**` spans any number of directories (including none), `*` and `?`
//! stay within one path segment, `{a,b}` is alternation and `[...]` a character class (`[!...]` negated). A glob
//! without wildcards names a file or a directory, so "docs" covers everything under docs/. Dotfiles are not
//! special: an area check is about where a change lands, not about hiding files.
use regex::Regex;

fn strip(p: &str) -> &str {
    let mut p = p;
    while let Some(rest) = p.strip_prefix("./") {
        p = rest;
    }
    p
}

/// Index of the brace that closes the one at `open`.
fn closing_brace(glob: &[char], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, &c) in glob.iter().enumerate().skip(open) {
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// Splits a brace body on top-level commas.
fn alternatives(body: &[char]) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, &c) in body.iter().enumerate() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(body[start..i].iter().collect());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(body[start..].iter().collect());
    parts
}

fn to_source(glob: &str) -> String {
    let g: Vec<char> = glob.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < g.len() {
        let c = g[i];
        match c {
            '*' => {
                if g.get(i + 1) == Some(&'*') {
                    let at_segment_start = i == 0 || g[i - 1] == '/';
                    if at_segment_start && g.get(i + 2) == Some(&'/') {
                        out.push_str("(?:[^/]*/)*");
                        i += 3;
                        continue;
                    }
                    if at_segment_start && i + 2 == g.len() {
                        out.push_str(".*");
                        i += 2;
                        continue;
                    }
                    i += 1;
                }
                out.push_str("[^/]*");
            }
            '?' => out.push_str("[^/]"),
            '[' => {
                let close = (i + 2..g.len()).find(|&j| g[j] == ']');
                let Some(close) = close else {
                    out.push_str("\\[");
                    i += 1;
                    continue;
                };
                let body: String = g[i + 1..close].iter().collect();
                let negated = body.starts_with('!') || body.starts_with('^');
                let inner = if negated { &body[1..] } else { &body[..] };
                // JS takes the body as is; Rust's class syntax also gives `[`, `&&` and `~~` meaning, so those
                // are escaped to stay literal as in JS.
                let mut escaped = String::new();
                for ch in inner.chars() {
                    match ch {
                        '\\' => escaped.push_str("\\\\"),
                        '[' | '&' | '~' => {
                            escaped.push('\\');
                            escaped.push(ch);
                        }
                        _ => escaped.push(ch),
                    }
                }
                out.push('[');
                if negated {
                    out.push_str("^/");
                }
                out.push_str(&escaped);
                out.push(']');
                i = close;
            }
            '{' => {
                let Some(close) = closing_brace(&g, i) else {
                    out.push_str("\\{");
                    i += 1;
                    continue;
                };
                let alts: Vec<String> = alternatives(&g[i + 1..close])
                    .iter()
                    .map(|a| to_source(a))
                    .collect();
                out.push_str("(?:");
                out.push_str(&alts.join("|"));
                out.push(')');
                i = close;
            }
            _ => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    out
}

/// A compiled area glob for repo-relative paths.
pub enum GlobMatcher {
    All,
    Prefix(String),
    Pattern(Option<Regex>),
}

impl GlobMatcher {
    pub fn new(glob: &str) -> Self {
        let mut g = strip(glob.trim()).to_owned();
        if g.ends_with('/') {
            g.push_str("**");
        }
        if g.is_empty() || g == "**" {
            return Self::All;
        }
        if !g.contains(['*', '?', '[', '{']) {
            return Self::Prefix(g);
        }
        // A pattern Rust's regex refuses where JS took it matches nothing rather than everything.
        Self::Pattern(Regex::new(&format!("^{}$", to_source(&g))).ok())
    }

    pub fn is_match(&self, path: &str) -> bool {
        let p = strip(path);
        match self {
            Self::All => true,
            Self::Prefix(g) => {
                p == g
                    || p.strip_prefix(g.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
            }
            Self::Pattern(re) => re.as_ref().is_some_and(|re| re.is_match(p)),
        }
    }
}

/// Paths that no glob matches, in input order.
pub fn outside_globs<'a>(paths: &'a [String], globs: &[String]) -> Vec<&'a String> {
    let matchers: Vec<GlobMatcher> = globs.iter().map(|g| GlobMatcher::new(g)).collect();
    paths
        .iter()
        .filter(|p| !matchers.iter().any(|m| m.is_match(p)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &[(&str, &[&str], &[&str])] = &[
        ("**", &["a", "a/b/c.ts", ".github/workflows/ci.yml"], &[]),
        (
            "docs/**",
            &["docs/x.md", "docs/a/b/c.md", "docs/.keep"],
            &["docs", "docsx/a.md", "src/docs/a.md"],
        ),
        (
            "docs",
            &["docs", "docs/x.md", "docs/a/b.md"],
            &["docsx", "docs.md", "src/docs"],
        ),
        (
            "docs/",
            &["docs/x.md", "docs/a/b.md"],
            &["docs", "docsx/a.md"],
        ),
        ("./docs/**", &["docs/x.md", "./docs/x.md"], &["src/x.md"]),
        (
            "*.md",
            &["README.md", ".hidden.md"],
            &["docs/x.md", "README.mdx"],
        ),
        (
            "**/*.md",
            &["README.md", "docs/x.md", "a/b/c/d.md"],
            &["README.mdx", "docs/x.txt"],
        ),
        (
            "src/**/test",
            &["src/test", "src/a/test", "src/a/b/test"],
            &["src/test/x", "src/atest", "test"],
        ),
        (
            "apps/*/src/**",
            &["apps/hub/src/a.ts", "apps/cli/src/x/y.ts"],
            &["apps/hub/test/a.ts", "apps/a/b/src/c.ts"],
        ),
        ("src/?.ts", &["src/a.ts"], &["src/ab.ts", "src//.ts"]),
        (
            "src/**/*.{ts,tsx}",
            &["src/a.ts", "src/x/y.tsx"],
            &["src/a.js", "src/a.tsxx"],
        ),
        ("{docs,site}/**", &["docs/a", "site/b/c"], &["blog/a"]),
        (
            "file[0-9].txt",
            &["file1.txt", "file9.txt"],
            &["filea.txt", "file10.txt"],
        ),
        (
            "file[!0-9].txt",
            &["filea.txt"],
            &["file1.txt", "file/.txt"],
        ),
        ("a.b(c)+$^|.txt", &["a.b(c)+$^|.txt"], &["aXb(c)+$^|.txt"]),
        (
            "packages/contracts/src/tasks.ts",
            &["packages/contracts/src/tasks.ts"],
            &["packages/contracts/src/tasks.test.ts"],
        ),
        ("weird]name}/**", &["weird]name}/a"], &["weird/a"]),
        ("unclosed[x/**", &["unclosed[x/a"], &["unclosedx/a"]),
    ];

    #[test]
    fn glob_matcher() {
        for (glob, matches, misses) in CASES {
            let m = GlobMatcher::new(glob);
            for p in *matches {
                assert!(m.is_match(p), "{glob} should match {p}");
            }
            for p in *misses {
                assert!(!m.is_match(p), "{glob} should not match {p}");
            }
        }
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn outside_keeps_uncovered_paths_in_order() {
        let paths = strings(&[
            "docs/x.md",
            "README.md",
            "apps/hub/src/tasks/Tasks.ts",
            "apps/web/x.ts",
            "packages/contracts/src/tasks.ts",
        ]);
        let globs = strings(&["docs/**", "apps/hub/**", "packages/contracts/src/tasks.ts"]);
        assert_eq!(
            outside_globs(&paths, &globs),
            vec!["README.md", "apps/web/x.ts"]
        );
        let ab = strings(&["a", "b/c"]);
        assert_eq!(outside_globs(&ab, &[]), vec!["a", "b/c"]);
        assert!(outside_globs(&ab, &strings(&["**"])).is_empty());
    }
}
