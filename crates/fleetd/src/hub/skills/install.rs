//! Installing skills from a source, on the hub: the sources `npx skills add` takes (skills.sh), fetched with git at
//! one commit, which the skills are then pinned to. Update fetches the same source and ref again; nothing updates on
//! its own.
//!
//! - `owner/repo` and `owner/repo@skill`: a GitHub repo, every skill in it or one.
//! - `https://github.com/owner/repo[.git]`, and `…/tree/<ref>/<path>` for a branch or tag and a folder in it.
//! - Any other git URL (`https://…`, `ssh://…`, `git@host:…`, `file://…`).
//!
//! In the fetched tree, a folder with a `SKILL.md` at the source's path is one skill; else the skills are the
//! `<dir>/<name>/SKILL.md` of `skills/`, `.agents/skills/`, `.claude/skills/` and the top level, and failing those any
//! `SKILL.md` up to four folders down.
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::Line;
use fleetd_contracts::skills::{
    SKILL_BYTES_CAP, SKILL_FILE, SKILL_FILES_CAP, SkillInstall, SkillName, frontmatter,
};

use super::{SkillError, files_of};

const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// A source, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub url: String,
    /// `HEAD` for the default branch.
    pub git_ref: String,
    /// A folder in the repo; empty for the whole repo.
    pub path: String,
    /// `owner/repo@skill`: only that skill.
    pub skill: Option<SkillName>,
}

fn refused(message: impl Into<String>) -> SkillError {
    SkillError::new(
        ErrorCode::Invalid,
        message,
        Some(
            "Give owner/repo, owner/repo@skill, a GitHub URL (…/tree/<branch>/<folder> too) or a git URL.",
        ),
    )
}

fn plain(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Parses a source as skills.sh writes them.
pub fn parse(source: &str) -> Result<Source, SkillError> {
    let s = source.trim();
    if s.starts_with('-') || s.chars().any(char::is_whitespace) {
        return Err(refused(format!("{s} is not a source.")));
    }
    if let Some(rest) = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
    {
        let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
        let [owner, repo, more @ ..] = parts.as_slice() else {
            return Err(refused(format!("{s} names no repo.")));
        };
        let repo = repo.trim_end_matches(".git");
        if !plain(owner) || !plain(repo) {
            return Err(refused(format!("{s} names no repo.")));
        }
        let (git_ref, path) = match more {
            [] => ("HEAD".to_owned(), String::new()),
            ["tree" | "blob", r, path @ ..] if plain(r) && path.iter().all(|p| plain(p)) => {
                let path = path.join("/");
                let path = path
                    .strip_suffix(&format!("/{SKILL_FILE}"))
                    .unwrap_or(&path)
                    .to_owned();
                (
                    (*r).to_owned(),
                    if path == SKILL_FILE {
                        String::new()
                    } else {
                        path
                    },
                )
            }
            _ => return Err(refused(format!("{s} is not a repo or a folder in one."))),
        };
        return Ok(Source {
            url: format!("https://github.com/{owner}/{repo}.git"),
            git_ref,
            path,
            skill: None,
        });
    }
    if s.contains("://") || (s.contains('@') && s.contains(':') && !s.contains("://")) {
        // Any other git URL, as given (git@host:owner/repo.git, ssh://, https://, file://).
        return Ok(Source {
            url: s.to_owned(),
            git_ref: "HEAD".into(),
            path: String::new(),
            skill: None,
        });
    }
    // owner/repo[@skill]
    let (repo, skill) = match s.split_once('@') {
        Some((repo, skill)) => (
            repo,
            Some(
                SkillName::new(skill)
                    .map_err(|_| refused(format!("{skill} is not a skill name.")))?,
            ),
        ),
        None => (s, None),
    };
    match repo.split('/').collect::<Vec<_>>().as_slice() {
        [owner, name] if plain(owner) && plain(name) => Ok(Source {
            url: format!(
                "https://github.com/{owner}/{}.git",
                name.trim_end_matches(".git")
            ),
            git_ref: "HEAD".into(),
            path: String::new(),
            skill,
        }),
        _ => Err(refused(format!("{s} is not a source."))),
    }
}

/// A source that reads the hub's own disk, which only a person may install from.
pub fn is_local(source: &Source) -> bool {
    source.url.starts_with("file://") || source.url.starts_with('/')
}

/// One skill found in a fetched tree.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub name: SkillName,
    /// Its folder, repo-relative; empty for a repo that is one skill.
    pub path: String,
    pub files: Vec<(String, Vec<u8>)>,
}

/// A source fetched at one commit, in a directory removed when this drops.
pub struct Fetched {
    pub commit: String,
    pub tree: tempfile::TempDir,
}

