//! fleetd updating itself, shared by `fleetd update` (cli/update.rs), the hub's `hub_update` (hub/update) and a node
//! its hub asks to (node/update.rs): the release channel, the channel's files and a download checked against its
//! SHA256SUMS, the swap that keeps the binary it replaces, the services `fleetd init` made (`service`), and the watcher
//! that restarts one, checks it came up on the new build and puts the previous one back if not (`finish`).
//!
//! A restart never waits for work to finish: a lead's turn and running agents carry on by themselves through it, under
//! session hosts in systemd scopes of their own that outlive the node (node/runner/host.rs), or afterwards in their
//! threads and worktrees where they can't, the merge train takes up what it was merging, and an approved command runs on through
//! a hub restart and reports its result once its node is linked again (node/gated.rs). One its node's restart cut off
//! goes back to the person as may have run, never run again.
//!
//! Release assets (built by .github/workflows/build-release.yml) have version-less names next to `SHA256SUMS` and
//! `release.json`, at `releases/download/edge/` or `releases/latest/download/`. Those are CDN downloads, not the
//! GitHub API, so there is no token and no rate limit. When one answers a server error or doesn't answer, the same
//! asset comes through the releases API instead, checked the same way. `FLEETD_BASE_URL` points at another asset
//! directory.
//!
//! A CLI build also has a packed copy beside it, `<asset>.lzma` (publish.sh), about a third of its size. A release whose
//! SHA256SUMS lists it is downloaded packed and unpacked as it streams in, and what lands is checked against the plain
//! asset's line, as ever. Releases from before have only the plain asset, which older fleetd keeps reading.
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
    /// The newest build of main, published after each merge. Called nightly until D203: that name still works.
    Edge,
    Stable,
}

impl Channel {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "edge" | "nightly" => Ok(Self::Edge),
            "stable" | "latest" => Ok(Self::Stable),
            other => Err(format!("unknown channel {other:?}: use edge or stable")),
        }
    }

    /// Edge builds (and nightly ones, from before the rename) stay on edge and tagged builds on stable. Until the
    /// first tag, local builds follow edge.
    pub fn of(version: &str, release_build: bool) -> Self {
        if crate::edge_stamp(version).is_some() || !release_build {
            Self::Edge
        } else {
            Self::Stable
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Edge => "edge",
            Self::Stable => "stable",
        }
    }

    /// Where the channel's assets are: `FLEETD_BASE_URL`, else its GitHub release download directory.
    pub fn base_url(self) -> String {
        std::env::var("FLEETD_BASE_URL").unwrap_or_else(|_| match self {
            Self::Edge => format!("https://github.com/{REPO}/releases/download/edge"),
            Self::Stable => format!("https://github.com/{REPO}/releases/latest/download"),
        })
    }
}

/// Why an update didn't happen, at which stage, in one plain sentence. File names, URLs and checksums in it are in
/// backticks, so the app shows them as code.
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

/// Where a streamed asset's chunks go, in order; an error stops the download with it.
pub type Sink<'a> = dyn FnMut(&[u8]) -> Result<(), String> + Send + 'a;

/// A channel's asset directory; tests stand in a fake release feed.
pub trait Feed: Send + Sync {
    /// The asset's bytes, or why not in plain words: for the small files, `release.json` and `SHA256SUMS`.
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>>;

    /// The asset's chunks to `sink` as they arrive, so a build is never held in memory whole.
    fn stream<'a>(
        &'a self,
        name: &'a str,
        sink: &'a mut Sink<'_>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { sink(&self.get(name).await?) })
    }
}

/// The real feed: plain GETs under `base`, and for a GitHub release, its `api` when those fail.
pub struct HttpFeed {
    http: reqwest::Client,
    base: String,
    api: Option<String>,
}

/// How a feed's error begins when an asset failed both from its download link and through GitHub's API: shown as it
/// is, not as a "couldn't download".
pub const GITHUB_FAILING: &str = "GitHub's downloads are failing right now, try again later";

/// A download that gets no byte for this long stops, and a build's goes on from where it stopped. No limit on the
/// whole: a build is 50-130 MB, which takes most of an hour at 1 Mbit/s.
const STALL: std::time::Duration = std::time::Duration::from_secs(60);
/// The most a small file's GET takes.
const SMALL_WAIT: std::time::Duration = std::time::Duration::from_secs(600);
/// How often a build's download that was cut off (a dropped link, a stall, a server error) is asked for again from
/// the byte it stopped at, waiting [`RESUME_WAIT`] longer each time; a try that brings bytes starts the count again.
const RESUMES: u32 = 5;
const RESUME_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

