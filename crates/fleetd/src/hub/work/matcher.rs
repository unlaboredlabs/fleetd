//! The work matcher: compares a new intent with the work already in flight and says which of it the intent may
//! repeat, how sure it is, and why ("3 shared words: dark, mode, toggle; same file app/theme.ts"). Pure and
//! deterministic. It knows nothing of tasks, claims or the store: callers turn their rows into `Candidate`s, keep
//! only the ones in the scope's repo and base (and landings from the last 14 days), and decide what each strength
//! does. Nothing here assumes a language, a host or a repo layout.
//!
//! - exact: the same item held by another owner, or the same issue, PR or branch, declared by the intent and
//!   declared or written in a title by the other. Ids someone chose on purpose, so it is the only tier that may
//!   refuse outright.
//! - strong: titles that share most of their words, or share words and most of their files; or a key the intent
//!   only writes ("fix: regression from #57"). A one-time refusal: the caller passes the id in `notDuplicateOf`
//!   with a reason.
//! - weak: two shared words, or one shared file. Only listed.
use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use fleetd_contracts::projects::short_remote;
use regex::Regex;

/// Strong on text alone: this share of the smaller title's words, and at least `STRONG_SHARED` of them.
pub const STRONG_SCORE: f64 = 0.6;
pub const STRONG_SHARED: usize = 3;
/// Strong on text and files: this share of words, at least 2 of them, and at least `STRONG_PATH_SHARE` of the
/// smaller path list in common. Big changes share a central file or two with most others; that alone says little.
pub const STRONG_FILE_SCORE: f64 = 0.4;
pub const STRONG_PATH_SHARE: f64 = 0.5;
/// Weak: this many shared words, or any shared file.
pub const WEAK_SHARED: usize = 2;

/// An id that names one piece of work.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WorkKey {
    /// An issue, PR or merge request: `#12` or `!12` in the scope's repo, `ABC-123` in a tracker, or
    /// `owner/repo#12` in another repo.
    Ref(String),
    Branch(String),
}

impl std::fmt::Display for WorkKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkKey::Ref(r) => f.write_str(r),
            WorkKey::Branch(b) => write!(f, "branch {b}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub key: WorkKey,
    pub from: KeyFrom,
}

/// Where a key came from, surest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum KeyFrom {
    /// A field the caller set: a task's item, a Change's PR, a claim's `--issue`, a landing's PR.
    Declared,
    /// Written in a title. Enough on the other side ("feat: dark mode (#57)" landed), not on the intent's: a
    /// follow-up names what it follows ("fix: regression from #57").
    Title,
    /// Mentioned in a prompt's body: a "#333" colour, "see #12 for context".
    Body,
}

impl Key {
    pub fn declared(key: WorkKey) -> Self {
        Self {
            key,
            from: KeyFrom::Declared,
        }
    }
}

/// The repo and base being matched in. `repo` (any remote form) turns its own PR and issue URLs and `owner/repo#12`
/// into `#12`, so they meet the bare refs in titles; `base` is never a work branch.
#[derive(Debug, Clone, Default)]
pub struct Scope {
    pub repo: Option<String>,
    pub base: Option<String>,
}

/// One piece of work, new or in flight.
#[derive(Debug, Clone, Default)]
pub struct Work {
    /// Who holds it: a lead, an agent key, a person's session. The same item held by its own owner is a split, not
    /// a duplicate. None matches no one.
    pub owner: Option<String>,
    pub title: String,
    pub keys: Vec<Key>,
    /// Repo-relative paths, as given; `dir/` and globs (`app/settings/**`) cover what they name.
    pub paths: Vec<String>,
}

