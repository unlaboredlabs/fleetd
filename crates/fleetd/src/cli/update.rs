//! `fleetd update [--check] [--channel edge|stable]`: replaces this binary with the latest build of a release
//! channel, then restarts the hub and node services that run this binary, at once. A restart doesn't wait for work:
//! what it cuts off carries on by itself afterwards (see `crate::update`). The desktop app's Update button does the
//! same through the hub (`hub_update`), for the hub and every node; this is the way for a machine without the app.
//!
//! The desktop app updates itself (electron-updater, app/desktop/src/main/updater.ts). This only replaces the GPUI app
//! the Electron one succeeded, which can't.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};

use crate::update::service::{self, Service};
use crate::update::{Channel, HttpFeed, replace_file};

pub use crate::version;

#[derive(Debug, Clone, Default, clap::Args)]
pub struct UpdateArgs {
    /// Only report whether a newer build exists.
    #[arg(long)]
    pub check: bool,
    /// edge or stable (nightly, Edge's earlier name, is edge). Default: the channel this build came from.
    #[arg(long)]
    pub channel: Option<String>,
    /// Restart the hub and node now. Kept for scripts from before restarts stopped waiting for work: they always do.
    #[arg(long)]
    pub restart_now: bool,
}

pub async fn run(args: UpdateArgs) -> Result<()> {
    let current = version();
    let channel = match args
        .channel
        .or_else(|| std::env::var("FLEETD_CHANNEL").ok())
    {
        Some(c) => Channel::parse(&c).map_err(|e| anyhow!(e))?,
        None => Channel::of(current, option_env!("FLEETD_VERSION").is_some()),
    };
    let channel_name = channel.as_str();
    let feed = HttpFeed::new(channel.base_url());
    let release = crate::update::release(&feed).await?;

    let cli_latest = release.cli_version.as_deref().filter(|v| *v != current);
    let app = installed_app();
    if let Some(a) = &app {
        a.tidy();
    }
    let mut gpui = app.filter(App::gpui);
    if matches!(gpui, Some(App::MacOs(_))) && macos_major().is_some_and(|v| v < 12) {
        println!(
            "the fleetd app needs macOS 12 or newer; the app you have stays as it is (the CLI still updates)"
        );
        gpui = None;
    }

    let exe = crate::update::installed_exe()?;
    let services = service::services(&exe);
    let hub = match services.iter().any(Service::hub) {
        true => ask_hub().await.ok(),
        false => None,
    };
    // An earlier update installed this binary, and the hub still runs the one before.
    let pending = hub
        .as_deref()
        .filter(|v| cli_latest.is_none() && *v != current && *v != "0.0.0");

    match (cli_latest, release.cli_version.as_deref()) {
        (Some(v), _) => println!(
            "fleetd {} -> {} ({channel_name})",
            crate::version_shown(current),
            crate::version_shown(v)
        ),
        (None, Some(_)) => println!(
            "fleetd {} is up to date ({channel_name})",
            crate::version_shown(current)
        ),
        (None, None) => println!("the {channel_name} channel has no fleetd CLI build yet"),
    }
    if let Some(v) = pending {
        println!(
            "the hub still runs {}; a restart moves it to {}",
            crate::version_shown(v),
            crate::version_shown(current)
        );
    }
    if gpui.is_some() {
        println!("this replaces the earlier fleetd app with the new one, which keeps its pairing");
    }
    let restart_due =
        !services.is_empty() && (cli_latest.is_some() || pending.is_some() || args.restart_now);
    if args.check || (!restart_due && gpui.is_none()) {
        if args.check && (cli_latest.is_some() || gpui.is_some()) {
            println!("run `fleetd update` to install");
        } else if args.check && pending.is_some() {
            println!("run `fleetd update` to restart it");
        }
        return Ok(());
    }

    if cli_latest.is_some() {
        if option_env!("FLEETD_VERSION").is_none() {
            bail!(
                "this fleetd is a local build; install a release with: curl -fsSL https://fleetd.sh | sh"
            );
        }
        let asset = crate::update::cli_asset().map_err(|e| anyhow!(e))?;
        let bytes = crate::update::verified(&feed, &asset).await?;
        replace_file(&exe, &bytes).with_context(|| format!("replacing {}", exe.display()))?;
        println!("updated {}", exe.display());
    }
    if restart_due {
        restart(&services);
    }
    // This machine runs agents: its Claude Code goes to the version the installed build was tested with, which only
    // that build knows.
    if cli_latest.is_some() && services.iter().any(|s| !s.hub()) {
        let status = Command::new(&exe).arg("update-claude").status();
        if !status.is_ok_and(|s| s.success()) {
            eprintln!(
                "Claude Code wasn't brought to the version fleetd is tested with; `fleetd doctor` says more"
            );
        }
    }
    if let Some(app) = gpui {
        let bytes = crate::update::verified(&feed, app.asset()).await?;
        app.replace(&bytes)?;
        println!("updated {}", app.path().display());
        println!("if the earlier fleetd app is open, quit it and open the new one");
    }
    Ok(())
}