impl HttpFeed {
    pub fn new(base: String) -> Self {
        let api = release_api(&base);
        Self::with_api(base, api)
    }

    /// A feed whose assets come through the releases API at `api` when their download links fail.
    pub fn with_api(base: String, api: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("fleetd/{}", crate::version()))
            .connect_timeout(std::time::Duration::from_secs(20))
            .read_timeout(STALL)
            .build()
            .unwrap_or_default();
        Self { http, base, api }
    }
}

/// GitHub's API for the release whose download directory is `base`: `releases/download/<tag>` or
/// `releases/latest/download` under `https://github.com/<owner>/<repo>/`.
fn release_api(base: &str) -> Option<String> {
    let (repo, release) = base
        .strip_prefix("https://github.com/")?
        .split_once("/releases/")?;
    let release = match release.trim_end_matches('/') {
        "latest/download" => "latest".to_owned(),
        tag => format!("tags/{}", tag.strip_prefix("download/")?),
    };
    Some(format!(
        "https://api.github.com/repos/{repo}/releases/{release}"
    ))
}

#[derive(serde::Deserialize)]
struct ApiRelease {
    assets: Vec<ApiAsset>,
}

#[derive(serde::Deserialize)]
struct ApiAsset {
    name: String,
    url: String,
}

/// Why a GET failed: `Again` for what asking again may fix (the network, a server error), `Final` for the rest.
enum Fail {
    Again(String),
    Final(String),
}

/// The error when an asset failed from its download link (`link`) and through the API (`api`).
fn both_failed(link: &str, api: &str) -> String {
    format!("{GITHUB_FAILING} ({link}; through GitHub's API: {api})")
}

/// The API's error `e`, after the download link's (`link`) when it came through the API.
fn after(link: Option<String>, e: String) -> String {
    match link {
        Some(link) => both_failed(&link, &e),
        None => e,
    }
}

impl HttpFeed {
    /// `name`'s URL in the release's API, which answers with the asset itself to `Accept: application/octet-stream`.
    async fn api_url(&self, api: &str, name: &str) -> Result<String, String> {
        let response = self
            .http
            .get(api)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .timeout(SMALL_WAIT)
            .send()
            .await
            .map_err(|e| format!("GET `{api}`: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("GET `{api}`: {status}"));
        }
        let release: ApiRelease = response
            .json()
            .await
            .map_err(|e| format!("GET `{api}`: {e}"))?;
        release
            .assets
            .into_iter()
            .find(|a| a.name == name)
            .map(|a| a.url)
            .ok_or_else(|| format!("`{name}` is not in the release at `{api}`"))
    }

    /// A small file's bytes from `url`; `api` for an asset URL of the releases API.
    async fn fetch(&self, url: &str, api: bool) -> Result<Vec<u8>, Fail> {
        Ok(self
            .send(url, None, api)
            .await?
            .bytes()
            .await
            .map_err(|e| Fail::Again(format!("GET `{url}`: {e}")))?
            .to_vec())
    }

    /// A GET of a build from byte `from`, or with `None` of a small file (within [`SMALL_WAIT`]); `api` for an asset
    /// URL of the releases API.
    async fn send(
        &self,
        url: &str,
        from: Option<u64>,
        api: bool,
    ) -> Result<reqwest::Response, Fail> {
        let mut request = self.http.get(url);
        if api {
            request = request.header(reqwest::header::ACCEPT, "application/octet-stream");
        }
        match from {
            None => request = request.timeout(SMALL_WAIT),
            Some(from) if from > 0 => {
                request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
            }
            Some(_) => {}
        }
        let from = from.unwrap_or(0);
        let response = request
            .send()
            .await
            .map_err(|e| Fail::Again(format!("GET `{url}`: {e}")))?;
        let status = response.status();
        if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(Fail::Again(format!("GET `{url}`: {status}")));
        }
        if !status.is_success() {
            return Err(Fail::Final(format!("GET `{url}`: {status}")));
        }
        let resumed = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|r| r.to_str().ok())
            .is_some_and(|r| r.starts_with(&format!("bytes {from}-")));
        if from > 0 && (status != reqwest::StatusCode::PARTIAL_CONTENT || !resumed) {
            return Err(Fail::Final(format!(
                "GET `{url}` was cut off at byte {from}, and the server can't go on from there"
            )));
        }
        Ok(response)
    }
}

