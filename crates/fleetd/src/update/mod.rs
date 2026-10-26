//! fleetd updating itself, shared by `fleetd update` (cli/update.rs), the hub's `hub_update` (hub/update) and a node
//! its hub asks to (node/update.rs): the release channel, the channel's files and a download checked against its
//! SHA256SUMS, the swap that keeps the binary it replaces, the services `fleetd init` made (`service`), and the watcher
//! that restarts one, checks it came up on the new build and puts the previous one back if not (`finish`).
//!
//! A restart never waits for work to finish: a lead's turn and running agents carry on by themselves afterwards in
//! their threads and worktrees, the merge train takes up what it was merging, and an approved command it cut off goes
//! back to the person as interrupted, never run again.
//!
//! Release assets (built by .github/workflows/build-release.yml) have version-less names next to `SHA256SUMS` and
//! `release.json`, at `releases/download/nightly/` or `releases/latest/download/`. Those are CDN downloads, not the
//! GitHub API, so there is no token and no rate limit. `FLEETD_BASE_URL` points at another asset directory.
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use fleetd_contracts::mcp::UpdateStage;
use sha2::{Digest, Sha256};

pub mod finish;
pub mod service;

#[cfg(test)]
pub(crate) mod tests;

pub const REPO: &str = "unlaboredlabs/fleetd";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Nightly,
    Stable,
}

impl Channel {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "nightly" => Ok(Self::Nightly),
            "stable" | "latest" => Ok(Self::Stable),
            other => Err(format!("unknown channel {other:?}: use nightly or stable")),
        }
    }

    /// Nightly builds stay on nightly and tagged builds on stable. Until the first tag, local builds follow nightly.
    pub fn of(version: &str, release_build: bool) -> Self {
        if version.contains("-nightly.") || !release_build {
            Self::Nightly
        } else {
            Self::Stable
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nightly => "nightly",
            Self::Stable => "stable",
        }
    }

    /// Where the channel's assets are: `FLEETD_BASE_URL`, else its GitHub release download directory.
    pub fn base_url(self) -> String {
        std::env::var("FLEETD_BASE_URL").unwrap_or_else(|_| match self {
            Self::Nightly => format!("https://github.com/{REPO}/releases/download/nightly"),
            Self::Stable => format!("https://github.com/{REPO}/releases/latest/download"),
        })
    }
}

/// Why an update didn't happen, at which stage, in one plain sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: UpdateStage,
    pub message: String,
}

impl Failure {
    pub fn new(stage: UpdateStage, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

/// A channel's asset directory; tests stand in a fake release feed.
pub trait Feed: Send + Sync {
    /// The asset's bytes, or why not in plain words.
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// The real feed: plain GETs under `base`.
pub struct HttpFeed {
    http: reqwest::Client,
    base: String,
}

impl HttpFeed {
    pub fn new(base: String) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("fleetd/{}", crate::version()))
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .unwrap_or_default();
        Self { http, base }
    }
}

impl Feed for HttpFeed {
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let url = format!("{}/{name}", self.base);
            let response = self
                .http
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("GET {url}: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("GET {url}: {}", response.status()));
            }
            Ok(response
                .bytes()
                .await
                .map_err(|e| format!("GET {url}: {e}"))?
                .to_vec())
        })
    }
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The channel's newest CLI, which the hub and nodes run; absent before the channel had one.
    pub cli_version: Option<String>,
}

