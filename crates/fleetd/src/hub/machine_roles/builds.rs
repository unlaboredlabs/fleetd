//! A PR's CI build for a person's screen (D239): `screen_open` with a PR installs its build in the iOS or Android screen
//! before the person gets it (screens.rs).
//!
//! The build is the newest artifact of a CI run on the PR's head whose name says what it is for: `ios` (a zipped
//! simulator `.app`, as the Mobile workflow's `fleetd-ios-simulator`) or `android`/`apk` (an `.apk`, as
//! `fleetd-android-apk`). The hub reads it with its own `gh`: as its GitHub App on the repositories the App is installed
//! on, else the machine's login. `gh run download` takes off the zip GitHub wraps each artifact in; the file inside is
//! what goes to the screen's machine, at most [`FILE_MAX`] (64 MiB), as an agent's install does.
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use fleetd_contracts::browser::SessionKind;
use serde::Deserialize;

use crate::hub::train::github::GhRunner;
use crate::node::device::remote::FILE_MAX;

/// The runs on a head looked through for a build, newest first.
const RUNS: usize = 10;

/// Where the hub reads PRs' builds.
pub struct Builds {
    gh: RwLock<Arc<dyn GhRunner>>,
    /// Downloads, each in a folder of its own while it is read.
    dir: PathBuf,
}

/// A PR's build as found: the run that uploaded it and the artifact's name.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub run_id: i64,
    pub artifact: String,
    /// The PR's head it was built from.
    pub sha: String,
}

/// A PR's build, read: the file to install, under a plain name, and its bytes.
pub struct Build {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct Pull {
    head: Head,
}

#[derive(Deserialize)]
struct Head {
    sha: String,
}

#[derive(Deserialize)]
struct Runs {
    #[serde(default)]
    workflow_runs: Vec<Run>,
}

#[derive(Deserialize)]
struct Run {
    id: i64,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
struct Artifacts {
    #[serde(default)]
    artifacts: Vec<Artifact>,
}

#[derive(Deserialize)]
struct Artifact {
    name: String,
    #[serde(default)]
    expired: bool,
}

/// What a build is called in what the person reads.
pub fn noun(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Ios => "iOS simulator build",
        _ => "Android build",
    }
}

/// Whether an artifact's name says it is a build for `kind`.
fn named_for(name: &str, kind: SessionKind) -> bool {
    let name = name.to_lowercase();
    match kind {
        SessionKind::Ios => name.contains("ios"),
        SessionKind::Android => name.contains("android") || name.contains("apk"),
        _ => false,
    }
}

/// The file in a downloaded artifact that is the build: a `.zip` of the simulator app, or an `.apk`.
fn the_file(dir: &Path, kind: SessionKind) -> Option<PathBuf> {
    let suffix = if kind == SessionKind::Ios {
        ".zip"
    } else {
        ".apk"
    };
    let mut dirs = vec![dir.to_owned()];
    let mut found = Vec::new();
    while let Some(next) = dirs.pop() {
        for entry in std::fs::read_dir(&next).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                dirs.push(path);
            } else if meta.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .ends_with(suffix)
            {
                found.push(path);
            }
        }
    }
    found.sort();
    found.into_iter().next()
}

