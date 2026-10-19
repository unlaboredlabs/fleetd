//! `fleetd update [--check] [--channel nightly|stable]`: replaces this binary, and the desktop app when the
//! installer put one in its usual place, with the latest build of a release channel, then restarts the hub and node
//! services that run this binary.
//!
//! Release assets (built by .github/workflows/build-release.yml) have version-less names next to `SHA256SUMS` and
//! `release.json`, at `releases/download/nightly/` or `releases/latest/download/`. Those are CDN downloads, not
//! the GitHub API, so there is no token and no rate limit. `FLEETD_BASE_URL` points at another asset directory.
//!
//! The desktop app also updates itself (electron-updater, app/desktop/src/main/updater.ts) from the same directory's
//! `latest-mac.yml` / `latest-linux.yml`. This reads the same feed and compares the same way, so the two never
//! disagree about whether the app is current. It also replaces the GPUI app the Electron one succeeded.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};

const REPO: &str = "unlaboredlabs/fleetd";

/// The version the release build baked in (`FLEETD_VERSION`, e.g. `0.4.0` or `0.4.0-nightly.20261017.abc1234`),
/// or the crate version for a local build.
pub fn version() -> &'static str {
    option_env!("FLEETD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Default, clap::Args)]
pub struct UpdateArgs {
    /// Only report whether a newer build exists.
    #[arg(long)]
    pub check: bool,
    /// nightly or stable. Default: the channel this build came from.
    #[arg(long)]
    pub channel: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    cli_version: Option<String>,
}

/// The top-level keys of an electron-updater feed (.github/release/update-yml.sh writes it).
#[derive(serde::Deserialize)]
struct Feed {
    version: String,
    sha512: String,
}

pub async fn run(args: UpdateArgs) -> Result<()> {
    let current = version();
    let channel = match args
        .channel
        .or_else(|| std::env::var("FLEETD_CHANNEL").ok())
    {
        Some(c) if c == "nightly" => "nightly",
        Some(c) if c == "stable" || c == "latest" => "stable",
        Some(c) => bail!("unknown channel {c:?}: use nightly or stable"),
        None => default_channel(current, option_env!("FLEETD_VERSION").is_some()),
    };
    let base = std::env::var("FLEETD_BASE_URL").unwrap_or_else(|_| match channel {
        "nightly" => format!("https://github.com/{REPO}/releases/download/nightly"),
        _ => format!("https://github.com/{REPO}/releases/latest/download"),
    });
    let http = reqwest::Client::builder()
        .user_agent(format!("fleetd/{current}"))
        .build()?;
    let release: Release =
        serde_json::from_slice(&get(&http, &format!("{base}/release.json")).await?)
            .context("release.json is not valid")?;

    let cli_latest = release.cli_version.as_deref().filter(|v| *v != current);
    let app = installed_app();
    // No feed: the release has no app build for this OS (yet).
    let feed = match &app {
        Some(a) => get(&http, &format!("{base}/{}", a.feed()))
            .await
            .ok()
            .and_then(|bytes| serde_yaml_ng::from_slice::<Feed>(&bytes).ok()),
        None => None,
    };
    let app_latest = app
        .as_ref()
        .zip(feed.as_ref())
        .filter(|(a, f)| !a.is_current(f))
        .map(|(_, f)| f.version.as_str());

    match (cli_latest, release.cli_version.as_deref()) {
        (Some(v), _) => println!("fleetd {current} -> {v} ({channel})"),
        (None, Some(_)) => println!("fleetd {current} is up to date ({channel})"),
        (None, None) => println!("the {channel} channel has no fleetd CLI build yet"),
    }
    if let (Some(app), Some(v)) = (&app, app_latest) {
        println!("app {} -> {v}", app.describe());
    }
    if args.check || (cli_latest.is_none() && app_latest.is_none()) {
        if args.check && (cli_latest.is_some() || app_latest.is_some()) {
            println!("run `fleetd update` to install");
        }
        return Ok(());
    }

    let sums = parse_sums(&String::from_utf8_lossy(
        &get(&http, &format!("{base}/SHA256SUMS")).await?,
    ));
    let fetch = async |name: &str| -> Result<Vec<u8>> {
        let expected = sums
            .get(name)
            .ok_or_else(|| anyhow!("{name} is not in the {channel} release"))?;
        let bytes = get(&http, &format!("{base}/{name}")).await?;
        let actual = hex(&Sha256::digest(&bytes));
        if &actual != expected {
            bail!(
                "{name}: checksum mismatch (expected {expected}, got {actual}); nothing was changed"
            );
        }
        Ok(bytes)
    };

    if cli_latest.is_some() {
        if option_env!("FLEETD_VERSION").is_none() {
            bail!(
                "this fleetd is a local build; install a release with: curl -fsSL https://fleetd.sh | sh"
            );
        }
        let bytes = fetch(&cli_asset()?).await?;
        let exe = fs::canonicalize(std::env::current_exe()?)?;
        replace_file(&exe, &bytes)?;
        println!("updated {}", exe.display());
        restart_services(&exe);
    }
    if let (Some(app), Some(_)) = (app, app_latest) {
        let bytes = fetch(app.asset()).await?;
        let gpui = app.gpui();
        app.replace(&bytes)?;
        println!("updated {}", app.path().display());
        if gpui {
            println!(
                "it replaces the previous fleetd app: quit that one if it is open. The new app keeps its pairing."
            );
        }
    }
    Ok(())
}

/// Nightly builds stay on nightly and tagged builds on stable. Until the first tag, local builds follow nightly.
fn default_channel(version: &str, release_build: bool) -> &'static str {
    if version.contains("-nightly.") || !release_build {
        "nightly"
    } else {
        "stable"
    }
}