async fn git(dir: &Path, args: &[&str]) -> Result<String, SkillError> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(FETCH_TIMEOUT, cmd.output())
        .await
        .map_err(|_| {
            SkillError::new(
                ErrorCode::Failed,
                "git took too long to fetch the source.",
                None,
            )
        })?
        .map_err(|e| {
            SkillError::new(
                ErrorCode::Failed,
                format!("cannot run git on the hub: {e}"),
                Some("Install git where the hub runs."),
            )
        })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("failed")
            .trim();
        return Err(SkillError::new(
            ErrorCode::Failed,
            format!("git {}: {line}", args[0]),
            Some("Check the source: a public repo, or one the hub's git can read."),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Fetches `source` at the newest commit of its ref, one commit deep.
pub async fn fetch(source: &Source) -> Result<Fetched, SkillError> {
    let tree = tempfile::Builder::new().prefix("fleetd-skill-").tempdir()?;
    let dir = tree.path();
    git(dir, &["init", "--quiet"]).await?;
    git(
        dir,
        &[
            "fetch",
            "--quiet",
            "--depth",
            "1",
            "--no-tags",
            "--",
            &source.url,
            &source.git_ref,
        ],
    )
    .await?;
    let commit = git(dir, &["rev-parse", "FETCH_HEAD"]).await?;
    git(
        dir,
        &[
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "--quiet",
            "FETCH_HEAD",
        ],
    )
    .await?;
    Ok(Fetched { commit, tree })
}

fn is_skill(dir: &Path) -> bool {
    dir.join(SKILL_FILE).is_file()
}

/// The skill folders of `base` (see the module's discovery order), repo-relative to `root`.
fn skill_dirs(root: &Path, base: &Path) -> Vec<PathBuf> {
    if is_skill(base) {
        return vec![base.to_path_buf()];
    }
    let mut out = Vec::new();
    for sub in ["skills", ".agents/skills", ".claude/skills", ""] {
        let Ok(entries) = std::fs::read_dir(base.join(sub)) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && is_skill(p))
            .collect();
        dirs.sort();
        out.extend(dirs);
    }
    if out.is_empty() {
        let mut stack = vec![(base.to_path_buf(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 4 {
                continue;
            }
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let name = e.file_name();
                if name == ".git" || name == "node_modules" || !e.path().is_dir() {
                    continue;
                }
                if is_skill(&e.path()) {
                    out.push(e.path());
                } else {
                    stack.push((e.path(), depth + 1));
                }
            }
        }
        out.sort();
    }
    out.retain(|d| d.starts_with(root));
    out
}

/// The skills in a fetched tree, under the source's path; `want` keeps one of them.
pub fn find(
    root: &Path,
    source: &Source,
    want: Option<&SkillName>,
) -> Result<Vec<Found>, SkillError> {
    let base = if source.path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&source.path)
    };
    if !base.is_dir() {
        return Err(refused(format!(
            "The source has no folder {}.",
            source.path
        )));
    }
    let mut out: Vec<Found> = Vec::new();
    for dir in skill_dirs(root, &base) {
        let md = std::fs::read_to_string(dir.join(SKILL_FILE)).unwrap_or_default();
        let folder = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned);
        let repo = source
            .url
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .rsplit(['/', ':'])
            .next()
            .map(str::to_owned);
        let from_folder = if dir == root { repo } else { folder };
        let Some(name) = frontmatter(&md)
            .name
            .and_then(|n| SkillName::new(n).ok())
            .or_else(|| from_folder.and_then(|n| SkillName::new(n.to_lowercase()).ok()))
        else {
            continue;
        };
        if out.iter().any(|f| f.name == name) || want.is_some_and(|w| *w != name) {
            continue;
        }
        let rel = dir
            .strip_prefix(root)
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned();
        let mut files = Vec::new();
        let mut bytes = 0usize;
        let listed = files_of(&dir, SKILL_FILES_CAP);
        if listed.len() > SKILL_FILES_CAP {
            return Err(refused(format!(
                "{name} has more than {SKILL_FILES_CAP} files."
            )));
        }
        for f in listed {
            let data = std::fs::read(dir.join(&f))?;
            bytes += data.len();
            files.push((f, data));
        }
        if bytes > SKILL_BYTES_CAP {
            return Err(refused(format!(
                "{name} is past {} KB.",
                SKILL_BYTES_CAP / 1024
            )));
        }
        // The SKILL.md's frontmatter names the folder it is kept in.
        out.push(Found {
            name,
            path: rel,
            files,
        });
    }
    if out.is_empty() {
        return Err(match want {
            Some(w) => refused(format!("The source has no skill called {w}.")),
            None => refused("The source has no skill: no folder with a SKILL.md."),
        });
    }
    Ok(out)
}

/// The install record for a skill found at `path` of a source fetched at `commit`.
pub fn record(given: &str, source: &Source, commit: &str, path: &str, at: &str) -> SkillInstall {
    SkillInstall {
        source: Line::unchecked(given.trim()),
        url: Line::unchecked(source.url.as_str()),
        git_ref: Line::unchecked(source.git_ref.as_str()),
        commit: Line::unchecked(commit),
        path: Line::unchecked(path),
        installed_at: at.to_owned().into(),
    }
}

/// The source an installed skill is updated from: the same URL and ref, and the folder it was found in.
pub fn source_of(install: &SkillInstall) -> Source {
    Source {
        url: install.url.to_string(),
        git_ref: install.git_ref.to_string(),
        path: install.path.to_string(),
        skill: None,
    }
}