impl Work {
    /// The keys and paths in a title and a prompt. Callers add what was declared (`Key::declared`, `paths`).
    pub fn read(owner: Option<String>, title: &str, body: &str, scope: &Scope) -> Self {
        let mut work = Self {
            owner,
            title: title.to_string(),
            ..Self::default()
        };
        work.keys
            .extend(keys_in(title, scope).into_iter().map(|key| Key {
                key,
                from: KeyFrom::Title,
            }));
        work.keys
            .extend(keys_in(body, scope).into_iter().map(|key| Key {
                key,
                from: KeyFrom::Body,
            }));
        work.paths = paths_in(title).into_iter().chain(paths_in(body)).collect();
        work
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    /// `T12`, `C7`, `X4`, `owner/repo#57`: what the caller shows and what `notDuplicateOf` names.
    pub id: String,
    pub work: Work,
    /// Expired claims: listed at most, whatever they match.
    pub weak_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Strength {
    Weak,
    Strong,
    Exact,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub id: String,
    pub strength: Strength,
    /// "same #42", "3 shared words: dark, mode, toggle; same file app/theme.ts".
    pub why: String,
}

/// Every candidate the intent may repeat, strongest first; the rest are left out.
pub fn matches(intent: &Work, candidates: &[Candidate], scope: &Scope) -> Vec<Match> {
    let words = Words::of(&intent.title);
    let mut found: Vec<(Rank, Match)> = candidates
        .iter()
        .filter_map(|c| compare(intent, &words, c, scope))
        .collect();
    found.sort_by(|(a, am), (b, bm)| b.cmp(a).then_with(|| am.id.cmp(&bm.id)));
    found.into_iter().map(|(_, m)| m).collect()
}

/// Orders matches: strength, then shared keys, then the words' share (in thousandths), then shared words and files.
type Rank = (Strength, usize, u32, usize, usize);

fn compare(intent: &Work, words: &Words, c: &Candidate, scope: &Scope) -> Option<(Rank, Match)> {
    let same_owner = intent.owner.is_some() && intent.owner == c.work.owner;
    let base = scope
        .base
        .as_deref()
        .map(|b| WorkKey::Branch(b.to_string()));
    let mut firm = BTreeSet::new();
    let mut mentioned = BTreeSet::new();
    for k in &intent.keys {
        if Some(&k.key) == base.as_ref() {
            continue;
        }
        let Some(there) = c
            .work
            .keys
            .iter()
            .filter(|o| o.key == k.key)
            .map(|o| o.from)
            .min()
        else {
            continue;
        };
        if k.from == KeyFrom::Declared && there <= KeyFrom::Title && !same_owner {
            firm.insert(&k.key);
        } else {
            mentioned.insert(&k.key);
        }
    }
    mentioned.retain(|k| !firm.contains(k));

    let theirs = Words::of(&c.work.title);
    let shared: Vec<&str> = words
        .0
        .iter()
        .filter(|(s, _)| theirs.has(s))
        .map(|(_, w)| w.as_str())
        .collect();
    let smaller = words.0.len().min(theirs.0.len());
    let score = if smaller == 0 {
        0.0
    } else {
        shared.len() as f64 / smaller as f64
    };
    let (paths, path_share) = shared_paths(&intent.paths, &c.work.paths);

    let same_words =
        !shared.is_empty() && shared.len() == words.0.len() && shared.len() == theirs.0.len();
    let strength = if !firm.is_empty() {
        Strength::Exact
    } else if same_words
        || (score >= STRONG_SCORE && shared.len() >= STRONG_SHARED)
        || (score >= STRONG_FILE_SCORE
            && shared.len() >= WEAK_SHARED
            && path_share >= STRONG_PATH_SHARE)
        || (!mentioned.is_empty() && !same_owner)
    {
        Strength::Strong
    } else if shared.len() >= WEAK_SHARED || !paths.is_empty() || !mentioned.is_empty() {
        Strength::Weak
    } else {
        return None;
    };
    let strength = if c.weak_only {
        strength.min(Strength::Weak)
    } else {
        strength
    };

    let mut why = Vec::new();
    if !firm.is_empty() {
        why.push(format!("same {}", list(firm.iter())));
    }
    if !mentioned.is_empty() && same_owner {
        why.push(format!("same {} (yours)", list(mentioned.iter())));
    } else if !mentioned.is_empty() {
        why.push(format!("both mention {}", list(mentioned.iter())));
    }
    if same_words && shared.len() < STRONG_SHARED {
        why.push(format!("same words: {}", shared.join(", ")));
    } else if shared.len() >= WEAK_SHARED {
        why.push(format!(
            "{} shared words: {}",
            shared.len(),
            shared.join(", ")
        ));
    }
    match paths.len() {
        0 => {}
        1 => why.push(format!("same file {}", paths[0])),
        n => why.push(format!("{n} same files: {}", list(paths.iter()))),
    }
    let rank = (
        strength,
        firm.len() + mentioned.len(),
        (score * 1000.0) as u32,
        shared.len(),
        paths.len(),
    );
    Some((
        rank,
        Match {
            id: c.id.clone(),
            strength,
            why: why.join("; "),
        },
    ))
}

/// The first three, then "+N more".
fn list<T: std::fmt::Display>(items: impl ExactSizeIterator<Item = T>) -> String {
    let n = items.len();
    let mut out = items
        .take(3)
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    if n > 3 {
        out.push_str(&format!(" +{} more", n - 3));
    }
    out
}

// ---- titles ----

/// Conventional-commit types, dropped with their `(scope)` wherever they open a clause: a scope is an area, and
/// most changes in a repo share a few of them.
static COMMIT_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[^\p{L}\p{N}])(?:feat|fix|chore|docs|refactor|perf|tests?|ci|build|style|revert|batch)(?:\([^)]*\))?!?:",
    )
    .unwrap()
});