impl Builds {
    pub fn new(gh: Arc<dyn GhRunner>, dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            gh: RwLock::new(gh),
            dir,
        })
    }

    /// Reads GitHub with `gh` instead: a fake in tests.
    #[cfg(test)]
    pub fn set_gh(&self, gh: Arc<dyn GhRunner>) {
        *self.gh.write().unwrap_or_else(|e| e.into_inner()) = gh;
    }

    async fn gh(&self, args: &[&str]) -> Result<String, String> {
        let gh = self.gh.read().unwrap_or_else(|e| e.into_inner()).clone();
        let out = gh
            .run(args.iter().map(|a| (*a).to_owned()).collect())
            .await
            .map_err(|e| match e.as_str() {
                "ENOENT" => "the GitHub CLI (gh) isn't installed on the hub's machine".to_owned(),
                _ => e,
            })?;
        if out.exit_code != 0 {
            let said = out.stderr.trim();
            return Err(if said.is_empty() {
                format!("gh exited with {}", out.exit_code)
            } else {
                crate::hub::api::clip(said, 300)
            });
        }
        Ok(out.stdout)
    }

    async fn json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let out = self.gh(&["api", path]).await?;
        serde_json::from_str(&out).map_err(|e| format!("GitHub answered something else: {e}"))
    }

    /// The newest build for `kind` of PR `number` of `repo` (`owner/name`): the error says plainly why there is none.
    pub async fn find(&self, repo: &str, number: i64, kind: SessionKind) -> Result<Found, String> {
        let what = noun(kind);
        let pull: Pull = self
            .json(&format!("repos/{repo}/pulls/{number}"))
            .await
            .map_err(|e| format!("PR #{number} of {repo} couldn't be read: {e}."))?;
        let sha = pull.head.sha;
        let short = &sha[..sha.len().min(7)];
        let runs: Runs = self
            .json(&format!(
                "repos/{repo}/actions/runs?head_sha={sha}&per_page={RUNS}"
            ))
            .await
            .map_err(|e| format!("PR #{number}'s CI runs couldn't be read: {e}."))?;
        let mut running = false;
        let mut expired = false;
        for run in runs.workflow_runs.iter().take(RUNS) {
            if run.status != "completed" {
                running = true;
            }
            let listed: Artifacts = self
                .json(&format!(
                    "repos/{repo}/actions/runs/{}/artifacts?per_page=100",
                    run.id
                ))
                .await
                .map_err(|e| format!("PR #{number}'s CI artifacts couldn't be read: {e}."))?;
            for a in listed
                .artifacts
                .into_iter()
                .filter(|a| named_for(&a.name, kind))
            {
                if a.expired {
                    expired = true;
                    continue;
                }
                return Ok(Found {
                    run_id: run.id,
                    artifact: a.name,
                    sha,
                });
            }
        }
        Err(if running {
            format!(
                "PR #{number}'s CI is still running on its head ({short}): its {what} isn't there yet. Try again once it's done."
            )
        } else if expired {
            format!(
                "PR #{number}'s {what} has expired: GitHub keeps CI artifacts only so long. Re-run its CI, or push to it, to build it again."
            )
        } else if runs.workflow_runs.is_empty() {
            format!("PR #{number}'s head ({short}) has no CI runs, so no {what}.")
        } else {
            format!(
                "PR #{number}'s head ({short}) has no {what}: none of its CI runs uploaded an artifact named for {}.",
                if kind == SessionKind::Ios {
                    "iOS (a zipped simulator .app)"
                } else {
                    "Android (an .apk)"
                }
            )
        })
    }

    /// Downloads a build [`Self::find`] found, and reads the file to install from it.
    pub async fn fetch(
        &self,
        repo: &str,
        number: i64,
        kind: SessionKind,
        found: &Found,
    ) -> Result<Build, String> {
        let what = noun(kind);
        crate::node::config::mkdir_private(&self.dir)
            .map_err(|e| format!("the hub can't keep downloads: {e}"))?;
        let tmp = tempfile::Builder::new()
            .prefix("pr-")
            .tempdir_in(&self.dir)
            .map_err(|e| format!("the hub can't keep downloads: {e}"))?;
        let dest = tmp.path().to_string_lossy().into_owned();
        let run = found.run_id.to_string();
        self.gh(&[
            "run",
            "download",
            &run,
            "-n",
            &found.artifact,
            "-D",
            &dest,
            "-R",
            repo,
        ])
        .await
        .map_err(|e| format!("PR #{number}'s {what} didn't download: {e}."))?;
        let Some(file) = the_file(tmp.path(), kind) else {
            return Err(format!(
                "PR #{number}'s artifact {} holds no {} file.",
                found.artifact,
                if kind == SessionKind::Ios {
                    ".zip"
                } else {
                    ".apk"
                }
            ));
        };
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        if size > FILE_MAX {
            return Err(format!(
                "PR #{number}'s {what} is {} MiB, more than the {} MiB a screen takes.",
                size >> 20,
                FILE_MAX >> 20
            ));
        }
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|e| format!("PR #{number}'s {what} can't be read: {e}."))?;
        let ext = if kind == SessionKind::Ios {
            "zip"
        } else {
            "apk"
        };
        Ok(Build {
            name: format!("pr-{number}.{ext}"),
            bytes,
        })
    }
}