impl Feed for HttpFeed {
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let url = format!("{}/{name}", self.base);
            let link = match self.fetch(&url, false).await {
                Ok(bytes) => return Ok(bytes),
                Err(Fail::Final(e)) => return Err(e),
                Err(Fail::Again(e)) => e,
            };
            let Some(api) = &self.api else {
                return Err(link);
            };
            match self.api_url(api, name).await {
                Ok(url) => self
                    .fetch(&url, true)
                    .await
                    .map_err(|(Fail::Again(e) | Fail::Final(e))| both_failed(&link, &e)),
                Err(e) => Err(both_failed(&link, &e)),
            }
        })
    }

    fn stream<'a>(
        &'a self,
        name: &'a str,
        sink: &'a mut Sink<'_>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut url = format!("{}/{name}", self.base);
            // The download link's failure once the asset comes through the API instead.
            let mut link: Option<String> = None;
            let (mut got, mut tries) = (0u64, 0u32);
            loop {
                let before = got;
                let cut = match self.send(&url, Some(got), link.is_some()).await {
                    Ok(mut response) => loop {
                        match response.chunk().await {
                            Ok(Some(chunk)) => {
                                sink(&chunk)?;
                                got += chunk.len() as u64;
                            }
                            Ok(None) => return Ok(()),
                            Err(e) => break format!("GET `{url}`: {e}"),
                        }
                    },
                    Err(Fail::Final(e)) => return Err(after(link, e)),
                    Err(Fail::Again(e)) => match (&link, &self.api) {
                        // A download link that answers a server error or doesn't answer: the API from here on.
                        (None, Some(api)) => {
                            url = self
                                .api_url(api, name)
                                .await
                                .map_err(|a| both_failed(&e, &a))?;
                            (link, tries) = (Some(e), 0);
                            continue;
                        }
                        _ => e,
                    },
                };
                tries = if got > before { 1 } else { tries + 1 };
                if tries > RESUMES {
                    return Err(after(link, cut));
                }
                tokio::time::sleep(RESUME_WAIT * tries).await;
            }
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
    let bytes = feed
        .get("release.json")
        .await
        .map_err(|e| download_failure("couldn't read the release", e))?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Failure::new(
            UpdateStage::Download,
            format!("the release's release.json is not valid: {e}"),
        )
    })
}

/// The release's SHA256SUMS.
pub async fn sums(feed: &dyn Feed) -> Result<HashMap<String, String>, Failure> {
    let sums = feed
        .get("SHA256SUMS")
        .await
        .map_err(|e| download_failure("couldn't read the release's checksums", e))?;
    Ok(parse_sums(&String::from_utf8_lossy(&sums)))
}

/// A checked download: the release's SHA256SUMS line for `name`, and the asset's bytes that match it. Both are
/// downloaded at once; nothing is kept unless they match. For a build that lands in a file, [`verified_to`].
pub async fn verified(feed: &dyn Feed, name: &str) -> Result<Vec<u8>, Failure> {
    let (sums, bytes) = tokio::join!(sums(feed), download(feed, name));
    let sums = sums?;
    if !sums.contains_key(name) {
        return Err(not_in_release(name));
    }
    let bytes = bytes?;
    match_sums(&sums, name, &sha256_hex(&bytes)).map(|()| bytes)
}

/// [`verified`] straight into `path`: the asset streams into a file beside it while it is hashed, and lands at `path`
/// only when it matches; otherwise that file is deleted and `path` is as it was. The sums come first, as they say
/// whether the release has the asset packed.
pub async fn verified_to(feed: &dyn Feed, name: &str, path: &Path) -> Result<(), Failure> {
    checked_to(feed, &sums(feed).await?, name, path).await
}

/// [`verified_to`] against sums already read. The packed copy when the sums list it; if that one fails (cut off for
/// good, not unpacking, not matching), the plain asset.
pub async fn checked_to(
    feed: &dyn Feed,
    sums: &HashMap<String, String>,
    name: &str,
    path: &Path,
) -> Result<(), Failure> {
    if !sums.contains_key(name) {
        return Err(not_in_release(name));
    }
    let part = staging(path);
    let packed = format!("{name}{PACKED}");
    if sums.contains_key(&packed) {
        match download_to(feed, name, true, &part)
            .await
            .and_then(|actual| land(sums, name, &actual, &part, path))
        {
            Ok(()) => return Ok(()),
            Err(f) => tracing::warn!("update: `{packed}` didn't land ({f}); downloading `{name}`"),
        }
    }
    let landed = match download_to(feed, name, false, &part).await {
        Ok(actual) => land(sums, name, &actual, &part, path),
        Err(f) => Err(f),
    };
    landed.inspect_err(|_| _ = fs::remove_file(&part))
}

