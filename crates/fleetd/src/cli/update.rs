//! `fleetd update [--check] [--channel nightly|stable]`: replaces this binary, and the desktop app when the
//! installer put one in its usual place, with the latest build of a release channel, then restarts the hub and node
//! services that run this binary.
//!
//! Release assets (built by .github/workflows/build-release.yml) have version-less names next to `SHA256SUMS` and
//! `release.json`, at `releases/download/nightly/` or `releases/latest/download/`. Those are CDN downloads, not
//! the GitHub API, so there is no token and no rate limit. `FLEETD_BASE_URL` points at another asset directory.

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
    app_version: Option<String>,
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
    let app_current = app.as_ref().and_then(|a| app_version(&a.binary()));
    let app_latest = release
        .app_version
        .as_deref()
        .filter(|v| app.is_some() && Some(*v) != app_current.as_deref());

    match (cli_latest, release.cli_version.as_deref()) {
        (Some(v), _) => println!("fleetd {current} -> {v} ({channel})"),
        (None, Some(_)) => println!("fleetd {current} is up to date ({channel})"),
        (None, None) => println!("the {channel} channel has no fleetd CLI build yet"),
    }
    if let Some(v) = app_latest {
        println!("app {} -> {v}", app_current.as_deref().unwrap_or("unknown"));
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
        app.replace(&bytes)?;
        println!("updated {}", app.path().display());
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

/// Where the installer (site/install.sh) puts the app.
enum App {
    MacOs(PathBuf),
    Linux(PathBuf),
}

fn installed_app() -> Option<App> {
    let app = if cfg!(target_os = "macos") {
        App::MacOs(home().join("Applications/fleetd.app"))
    } else {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"));
        App::Linux(data.join("fleetd/app"))
    };
    app.binary().exists().then_some(app)
}

impl App {
    fn path(&self) -> &Path {
        match self {
            App::MacOs(p) | App::Linux(p) => p,
        }
    }

    fn binary(&self) -> PathBuf {
        match self {
            App::MacOs(p) => p.join("Contents/MacOS/fleetd-app"),
            App::Linux(p) => p.join("fleetd-app"),
        }
    }

    fn asset(&self) -> &'static str {
        match self {
            App::MacOs(_) => "fleetd-app-macos-universal.zip",
            App::Linux(_) => "fleetd-app-linux-x64.tar.gz",
        }
    }

    /// Unpacks next to the installed copy, then swaps the two with renames (an app bundle is never patched in
    /// place). A running app keeps working from the old files until it restarts.
    fn replace(&self, archive: &[u8]) -> Result<()> {
        let dest = self.path();
        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("{} has no parent", dest.display()))?;
        let work = parent.join(".fleetd-app-update");
        _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work)?;
        let result = (|| -> Result<()> {
            let file = work.join(self.asset());
            fs::write(&file, archive)?;
            let unpacked = work.join("unpacked");
            fs::create_dir(&unpacked)?;
            let (mut cmd, new) = match self {
                App::MacOs(_) => (Command::new("ditto"), unpacked.join("fleetd.app")),
                App::Linux(_) => (Command::new("tar"), unpacked.clone()),
            };
            match self {
                App::MacOs(_) => cmd.arg("-x").arg("-k").arg(&file).arg(&unpacked),
                App::Linux(_) => cmd.arg("-xzf").arg(&file).arg("-C").arg(&unpacked),
            };
            let status = cmd.status().context("unpacking the app")?;
            if !status.success() || !new.exists() {
                bail!("unpacking {} failed", self.asset());
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
}

/// The app prints `fleetd-app <version>` for `--version` and exits before opening a window.
fn app_version(binary: &Path) -> Option<String> {
    let out = Command::new(binary).arg("--version").output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    text.trim().strip_prefix("fleetd-app ").map(str::to_string)
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
        let sums = parse_sums("ABCDEF  fleetd-linux-x64\n0123 *fleetd-app-linux-x64.tar.gz\n\n");
        assert_eq!(
            sums.get("fleetd-linux-x64").map(String::as_str),
            Some("abcdef")
        );
        assert_eq!(
            sums.get("fleetd-app-linux-x64.tar.gz").map(String::as_str),
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
}