/// Words that say what kind of change, not which: they would pair unrelated work.
const STOP: &[&str] = &[
    "the", "and", "for", "with", "without", "from", "into", "onto", "its", "this", "that", "these",
    "those", "when", "then", "than", "not", "all", "any", "every", "one", "can", "now", "new",
    "add", "adds", "added", "update", "updates", "updated", "make", "makes", "support", "supports",
    "use", "uses", "fix", "fixes", "fixed", "via", "per", "who", "what", "which", "while", "also",
    "only", "just", "more", "less", "after", "before", "own", "their", "they", "our", "you",
    "your", "has", "have", "was", "were", "been", "does", "done", "are", "but", "out", "off",
    "too", "very", "some", "each", "here", "there", "how", "why", "should", "must", "will",
    "would", "could", "get", "gets", "set", "sets", "let", "lets", "work",
];

/// A title's words in order, each once: (stem, the word as first written).
struct Words(Vec<(String, String)>);

impl Words {
    fn of(title: &str) -> Self {
        let lower = COMMIT_TYPE
            .replace_all(&title.to_lowercase(), " ")
            .into_owned();
        let mut out: Vec<(String, String)> = Vec::new();
        for word in lower.split(|c: char| !c.is_alphanumeric()) {
            if word.chars().count() < 3
                || word.chars().all(|c| c.is_ascii_digit())
                || STOP.contains(&word)
            {
                continue;
            }
            let stem = stem(word);
            if !out.iter().any(|(s, _)| *s == stem) {
                out.push((stem, word.to_string()));
            }
        }
        Self(out)
    }

    fn has(&self, stem: &str) -> bool {
        self.0.iter().any(|(s, _)| s == stem)
    }
}

/// Plurals meet their singular: "replies" and "reply", "orders" and "order"; "status" and "class" stay whole.
fn stem(word: &str) -> String {
    if word.chars().count() > 4
        && let Some(root) = word.strip_suffix("ies")
    {
        return format!("{root}y");
    }
    if word.chars().count() > 3
        && word.ends_with('s')
        && !["ss", "us", "is"].iter().any(|e| word.ends_with(e))
    {
        return word[..word.len() - 1].to_string();
    }
    word.to_string()
}

// ---- keys ----

static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s<>()\[\]{}"'`]+"#).unwrap());
/// `#12` and `!12` standing alone: not `&#12;`, `C#12` or `wow!12`.
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s(\[{,;:])([#!][1-9][0-9]{0,6})\b").unwrap());
/// `owner/repo#12`, `group/proj!12`: GitHub's cross-repo refs and GitLab's merge message.
static REPO_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^\p{L}\p{N}_./-])((?:[\w.-]+/)+[\w.-]+)([#!][1-9][0-9]{0,6})\b").unwrap()
});
/// A tracker key, `ABC-123`.
static TICKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^\p{L}\p{N}_-])([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})\b").unwrap()
});
/// Upper-case prefixes of standards and versions, not tracker keys: `UTF-8`, `SHA-256`, `RFC-3339`.
const NOT_TICKETS: &[&str] = &[
    // Products and their versions: `JDK-21`, `PY-3`, `GCC-14`.
    "API", "AV", "CUDA", "DDR", "GCC", "GO", "HEVC", "IOS", "JAVA", "JDK", "JEP", "JRE", "JSR",
    "LLVM", "LTE", "MAC", "MPEG", "NODE", "OS", "PCI", "PHP", "PY", "PYTHON", "SDK", "USB", "VP",
    "WIN", // Standards and digests.
    "AES", "ANSI", "ARM", "CRC", "CVE", "ECMA", "ES", "GPT", "HTTP", "IEC", "IEEE", "IPV", "ISO",
    "MD", "MP", "PEP", "RFC", "RSA", "SHA", "SSL", "TLS", "UCS", "UTF", "WCAG",
];