/// The suffix of an asset's packed copy: `xz --format=lzma`, which streams through one small decoder.
pub const PACKED: &str = ".lzma";

/// More than any build unpacks to: a packed download that goes past it stops.
const MAX_BUILD: u64 = 1 << 30;

fn not_in_release(name: &str) -> Failure {
    Failure::new(
        UpdateStage::Download,
        format!("`{name}` is not in the release"),
    )
}

fn download_failed(name: &str, e: String) -> Failure {
    download_failure(&format!("couldn't download `{name}`"), e)
}

/// A feed's error `e` as `what: e`, or as it is when it says GitHub's downloads are failing.
fn download_failure(what: &str, e: String) -> Failure {
    let message = if e.starts_with(GITHUB_FAILING) {
        e
    } else {
        format!("{what}: {e}")
    };
    Failure::new(UpdateStage::Download, message)
}

fn not_kept(path: &Path, e: &std::io::Error) -> Failure {
    Failure::new(
        UpdateStage::Install,
        format!(
            "couldn't keep the downloaded build at `{}`: {e}",
            path.display()
        ),
    )
}

async fn download(feed: &dyn Feed, name: &str) -> Result<Vec<u8>, Failure> {
    feed.get(name).await.map_err(|e| download_failed(name, e))
}

/// Streams `name` into a new file at `part`, hashing it on the way: its SHA-256. `packed` downloads `name`'s packed
/// copy instead and unpacks it on the way, so the file and the hash are the plain asset's.
async fn download_to(
    feed: &dyn Feed,
    name: &str,
    packed: bool,
    part: &Path,
) -> Result<String, Failure> {
    if let Some(dir) = part.parent() {
        fs::create_dir_all(dir).map_err(|e| not_kept(part, &e))?;
    }
    let file = fs::File::create(part).map_err(|e| not_kept(part, &e))?;
    let mut out = Hashed {
        file,
        sha: Sha256::new(),
        len: 0,
    };
    let wrote = |e: std::io::Error| format!("couldn't write `{}`: {e}", part.display());
    if packed {
        let asset = format!("{name}{PACKED}");
        let mut unpack = lzma_rs::decompress::Stream::new(out);
        feed.stream(&asset, &mut |chunk| unpack.write_all(chunk).map_err(wrote))
            .await
            .map_err(|e| download_failed(&asset, e))?;
        out = unpack
            .finish()
            .map_err(|e| download_failed(&asset, format!("it doesn't unpack: {e}")))?;
    } else {
        feed.stream(name, &mut |chunk| out.write_all(chunk).map_err(wrote))
            .await
            .map_err(|e| download_failed(name, e))?;
    }
    out.file
        .set_permissions(fs::Permissions::from_mode(0o755))
        .and_then(|()| out.file.sync_all())
        .map_err(|e| not_kept(part, &e))?;
    Ok(hex(&out.sha.finalize()))
}

/// A download's file, and the SHA-256 and length of what was written to it.
struct Hashed {
    file: fs::File,
    sha: Sha256,
    len: u64,
}

impl Write for Hashed {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.len += bytes.len() as u64;
        if self.len > MAX_BUILD {
            return Err(std::io::Error::other("it unpacks to more than any build"));
        }
        self.file.write_all(bytes)?;
        self.sha.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// Moves the download at `part` to `path` when `actual` is what the sums name for `name`.
fn land(
    sums: &HashMap<String, String>,
    name: &str,
    actual: &str,
    part: &Path,
    path: &Path,
) -> Result<(), Failure> {
    match_sums(sums, name, actual)?;
    fs::rename(part, path).map_err(|e| not_kept(path, &e))
}

/// Ok when `actual` is the SHA-256 the sums name for `name`.
fn match_sums(sums: &HashMap<String, String>, name: &str, actual: &str) -> Result<(), Failure> {
    let expected = sums.get(name).ok_or_else(|| not_in_release(name))?;
    if actual != expected {
        return Err(Failure::new(
            UpdateStage::Checksum,
            format!(
                "`{name}`: checksum mismatch (expected `{expected}`, got `{actual}`); nothing was changed"
            ),
        ));
    }
    Ok(())
}

/// Whether the file at `path` is the build the sums name for `asset`, read in pieces rather than whole.
pub fn is_build(path: &Path, sums: &HashMap<String, String>, asset: &str) -> bool {
    sums.get(asset)
        .is_some_and(|want| file_sha256_hex(path).is_ok_and(|have| &have == want))
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
    hex(&Sha256::digest(bytes))
}

/// [`sha256_hex`] of a file, read in pieces.
pub fn file_sha256_hex(path: &Path) -> std::io::Result<String> {
    let mut sha = Sha256::new();
    std::io::copy(&mut fs::File::open(path)?, &mut sha)?;
    Ok(hex(&sha.finalize()))
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Which implementation a fleetd build is: this Rust one, or the Bun/TypeScript port (experimental/bun). Each updates to
/// its own flavour's asset, so a machine changes flavour only when `fleetd update --flavour` says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavour {
    Rust,
    Bun,
}

impl Flavour {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "rust" => Ok(Self::Rust),
            "bun" => Ok(Self::Bun),
            other => Err(format!("unknown flavour {other:?}: use rust or bun")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Bun => "bun",
        }
    }
}

