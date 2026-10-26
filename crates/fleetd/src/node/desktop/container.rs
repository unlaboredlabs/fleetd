//! Desktop containers: docker or podman, and the image they run. The image is built on the node from [`DOCKERFILE`]:
//! Debian 13 pinned by digest, its packages from snapshot.debian.org at a fixed date, so every node builds the same
//! Xvfb, window manager and xterm. Its tag carries a hash of the file, so a change builds anew.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::display::{Launched, on_path};

/// Containers' names start so; they also carry the node's label.
pub const NAME_PREFIX: &str = "fleetd-desktop-";

const LABEL: &str = "fleetd.desktop";

/// The pinned image: the base by digest, its packages from the Debian snapshot of the same day.
pub const DOCKERFILE: &str = r#"FROM docker.io/library/debian:trixie-20261020-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261020T000000Z trixie main' > /etc/apt/sources.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb openbox xterm x11-utils fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /fleetd /home/desktop && chmod 1777 /home/desktop \
 && printf '%s\n' '#!/bin/sh' \
      'Xvfb :0 -screen 0 "${FLEETD_SCREEN:-1280x800x24}" -nolisten tcp -auth /fleetd/xauth -noreset &' \
      'x=$!' \
      'i=0; while [ ! -S /tmp/.X11-unix/X0 ] && [ "$i" -lt 400 ]; do i=$((i+1)); sleep 0.05; done' \
      'openbox >/tmp/openbox.log 2>&1 &' \
      'wait "$x"' > /fleetd/entry.sh \
 && chmod 755 /fleetd/entry.sh
ENV DISPLAY=:0 XAUTHORITY=/fleetd/xauth HOME=/home/desktop LANG=C.UTF-8
WORKDIR /home/desktop
CMD ["/fleetd/entry.sh"]
"#;

/// The tag of the image [`DOCKERFILE`] builds.
pub fn image() -> String {
    let hash = Sha256::digest(DOCKERFILE.as_bytes());
    let short: String = hash[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("localhost/fleetd-desktop:{short}")
}

/// docker or podman.
#[derive(Clone, Debug, PartialEq)]
pub struct Runtime {
    pub bin: PathBuf,
    pub podman: bool,
    /// This node's containers carry it: its home, hashed.
    pub label: String,
}

/// Runs a command to its end, killed at `timeout`.
fn run(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|e| e.to_string()),
            Ok(None) if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it took over {} s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn words(out: &Output) -> String {
    let text = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    });
    let text = text.trim();
    let start = text.len().saturating_sub(800);
    let start = (start..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    text[start..].to_owned()
}

impl Runtime {
    /// node.json's `desktop.runtime`, else docker or podman on the PATH.
    pub fn find(configured: Option<&str>, home: &Path) -> Option<Self> {
        let bin = match configured {
            Some(bin) => PathBuf::from(bin),
            None => on_path("docker").or_else(|| on_path("podman"))?,
        };
        let podman = bin
            .file_name()
            .is_some_and(|n| n.to_string_lossy().contains("podman"));
        let hash = Sha256::digest(home.to_string_lossy().as_bytes());
        let label = hash[..8].iter().map(|b| format!("{b:02x}")).collect();
        Some(Self { bin, podman, label })
    }