/// The channel's release.json.
pub async fn release(feed: &dyn Feed) -> Result<Release, Failure> {
    let bytes = feed.get("release.json").await.map_err(|e| {
        Failure::new(
            UpdateStage::Download,
            format!("couldn't read the release: {e}"),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Failure::new(
            UpdateStage::Download,
            format!("the release's release.json is not valid: {e}"),
        )
    })
}

/// The release's SHA256SUMS.
pub async fn sums(feed: &dyn Feed) -> Result<HashMap<String, String>, Failure> {
    let sums = feed.get("SHA256SUMS").await.map_err(|e| {
        Failure::new(
            UpdateStage::Download,
            format!("couldn't read the release's checksums: {e}"),
        )
    })?;
    Ok(parse_sums(&String::from_utf8_lossy(&sums)))
}

/// A checked download: the release's SHA256SUMS line for `name`, and the asset's bytes that match it.
pub async fn verified(feed: &dyn Feed, name: &str) -> Result<Vec<u8>, Failure> {
    checked(feed, &sums(feed).await?, name).await
}

/// [`verified`] against sums already read.
pub async fn checked(
    feed: &dyn Feed,
    sums: &HashMap<String, String>,
    name: &str,
) -> Result<Vec<u8>, Failure> {
    let expected = sums.get(name).ok_or_else(|| {
        Failure::new(
            UpdateStage::Download,
            format!("{name} is not in the release"),
        )
    })?;
    let bytes = feed.get(name).await.map_err(|e| {
        Failure::new(
            UpdateStage::Download,
            format!("couldn't download {name}: {e}"),
        )
    })?;
    let actual = sha256_hex(&bytes);
    if &actual != expected {
        return Err(Failure::new(
            UpdateStage::Checksum,
            format!(
                "{name}: checksum mismatch (expected {expected}, got {actual}); nothing was changed"
            ),
        ));
    }
    Ok(bytes)
}

/// `sha256sum` output: `<hex>  <name>` per line (`*<name>` in binary mode).
pub fn parse_sums(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once(char::is_whitespace))
        .map(|(hash, name)| {
            (
                name.trim_start().trim_start_matches('*').to_string(),
                hash.to_ascii_lowercase(),
            )
        })
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// This platform's CLI asset: `fleetd-<os>-<arch>`.
pub fn cli_asset() -> Result<String, String> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("no fleetd release build for {other}")),
    };
    Ok(format!("fleetd-{os}-{arch}"))
}

/// The installed binary this process was started from: the path the services name. Linux shows a binary replaced
/// under a running process as `<path> (deleted)`; that suffix goes.
pub fn installed_exe() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe = match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(stripped) => PathBuf::from(stripped),
        None => exe,
    };
    Ok(fs::canonicalize(&exe).unwrap_or(exe))
}

/// The running process's own binary, whatever has been installed over its path since: what a rollback puts back.
pub fn running_binary() -> std::io::Result<Vec<u8>> {
    if cfg!(target_os = "linux") {
        fs::read("/proc/self/exe")
    } else {
        fs::read(std::env::current_exe()?)
    }
}

/// Writes a sibling file and renames it over `path`. Never writes into the old file: a running fleetd keeps its
/// inode, and macOS kills a process whose signed binary is modified in place.
pub fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.new"));
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.set_permissions(fs::Permissions::from_mode(0o755))?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    };
    write().inspect_err(|_| _ = fs::remove_file(&tmp))
}

/// Keeps `previous` at `prev`, then puts `bytes` at `exe`. Either step failing leaves `exe` as it was.
pub fn swap(exe: &Path, bytes: &[u8], previous: &[u8], prev: &Path) -> Result<(), Failure> {
    let install = |what: &str, e: std::io::Error| {
        Failure::new(
            UpdateStage::Install,
            format!("couldn't {what}: {e}; nothing was changed"),
        )
    };
    if let Some(dir) = prev.parent() {
        fs::create_dir_all(dir).map_err(|e| install("keep the previous binary", e))?;
    }
    replace_file(prev, previous).map_err(|e| install("keep the previous binary", e))?;
    replace_file(exe, bytes).map_err(|e| install(&format!("replace {}", exe.display()), e))
}

/// Puts the binary `swap` kept back at `exe`.
pub fn restore(exe: &Path, prev: &Path) -> std::io::Result<()> {
    replace_file(exe, &fs::read(prev)?)
}