async fn get(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !response.status().is_success() {
        bail!("GET {url}: {}", response.status());
    }
    Ok(response
        .bytes()
        .await
        .with_context(|| format!("GET {url}"))?
        .to_vec())
}

/// `sha256sum` output: `<hex>  <name>` per line (`*<name>` in binary mode).
fn parse_sums(text: &str) -> HashMap<String, String> {
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cli_asset() -> Result<String> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => bail!("no fleetd release build for {other}"),
    };
    Ok(format!("fleetd-{os}-{arch}"))
}

/// Writes a sibling file and renames it over `path`. Never writes into the old file: a running fleetd keeps its
/// inode, and macOS kills a process whose signed binary is modified in place.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_file_name(".fleetd.new");
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.set_permissions(fs::Permissions::from_mode(0o755))?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    };
    write()
        .inspect_err(|_| _ = fs::remove_file(&tmp))
        .with_context(|| format!("replacing {}", path.display()))
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn data_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"))
}

const APPIMAGE: &str = "fleetd-desktop.AppImage";

/// Where the installer (site/install.sh) puts the app: the bundle on macOS, the AppImage's directory on Linux. The
/// GPUI app used the same places.
enum App {
    MacOs(PathBuf),
    Linux(PathBuf),
}

fn installed_app() -> Option<App> {
    let app = if cfg!(target_os = "macos") {
        App::MacOs(home().join("Applications/fleetd.app"))
    } else {
        App::Linux(data_home().join("fleetd/app"))
    };
    (app.binary().exists() || app.gpui()).then_some(app)
}

impl App {
    fn path(&self) -> &Path {
        match self {
            App::MacOs(p) | App::Linux(p) => p,
        }
    }

    fn binary(&self) -> PathBuf {
        match self {
            App::MacOs(p) => p.join("Contents/MacOS/fleetd"),
            App::Linux(p) => p.join(APPIMAGE),
        }
    }

    /// The GPUI app is still installed here.
    fn gpui(&self) -> bool {
        match self {
            App::MacOs(p) => p.join("Contents/MacOS/fleetd-app").exists(),
            App::Linux(p) => p.join("fleetd-app").exists(),
        }
    }

    fn asset(&self) -> &'static str {
        match self {
            App::MacOs(_) => "fleetd-desktop-macos-universal.zip",
            App::Linux(_) => "fleetd-desktop-linux-x86_64.AppImage",
        }
    }

    fn feed(&self) -> &'static str {
        match self {
            App::MacOs(_) => "latest-mac.yml",
            App::Linux(_) => "latest-linux.yml",
        }
    }

    /// As electron-updater decides it: the macOS app's own version (app.getVersion(), from the package.json in its
    /// app.asar) against the feed's; the AppImage, which it replaces with the download byte for byte, by the feed's
    /// sha512.
    fn is_current(&self, feed: &Feed) -> bool {
        if self.gpui() {
            return false;
        }
        match self {
            App::MacOs(p) => {
                asar_version(&p.join("Contents/Resources/app.asar")).as_deref()
                    == Some(feed.version.as_str())
            }
            App::Linux(_) => fs::read(self.binary()).is_ok_and(|bytes| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(&bytes))
                    == feed.sha512
            }),
        }
    }

    fn describe(&self) -> String {
        match self {
            _ if self.gpui() => "(the GPUI app)".into(),
            App::MacOs(p) => asar_version(&p.join("Contents/Resources/app.asar"))
                .unwrap_or_else(|| "unknown".into()),
            App::Linux(_) => "(an older build)".into(),
        }
    }

    fn replace(&self, archive: &[u8]) -> Result<()> {
        match self {
            App::MacOs(dest) => replace_bundle(dest, archive),
            App::Linux(dir) => {
                fs::create_dir_all(dir)?;
                replace_file(&self.binary(), archive)?;
                if self.gpui() {
                    retire_gpui_linux(dir)?;
                }
                Ok(())
            }
        }
    }
}