    pub fn name(&self) -> &'static str {
        if self.podman { "podman" } else { "docker" }
    }

    fn cmd(&self) -> Command {
        Command::new(&self.bin)
    }

    /// Whether it answers: its daemon runs and the node's user may use it.
    pub fn usable(&self) -> Result<(), String> {
        let mut cmd = self.cmd();
        cmd.arg("info");
        let out = run(cmd, Duration::from_secs(15))
            .map_err(|e| format!("`{} info` failed: {e}", self.name()))?;
        match out.status.success() {
            true => Ok(()),
            false => Err(format!("`{} info` failed: {}", self.name(), words(&out))),
        }
    }

    pub fn has_image(&self, image: &str) -> bool {
        let mut cmd = self.cmd();
        cmd.args(["image", "inspect", image]);
        run(cmd, Duration::from_secs(15)).is_ok_and(|o| o.status.success())
    }

    /// Builds [`DOCKERFILE`] as `image` (minutes, the first time), its output in `log`.
    pub fn build(&self, image: &str, scratch: &Path, log: &Path) -> Result<(), String> {
        let context = scratch.join("context");
        std::fs::create_dir_all(&context).map_err(|e| e.to_string())?;
        let log_file = std::fs::File::create(log).map_err(|e| e.to_string())?;
        let mut child = self
            .cmd()
            .args(["build", "-t", image, "-f", "-"])
            .arg(&context)
            .stdin(Stdio::piped())
            .stdout(log_file.try_clone().map_err(|e| e.to_string())?)
            .stderr(log_file)
            .spawn()
            .map_err(|e| format!("cannot run {}: {e}", self.bin.display()))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(DOCKERFILE.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&context);
        match status.success() {
            true => Ok(()),
            false => {
                let text = std::fs::read_to_string(log).unwrap_or_default();
                let tail: String = text.lines().rev().take(5).collect::<Vec<_>>().join(" / ");
                Err(format!("`{} build` failed: {tail}", self.name()))
            }
        }
    }

    /// Starts a display's container, detached.
    pub fn run(
        &self,
        name: &str,
        image: &str,
        sockets: &Path,
        auth: &Path,
        mounts: &[PathBuf],
    ) -> Result<(), String> {
        let uid = nix::unistd::getuid();
        let gid = nix::unistd::getgid();
        let mut cmd = self.cmd();
        cmd.args(["run", "-d", "--rm", "--init", "--name", name])
            .arg("--label")
            .arg(format!("{LABEL}={}", self.label))
            .arg("--user")
            .arg(format!("{uid}:{gid}"))
            .args(["--shm-size", "512m"])
            .arg("-e")
            .arg(format!(
                "FLEETD_SCREEN={}x{}x24",
                super::display::SIZE.0,
                super::display::SIZE.1
            ))
            .arg("-v")
            .arg(format!("{}:/tmp/.X11-unix", sockets.display()))
            .arg("-v")
            .arg(format!("{}:/fleetd/xauth:ro", auth.display()));
        if self.podman {
            cmd.arg("--userns=keep-id");
        }
        for mount in mounts.iter().filter(|m| m.is_dir()) {
            cmd.arg("-v").arg(format!("{0}:{0}:ro", mount.display()));
        }
        cmd.arg(image);
        let out = run(cmd, Duration::from_secs(60))
            .map_err(|e| format!("`{} run` failed: {e}", self.name()))?;
        match out.status.success() {
            true => Ok(()),
            false => Err(format!("`{} run` failed: {}", self.name(), words(&out))),
        }
    }

    pub fn running(&self, name: &str) -> Result<(), String> {
        let mut cmd = self.cmd();
        cmd.args(["inspect", "-f", "{{.State.Running}}", name]);
        let out = run(cmd, Duration::from_secs(15))?;
        match String::from_utf8_lossy(&out.stdout).trim() {
            "true" => Ok(()),
            _ => Err(format!("its container {name} stopped")),
        }
    }

    pub fn logs(&self, name: &str) -> String {
        let mut cmd = self.cmd();
        cmd.args(["logs", "--tail", "20", name]);
        run(cmd, Duration::from_secs(15))
            .map(|o| words(&o))
            .unwrap_or_default()
    }

    pub fn remove(&self, name: &str) {
        let mut cmd = self.cmd();
        cmd.args(["rm", "-f", name]);
        if let Err(e) = run(cmd, Duration::from_secs(60)) {
            tracing::warn!(container = name, error = %e, "desktop container not removed");
        }
    }

    /// Removes this node's containers a node that died left behind.
    pub fn remove_leftovers(&self) -> usize {
        let mut cmd = self.cmd();
        cmd.args(["ps", "-aq", "--filter"])
            .arg(format!("label={LABEL}={}", self.label));
        let Ok(out) = run(cmd, Duration::from_secs(15)) else {
            return 0;
        };
        let ids: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        for id in &ids {
            self.remove(id);
        }
        ids.len()
    }

    /// Starts `command` in a display's container, in `cwd` when the container sees it, and looks at it a moment
    /// later.
    pub fn launch(
        &self,
        name: &str,
        command: &str,
        cwd: &Path,
        n: u32,
        settle: Duration,
    ) -> Result<Launched, String> {
        let log = format!("/tmp/launch-{n}.log");
        let mut cmd = self.cmd();
        cmd.args(["exec", name, "sh", "-c"])
            .arg(r#"cd "$1" 2>/dev/null; sh -c "$2" >"$3" 2>&1 & echo $!"#)
            .arg("sh")
            .arg(cwd)
            .arg(command)
            .arg(&log);
        let out = run(cmd, Duration::from_secs(30))
            .map_err(|e| format!("`{} exec` failed: {e}", self.name()))?;
        let pid: u32 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .map_err(|_| format!("`{} exec` failed: {}", self.name(), words(&out)))?;
        std::thread::sleep(settle);
        let mut cmd = self.cmd();
        cmd.args(["exec", name, "sh", "-c"])
            .arg(r#"if kill -0 "$1" 2>/dev/null; then echo running; else tail -c 1500 "$2"; fi"#)
            .arg("sh")
            .arg(pid.to_string())
            .arg(&log);
        let out = run(cmd, Duration::from_secs(30))?;
        let seen = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        Ok(Launched {
            pid,
            exited: (seen != "running").then_some((None, seen)),
        })
    }
}
