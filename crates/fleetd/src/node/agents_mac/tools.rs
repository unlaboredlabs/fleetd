//! What the agents' Mac installs for itself, pinned and checked by digest, into `<node home>/mac` (and agent-device
//! where the device sessions keep it): Node.js, which agent-device runs on; agent-device, which drives iOS simulators;
//! and agent-desktop, which drives the Mac's own apps. Nothing comes from the person's Homebrew, which agents can't
//! write and must not plant binaries in.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use sha2::Digest;

/// The Node.js release the Mac installs (an LTS).
pub const NODE_VERSION: &str = "24.22.2";

/// nodejs.org's SHASUMS256.txt for each of its macOS tarballs.
const NODE_SHA256: [(&str, &str); 2] = [
    (
        "arm64",
        "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
    ),
    (
        "x64",
        "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
    ),
];

/// The agent-desktop release the Mac installs: its npm package, which ships its native binaries built, so no install
/// script runs.
pub const DESKTOP_VERSION: &str = "1.1.0";
const DESKTOP_TARBALL: &str = "https://registry.npmjs.org/agent-desktop/-/agent-desktop-1.1.0.tgz";
const DESKTOP_INTEGRITY: &str = "sha512-4aITRplPcbV6xBFNKeehMbxSN0/L+IOhnn6LBuPXezoyr08Xl73Y6rwZiR4sM4rM/eBO6iJMoKL+IvFQvHwLEw==";

/// Where the pinned tools stand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolsState {
    /// Their versions, in words.
    Ready(String),
    Installing,
    Failed(String),
}

/// The install, as the checks read it.
#[derive(Clone)]
pub struct Installing(Arc<Mutex<ToolsState>>);

impl Default for Installing {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ToolsState::Installing)))
    }
}

impl Installing {
    pub fn state(&self) -> ToolsState {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn set(&self, state: ToolsState) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
    }

    /// Installs what isn't in place at its pinned version, once.
    pub async fn run(&self, home: &Path) {
        let state = match install(home).await {
            Ok(()) => ToolsState::Ready(versions()),
            Err(why) => {
                tracing::warn!("the agents' Mac's tools didn't install: {why}");
                ToolsState::Failed(why)
            }
        };
        self.set(state);
    }
}

pub fn versions() -> String {
    format!(
        "Node.js {NODE_VERSION}, agent-device {}, agent-desktop {DESKTOP_VERSION}.",
        crate::node::device::agent_device::VERSION
    )
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

pub fn node_dir(home: &Path) -> PathBuf {
    super::tools_dir(home).join("node")
}

/// The directory to put first on PATH for agent-device and agents' own Node.js work on the Mac.
pub fn node_bin(home: &Path) -> PathBuf {
    node_dir(home).join("bin")
}

pub fn desktop_dir(home: &Path) -> PathBuf {
    super::tools_dir(home).join("agent-desktop")
}

/// The `agent-desktop` wrapper: the native binary with its macOS helper beside it.
pub fn desktop_bin(home: &Path) -> PathBuf {
    desktop_dir(home).join("bin/agent-desktop")
}

fn pinned(dir: &Path, version: &str) -> bool {
    std::fs::read_to_string(dir.join("VERSION")).is_ok_and(|v| v.trim() == version)
}

async fn install(home: &Path) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the agents' Mac's tools run on macOS only".into());
    }
    if !pinned(&node_dir(home), NODE_VERSION) || !node_bin(home).join("node").is_file() {
        install_node(home).await?;
    }
    if crate::node::device::agent_device::find(home).is_none() {
        crate::node::device::agent_device::install(home).await?;
    }
    if !pinned(&desktop_dir(home), DESKTOP_VERSION) || !desktop_bin(home).is_file() {
        install_desktop(home).await?;
    }
    Ok(())
}

async fn fetch(url: &str, what: &str) -> Result<Vec<u8>, String> {
    let bytes = reqwest::get(url)
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("cannot download {what}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("cannot download {what}: {e}"))?;
    Ok(bytes.to_vec())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn untar(file: &Path, into: &Path, what: &str) -> Result<(), String> {
    let out = tokio::process::Command::new("tar")
        .arg("-xzf")
        .arg(file)
        .arg("-C")
        .arg(into)
        .arg("--strip-components=1")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("cannot unpack {what}: {e}"))?;
    let _ = std::fs::remove_file(file);
    if !out.status.success() {
        return Err(format!(
            "unpacking {what} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Unpacks `bytes` (a .tar.gz) fresh into `dir`.
async fn unpack(bytes: &[u8], dir: &Path, what: &str) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let file = dir.with_extension("tgz");
    std::fs::write(&file, bytes).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    untar(&file, dir, what).await
}

async fn install_node(home: &Path) -> Result<(), String> {
    let arch = arch();
    let url = format!(
        "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-darwin-{arch}.tar.gz"
    );
    let tarball = fetch(&url, "Node.js").await?;
    let want = NODE_SHA256
        .iter()
        .find(|(a, _)| *a == arch)
        .map(|(_, digest)| *digest)
        .unwrap_or_default();
    let digest = hex(&sha2::Sha256::digest(&tarball));
    if digest != want {
        return Err(format!(
            "Node.js's tarball is not the pinned one (sha256 {digest})"
        ));
    }
    let dir = node_dir(home);
    unpack(&tarball, &dir, "Node.js").await?;
    std::fs::write(dir.join("VERSION"), NODE_VERSION).map_err(|e| e.to_string())
}

async fn install_desktop(home: &Path) -> Result<(), String> {
    use base64::Engine;
    let tarball = fetch(DESKTOP_TARBALL, "agent-desktop").await?;
    let integrity = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(&tarball))
    );
    if integrity != DESKTOP_INTEGRITY {
        return Err(format!(
            "agent-desktop's package is not the pinned one (integrity {integrity})"
        ));
    }
    let dir = desktop_dir(home);
    let package = dir.join("package");
    unpack(&tarball, &package, "agent-desktop").await?;
    let arch = arch();
    let native = package.join(format!("bin/agent-desktop-darwin-{arch}"));
    let helper = package.join(format!("bin/agent-desktop-macos-helper-darwin-{arch}"));
    for file in [&native, &helper] {
        if !file.is_file() {
            return Err(format!("agent-desktop's package has no {}", file.display()));
        }
        std::fs::set_permissions(file, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    let wrapper = desktop_bin(home);
    if let Some(parent) = wrapper.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::node::secrets::write_atomic(&wrapper, wrapper_script(&native, &helper).as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", wrapper.display()))?;
    std::fs::set_permissions(
        &wrapper,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(dir.join("VERSION"), DESKTOP_VERSION).map_err(|e| e.to_string())
}

/// Runs the native agent-desktop with the helper of its own release, as its npm launcher does, without Node.js.
pub fn wrapper_script(native: &Path, helper: &Path) -> String {
    let quote = |p: &Path| p.to_string_lossy().replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-desktop {DESKTOP_VERSION}.\n\
         AGENT_DESKTOP_MACOS_HELPER_PATH='{helper}'\nexport AGENT_DESKTOP_MACOS_HELPER_PATH\n\
         exec '{native}' \"$@\"\n",
        helper = quote(helper),
        native = quote(native),
    )
}