/// The flavour this build is.
pub const FLAVOUR: Flavour = Flavour::Rust;

/// The Rust build a Bun one hosts its sessions under, beside it (experimental/bun/src/node/runner/helper.ts). It is
/// also the Rust build a switch back to Rust can put in place without downloading anything (docs/cutover/bun.md).
pub const HELPER: &str = "fleetd-session-host";

/// This platform's CLI asset: `fleetd-<os>-<arch>`.
pub fn cli_asset() -> Result<String, String> {
    asset_of(FLAVOUR)
}

/// This platform's asset of `flavour`: `fleetd-<os>-<arch>` for Rust, `fleetd-bun-<os>-<arch>` for Bun.
pub fn asset_of(flavour: Flavour) -> Result<String, String> {
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
    Ok(match flavour {
        Flavour::Rust => format!("fleetd-{os}-{arch}"),
        Flavour::Bun => format!("fleetd-bun-{os}-{arch}"),
    })
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

/// A binary held open: [`replace_file`] renames a new file over its path and never writes into the old one, so this
/// still reads the bytes it opened, whatever has been installed there since.
pub struct Kept(fs::File);

impl Kept {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        fs::File::open(path).map(Self)
    }

    pub fn bytes(&self) -> std::io::Result<Vec<u8>> {
        use std::os::unix::fs::FileExt;
        let mut bytes = vec![0; usize::try_from(self.0.metadata()?.len()).unwrap_or(0)];
        self.0.read_exact_at(&mut bytes, 0)?;
        Ok(bytes)
    }
}

static RUNNING: std::sync::OnceLock<Kept> = std::sync::OnceLock::new();

/// Called first thing in `main`: holds this process's binary before anything can install over its path. On the hub's
/// Mac the hub and the node run one binary, and the hub's update replaces it before the node's starts; the node's
/// rollback must put back what the node runs, not what the hub just installed.
pub fn keep_running_binary() {
    if let Ok(kept) = std::env::current_exe().and_then(|exe| Kept::open(&exe)) {
        let _ = RUNNING.set(kept);
    }
}

/// The running process's own binary, whatever has been installed over its path since: what a rollback puts back.
pub fn running_binary() -> std::io::Result<Vec<u8>> {
    match RUNNING.get() {
        Some(kept) => kept.bytes(),
        None if cfg!(target_os = "linux") => fs::read("/proc/self/exe"),
        None => Err(std::io::Error::other(
            "this process's binary wasn't kept when it started",
        )),
    }
}

/// Writes a sibling file and renames it over `path`. Never writes into the old file: a running fleetd keeps its
/// inode, and macOS kills a process whose signed binary is modified in place.
pub fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    replace_with(path, |file| file.write_all(bytes))
}

/// [`replace_file`] with a copy of the file at `from`, never held in memory whole.
pub fn replace_file_from(path: &Path, from: &Path) -> std::io::Result<()> {
    let mut from = fs::File::open(from)?;
    replace_with(path, |file| std::io::copy(&mut from, file).map(drop))
}

/// The file beside `path` that a new one is written to before it is renamed over `path`.
fn staging(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.new"))
}

fn replace_with(
    path: &Path,
    fill: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let tmp = staging(path);
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        fill(&mut file)?;
        file.set_permissions(fs::Permissions::from_mode(0o755))?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    };
    write().inspect_err(|_| _ = fs::remove_file(&tmp))
}

/// Keeps `previous` at `prev`, then puts a copy of the build at `new` at `exe`. Either step failing leaves `exe` as it
/// was.
pub fn swap(exe: &Path, new: &Path, previous: &[u8], prev: &Path) -> Result<(), Failure> {
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
    replace_file_from(exe, new).map_err(|e| install(&format!("replace {}", exe.display()), e))
}

/// Puts the binary `swap` kept back at `exe`.
pub fn restore(exe: &Path, prev: &Path) -> std::io::Result<()> {
    replace_file_from(exe, prev)
}