/// `fleetd update-claude`: brings this machine's Claude Code to the version this build was tested with, saying how it
/// went. Sessions already running finish on the version they started with.
pub fn run_claude() -> std::process::ExitCode {
    use crate::node::runner::claude::install::{self, Installed};
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("fleetd update-claude: {e}");
            return std::process::ExitCode::from(1);
        }
    };
    let claude = install::Real {
        binary: crate::node::claude_binary(),
        env: std::env::vars().collect(),
    };
    let target = install::target();
    match runtime.block_on(install::bring_to(&claude, target)) {
        Ok(Installed::Current(v)) => {
            println!("Claude Code {v} is the version fleetd is tested with")
        }
        Ok(Installed::Left(said)) => println!("{said}"),
        Ok(Installed::Done { from, to }) => println!(
            "Claude Code {from} -> {to}: new sessions start on {to}, running ones finish on {from}"
        ),
        Err(f) => {
            eprintln!("{f}");
            return std::process::ExitCode::from(1);
        }
    }
    std::process::ExitCode::SUCCESS
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

    /// The GPUI app is still installed here. On Linux a `fleetd-app` beside the AppImage is the launcher a
    /// pre-Electron `fleetd update` installed with it (build-release.yml's fleetd-app-linux-x64.tar.gz), not GPUI.
    fn gpui(&self) -> bool {
        match self {
            App::MacOs(p) => p.join("Contents/MacOS/fleetd-app").exists(),
            App::Linux(p) => p.join("fleetd-app").exists() && !self.binary().exists(),
        }
    }

    /// After a pre-Electron `fleetd update` moved a Linux install to the AppImage: drop its launcher and give the app
    /// the installer's menu entry, without downloading anything.
    fn tidy(&self) {
        if let App::Linux(dir) = self
            && dir.join("fleetd-app").exists()
            && self.binary().exists()
        {
            match retire_gpui_linux(dir) {
                Ok(()) => println!("moved the app's menu entry to the new fleetd app"),
                Err(e) => eprintln!("could not move the app's menu entry: {e:#}"),
            }
        }
    }

    fn asset(&self) -> &'static str {
        match self {
            App::MacOs(_) => "fleetd-desktop-macos-universal.zip",
            App::Linux(_) => "fleetd-desktop-linux-x86_64.AppImage",
        }
    }

    fn replace(&self, archive: &[u8]) -> Result<()> {
        match self {
            App::MacOs(dest) => replace_bundle(dest, archive),
            App::Linux(dir) => {
                fs::create_dir_all(dir)?;
                replace_file(&self.binary(), archive)?;
                retire_gpui_linux(dir)
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

/// The running macOS's major version (`sw_vers -productVersion`), or None off macOS or when it can't be read.
fn macos_major() -> Option<u32> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// The version the hub on this machine runs (`hub_info`), through the CLI's own key.
async fn ask_hub() -> Result<String, String> {
    let home = super::hub_key::resolve_home(None)?;
    let mut client = super::setup::doctor::connect_as(&home, "fleetd-update")
        .await
        .map_err(|f| f.message)?;
    super::versions::hub_info(&mut client)
        .await
        .map(|i| i.version)
}

/// Restarts `services` now, saying which did. What runs on them carries on by itself afterwards.
fn restart(services: &[Service]) {
    for s in services {
        match service::restart(s) {
            Ok(()) => println!("restarted {}", s.name),
            Err(e) => eprintln!("{e}; restart {} yourself", s.name),
        }
    }
    println!(
        "anything that was running carries on by itself: leads and agents resume in their threads, and the merge \
         train takes up what it was merging"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_linux_install_without_the_appimage_is_gpui() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::Linux(dir.path().to_path_buf());
        fs::write(dir.path().join("fleetd-app"), b"#!/bin/sh").unwrap();
        assert!(app.gpui());
        // The launcher a pre-Electron `fleetd update` put beside the AppImage doesn't make it GPUI.
        fs::write(app.binary(), b"appimage").unwrap();
        assert!(!app.gpui());
    }
}