/// Unpacks next to the installed bundle, then swaps the two with renames (an app bundle is never patched in place). A
/// running app keeps working from the old files until it restarts.
fn replace_bundle(dest: &Path, archive: &[u8]) -> Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent", dest.display()))?;
    let work = parent.join(".fleetd-app-update");
    _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work)?;
    let result = (|| -> Result<()> {
        let file = work.join("app.zip");
        fs::write(&file, archive)?;
        let unpacked = work.join("unpacked");
        fs::create_dir(&unpacked)?;
        let new = unpacked.join("fleetd.app");
        let status = Command::new("ditto")
            .arg("-x")
            .arg("-k")
            .arg(&file)
            .arg(&unpacked)
            .status()
            .context("unpacking the app")?;
        if !status.success() || !new.exists() {
            bail!("unpacking the app archive failed");
        }
        let old = work.join("old");
        fs::rename(dest, &old)?;
        if let Err(e) = fs::rename(&new, dest) {
            _ = fs::rename(&old, dest);
            return Err(e.into());
        }
        Ok(())
    })();
    _ = fs::remove_dir_all(&work);
    result.with_context(|| format!("updating {}", dest.display()))
}

/// The GPUI app's binary and menu entry go; the AppImage gets the entry site/install.sh writes. Its icon stays.
fn retire_gpui_linux(dir: &Path) -> Result<()> {
    _ = fs::remove_file(dir.join("fleetd-app"));
    _ = fs::remove_file(dir.join("fleetd.desktop"));
    let apps = data_home().join("applications");
    fs::create_dir_all(&apps)?;
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=fleetd\nComment=Watch and steer your software factory\n\
         Exec={} %u\nIcon={}\nTerminal=false\nCategories=Development;\nStartupWMClass=fleetd-desktop\n\
         MimeType=x-scheme-handler/fleetd;\n",
        dir.join(APPIMAGE).display(),
        dir.join("fleetd.png").display(),
    );
    fs::write(apps.join("fleetd-desktop.desktop"), entry)?;
    _ = fs::remove_file(apps.join("fleetd.desktop"));
    // Best effort, as in the installer: without it the app still pairs by code.
    _ = Command::new("xdg-mime")
        .args([
            "default",
            "fleetd-desktop.desktop",
            "x-scheme-handler/fleetd",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    Ok(())
}

/// The `version` of the package.json at the root of an Electron app.asar. The archive is a Chromium pickle holding
/// the JSON index (u32 LE: 4, the index pickle's size, its payload size, the JSON's length, then the JSON), followed
/// by the files, each at its index offset from the end of that pickle.
fn asar_version(asar: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(asar).ok()?;
    let mut head = [0u8; 16];
    file.read_exact(&mut head).ok()?;
    let word = |i: usize| u32::from_le_bytes(head[i..i + 4].try_into().unwrap()) as u64;
    let (index_size, json_len) = (word(4), word(12));
    let mut json = vec![0u8; usize::try_from(json_len).ok().filter(|n| *n < 64 << 20)?];
    file.read_exact(&mut json).ok()?;
    let index: serde_json::Value = serde_json::from_slice(&json).ok()?;
    let entry = &index["files"]["package.json"];
    let offset: u64 = entry["offset"].as_str()?.parse().ok()?;
    let size = usize::try_from(entry["size"].as_u64()?)
        .ok()
        .filter(|n| *n < 1 << 20)?;
    file.seek(SeekFrom::Start(8 + index_size + offset)).ok()?;
    let mut package = vec![0u8; size];
    file.read_exact(&mut package).ok()?;
    let package: serde_json::Value = serde_json::from_slice(&package).ok()?;
    package["version"].as_str().map(str::to_string)
}

/// Restarts the hub and node services `fleetd init` created for this binary: the unit files (its usual
/// unit names, any `--unit-suffix`) whose command line names `exe`. A lab's units, which run
/// another binary, are left alone.
fn restart_services(exe: &Path) {
    let exe = exe.to_string_lossy();
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let (dir, prefix, ext) = if cfg!(target_os = "macos") {
        (home().join("Library/LaunchAgents"), "sh.fleetd.", ".plist")
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"));
        (config.join("systemd/user"), "fleetd-", ".service")
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        let Some(unit) = name.strip_prefix(prefix).and_then(|n| n.strip_suffix(ext)) else {
            continue;
        };
        if !(unit.starts_with("hub") || unit.starts_with("node")) {
            continue;
        }
        if !fs::read_to_string(dir.join(&name)).is_ok_and(|text| text.contains(&*exe)) {
            continue;
        }
        let mut cmd = if cfg!(target_os = "macos") {
            let mut c = Command::new("launchctl");
            c.args([
                "kickstart",
                "-k",
                &format!("gui/{}/{prefix}{unit}", uid.as_deref().unwrap_or_default()),
            ]);
            c
        } else {
            let mut c = Command::new("systemctl");
            c.args(["--user", "restart", &name]);
            // A non-PAM SSH session has no XDG_RUNTIME_DIR, without which `systemctl --user` finds no manager.
            if std::env::var_os("XDG_RUNTIME_DIR").is_none()
                && let Some(uid) = &uid
            {
                c.env("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
            }
            c
        };
        match cmd.status() {
            Ok(s) if s.success() => println!("restarted {name}"),
            _ => eprintln!("could not restart {name}; restart it yourself"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sha256sum_output() {
        let sums = parse_sums("ABCDEF  fleetd-linux-x64\n0123 *latest-linux.yml\n\n");
        assert_eq!(
            sums.get("fleetd-linux-x64").map(String::as_str),
            Some("abcdef")
        );
        assert_eq!(
            sums.get("latest-linux.yml").map(String::as_str),
            Some("0123")
        );
        assert_eq!(sums.len(), 2);
    }

    #[test]
    fn builds_follow_their_channel() {
        assert_eq!(
            default_channel("0.4.0-nightly.20261017.abc1234", true),
            "nightly"
        );
        assert_eq!(default_channel("0.4.0", true), "stable");
        assert_eq!(default_channel("0.0.0", false), "nightly");
    }

    /// An app.asar as @electron/asar writes it: the index pickle, then the files.
    fn asar(package: &str) -> Vec<u8> {
        let other = b"console.log(1)";
        let index = format!(
            r#"{{"files":{{"out":{{"files":{{"main.js":{{"size":{},"offset":"0"}}}}}},"package.json":{{"size":{},"offset":"{}"}}}}}}"#,
            other.len(),
            package.len(),
            other.len()
        );
        let padded = index.len().div_ceil(4) * 4;
        let mut out = Vec::new();
        for word in [4, padded + 8, padded + 4, index.len()] {
            out.extend((word as u32).to_le_bytes());
        }
        out.extend(index.as_bytes());
        out.resize(16 + padded, 0);
        out.extend(other);
        out.extend(package.as_bytes());
        out
    }

    #[test]
    fn reads_the_version_electron_reports_from_app_asar() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.asar");
        fs::write(
            &path,
            asar(r#"{"name":"fleetd-desktop","version":"0.4.0-nightly.202610191200+abc1234"}"#),
        )
        .unwrap();
        assert_eq!(
            asar_version(&path).as_deref(),
            Some("0.4.0-nightly.202610191200+abc1234")
        );
        fs::write(&path, b"not an asar").unwrap();
        assert_eq!(asar_version(&path), None);
    }

    #[test]
    fn an_appimage_is_current_when_its_bytes_match_the_feed() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let app = App::Linux(dir.path().to_path_buf());
        fs::write(app.binary(), b"appimage v2").unwrap();
        let feed = |bytes: &[u8]| -> Feed {
            let sha512 =
                base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes));
            let yml = format!(
                "version: 2.0.0\nfiles:\n  - url: fleetd-desktop-linux-x86_64.AppImage\n    sha512: {sha512}\n    size: 11\npath: fleetd-desktop-linux-x86_64.AppImage\nsha512: {sha512}\nreleaseDate: '2026-10-19T12:00:00.000Z'\n"
            );
            serde_yaml_ng::from_str(&yml).unwrap()
        };
        assert!(app.is_current(&feed(b"appimage v2")));
        assert!(!app.is_current(&feed(b"appimage v3")));
        // A GPUI install is never current, whatever else is there.
        fs::write(dir.path().join("fleetd-app"), b"gpui").unwrap();
        assert!(!app.is_current(&feed(b"appimage v2")));
    }
}