/// The issue, PR and tracker keys written in `text`. "P1" is not one: it is as often a priority.
pub fn keys_in(text: &str, scope: &Scope) -> Vec<WorkKey> {
    let mut keys = Vec::new();
    for url in URL.find_iter(text) {
        keys.extend(url_key(url.as_str(), scope));
    }
    let rest = URL.replace_all(text, " ");
    for m in REPO_NUMBER.captures_iter(&rest) {
        keys.push(repo_ref(&m[1], &m[2], scope));
    }
    for m in NUMBER.captures_iter(&rest) {
        keys.push(WorkKey::Ref(m[1].to_string()));
    }
    for m in TICKET.captures_iter(&rest) {
        let key = m.get(1).unwrap();
        let prefix = key.as_str().split('-').next().unwrap_or_default();
        // "ISO-8601-1", "CVE-2024-1234", "X-1.2": a standard or a version, not a key.
        let after = &rest[key.end()..];
        let continues =
            after.starts_with(['-', '.']) && after[1..].starts_with(|c: char| c.is_ascii_digit());
        if !NOT_TICKETS.contains(&prefix) && !continues {
            keys.push(WorkKey::Ref(key.as_str().to_string()));
        }
    }
    let mut seen = BTreeSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

/// A PR, merge request or issue URL on any host, or a tracker's `/browse/ABC-123`.
fn url_key(url: &str, scope: &Scope) -> Option<WorkKey> {
    let url = url
        .split(['?', '#'])
        .next()?
        .trim_end_matches(['.', ',', ';', ':', '!', '/']);
    let short = short_remote(url);
    let parts: Vec<&str> = short.split('/').collect();
    let number = |i: usize| {
        parts
            .get(i)
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    };
    for i in 1..parts.len() {
        if parts[i] == "browse"
            && let Some(key) = parts.get(i + 1)
            && TICKET.is_match(key)
        {
            return Some(WorkKey::Ref(key.to_string()));
        }
        // GitLab: group/sub/proj/-/merge_requests/12; merge requests have their own numbers.
        let (sigil, repo_end, n) = match parts[i] {
            "-" if parts.get(i + 1) == Some(&"merge_requests") => ('!', i, number(i + 2)),
            "-" if parts.get(i + 1) == Some(&"issues") => ('#', i, number(i + 2)),
            // GitHub pull, Gitea pulls, Bitbucket pull-requests; issues everywhere.
            "pull" | "pulls" | "pull-requests" | "issues" if i >= 3 => ('#', i, number(i + 1)),
            _ => continue,
        };
        let Some(n) = n else { continue };
        return Some(repo_ref(
            &parts[1..repo_end].join("/"),
            &format!("{sigil}{n}"),
            scope,
        ));
    }
    None
}

/// `#12` in the scope's repo, `owner/repo#12` in another. Repos compare by path, whatever the host.
fn repo_ref(repo: &str, number: &str, scope: &Scope) -> WorkKey {
    let ours = scope.repo.as_deref().is_some_and(|r| {
        let short = short_remote(r);
        short
            .split_once('/')
            .is_some_and(|(_, path)| path.eq_ignore_ascii_case(repo))
    });
    WorkKey::Ref(if ours {
        number.to_string()
    } else {
        format!("{repo}{number}")
    })
}

// ---- paths ----

/// The tokens in `text` that look like repo paths: they have a directory (`a/b.ts`, `docs/`, `a/b/c`, `src/**`),
/// so `read/write` and `10/25` stay prose. Bare file names are left out: `README.md` and `Cargo.toml` are in most
/// changes, so they say nothing about which.
pub fn paths_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in text.split_whitespace() {
        let token = token
            .trim_matches(|c: char| "`'\"()[]{}<>,;:!?".contains(c))
            .trim_end_matches('.');
        let token = token.trim_start_matches("./");
        if !token.contains('/')
            || token.contains("://")
            || !token
                .chars()
                .all(|c| c.is_alphanumeric() || "/._-*+@~".contains(c))
            || token
                .split('/')
                .all(|s| s.chars().all(|c| c.is_ascii_digit()))
        {
            continue;
        }
        let last = token.rsplit('/').next().unwrap_or_default();
        let has_ext = last.rsplit_once('.').is_some_and(|(stem, ext)| {
            !stem.is_empty()
                && (1..=10).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        });
        let pathlike = token.ends_with('/')
            || token.contains('*')
            || has_ext
            || token.matches('/').count() >= 2;
        if pathlike && !out.iter().any(|p| p == token) {
            out.push(token.to_string());
        }
    }
    out
}

/// The paths of `a` that meet one of `b`'s, and the larger of the two sides' shares that meet.
fn shared_paths(a: &[String], b: &[String]) -> (Vec<String>, f64) {
    let (a, b) = (Paths::of(a), Paths::of(b));
    let hits_a: Vec<String> = a.all.iter().filter(|p| b.meets(p)).cloned().collect();
    if hits_a.is_empty() {
        return (hits_a, 0.0);
    }
    let hits_b = b.all.iter().filter(|q| a.meets(q)).count();
    let share = (hits_a.len() as f64 / a.all.len() as f64).max(hits_b as f64 / b.all.len() as f64);
    (hits_a, share)
}

/// A path list, each once, its plain paths looked up by value: a writer's changes run to hundreds.
struct Paths {
    all: Vec<String>,
    plain: HashSet<String>,
    globs: Vec<String>,
}

impl Paths {
    fn of(paths: &[String]) -> Self {
        let mut all: Vec<String> = Vec::new();
        let (mut plain, mut globs) = (HashSet::new(), Vec::new());
        for p in paths.iter().map(|p| norm_path(p)).filter(|p| !p.is_empty()) {
            let new = if is_glob(&p) {
                !globs.contains(&p) && {
                    globs.push(p.clone());
                    true
                }
            } else {
                plain.insert(p.clone())
            };
            if new {
                all.push(p);
            }
        }
        Self { all, plain, globs }
    }

    fn meets(&self, p: &str) -> bool {
        if is_glob(p) {
            self.plain.iter().any(|q| glob(p, q)) || self.globs.iter().any(|g| globs_meet(p, g))
        } else {
            self.plain.contains(p) || self.globs.iter().any(|g| glob(g, p))
        }
    }
}

/// `./a/b` is `a/b`; a directory `a/` covers `a/**`.
fn norm_path(p: &str) -> String {
    let p = p.trim().trim_start_matches("./");
    match p.strip_suffix('/') {
        Some(dir) if !dir.is_empty() => format!("{dir}/**"),
        _ => p.to_string(),
    }
}

fn is_glob(p: &str) -> bool {
    p.contains(['*', '?'])
}

/// Two globs meet when one's fixed directory holds the other's.
fn globs_meet(a: &str, b: &str) -> bool {
    let (x, y) = (fixed_dir(a), fixed_dir(b));
    x.starts_with(&y) || y.starts_with(&x)
}

/// The directories before a glob's first wildcard, with their trailing `/`.
fn fixed_dir(p: &str) -> String {
    let head = &p[..p.find(['*', '?']).unwrap_or(p.len())];
    head[..head.rfind('/').map_or(0, |i| i + 1)].to_string()
}

/// `**` is any number of directories; `*` and `?` stay within one. Neither backtracks: a prompt's paths are
/// anyone's text, so `a/**********q` must cost no more than `a/*q`.
fn glob(pattern: &str, path: &str) -> bool {
    let s: Vec<&str> = path.split('/').collect();
    // reach[j]: the pattern so far matches the path's first j directories.
    let mut reach = vec![false; s.len() + 1];
    reach[0] = true;
    for seg in pattern.split('/') {
        let mut next = vec![false; s.len() + 1];
        if seg == "**" {
            let mut any = false;
            for (j, r) in reach.iter().enumerate() {
                any |= *r;
                next[j] = any;
            }
        } else {
            for j in 0..s.len() {
                next[j + 1] = reach[j] && segment(seg, s[j]);
            }
        }
        reach = next;
    }
    reach[s.len()]
}

/// One directory's name against `*` and `?`: the last `*` takes one more character at each miss.
fn segment(pattern: &str, name: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    let (mut i, mut j) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while j < s.len() {
        if i < p.len() && (p[i] == '?' || p[i] == s[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some((i, j));
            i += 1;
        } else if let Some((si, sj)) = star {
            i = si + 1;
            j = sj + 1;
            star = Some((si, sj + 1));
        } else {
            return false;
        }
    }
    p[i..].iter().all(|c| *c == '*')
}
