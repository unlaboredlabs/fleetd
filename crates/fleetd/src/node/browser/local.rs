//! What a Navi's browser may touch on this machine. Its Chrome is the node's, outside the Navi's sandbox (D196), so it
//! could read any file the node can: another Navi's kept profile and its cookies (D221), the node's own config. In a
//! Navi's session it reads and writes only in the Navi's folder; every other session is as before.
//!
//! - Every `file:` load fails, whatever asked for it: the driver, a page's link, a new tab or browser context, a
//!   request the driver's own interception rewrote. The node intercepts them all from its own hidden session on the
//!   browser target (`Fetch`), which the driver can't reach or turn off: the proxy refuses commands that name the
//!   node's sessions or detach its targets (proxy.rs), and should that session go anyway, the browser session ends.
//!   Chrome already refuses a web page's redirects and links to `file:`. The driver's `file:`, `view-source:file:` and
//!   `filesystem:` URLs are refused before they go, saying why.
//! - An upload (`DOM.setFileInputFiles`, or files dropped on the page with `Input.dispatchDragEvent`) is of files in the
//!   folder only: the real path of each file the node opened is checked to be inside it, and Chrome gets a copy only
//!   the node can see, so a link swapped in after the check leads nowhere.
//! - Downloads go to the folder itself, by default and wherever the driver says (`setDownloadBehavior`). Not a folder
//!   inside it: the Navi could swap that for a link out of it before Chrome writes there. Each is saved under a name
//!   of Chrome's own (`allowAndName`), as agent-browser's `download` asks anyway, then renames it: a site's file name
//!   (`allow`) would overwrite the folder's file of that name.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{Value, json};

use super::cdp::Cdp;
use crate::node::util::AbortOnDrop;

/// Where the node keeps the copies of the files a Navi's sessions upload: under its home, which the Navi's sandbox
/// hides.
pub fn uploads_dir(home: &Path) -> PathBuf {
    home.join("browser").join("uploads")
}

/// A Navi's browser session's hold on what its browser touches.
pub struct Fence {
    /// The Navi's folder, its links resolved.
    folder: PathBuf,
    /// This session's upload copies; gone with the session.
    staging: PathBuf,
    copies: AtomicU64,
    /// The node's session on the browser target went: nothing holds `file:` back any more.
    breached: Arc<AtomicBool>,
    _refuser: AbortOnDrop,
}

/// What the browser session does once its fence is gone: end.
pub type OnBreach = Box<dyn FnOnce() + Send>;

impl Fence {
    /// Puts the fence on a browser no driver has reached yet: its `file:` loads refused, its downloads in `folder`.
    /// Should the node's session that holds it go, every later command is refused and `on_breach` ends the session.
    pub async fn start(
        cdp: &Arc<Cdp>,
        folder: &Path,
        staging: PathBuf,
        on_breach: OnBreach,
    ) -> Result<Self, String> {
        let real = folder
            .canonicalize()
            .map_err(|e| format!("the Navi's folder {} can't be read: {e}", folder.display()))?;
        let browser = cdp
            .call(None, "Target.getTargetInfo", json!({}))
            .await?
            .pointer("/targetInfo/targetId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or("the browser named no target of its own")?;
        let own = cdp.attach(&browser).await?;
        let mut events = cdp.events();
        let breached = Arc::new(AtomicBool::new(false));
        let refuser = {
            let (cdp, own, breached) = (Arc::downgrade(cdp), own.clone(), breached.clone());
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    if event.method == "Target.detachedFromTarget"
                        && event.params["sessionId"].as_str() == Some(own.as_str())
                    {
                        breached.store(true, Ordering::SeqCst);
                        tracing::warn!("a Navi's browser lost its file fence; ending its session");
                        on_breach();
                        return;
                    }
                    if event.method != "Fetch.requestPaused"
                        || event.session_id.as_deref() != Some(own.as_str())
                    {
                        continue;
                    }
                    let Some(cdp) = cdp.upgrade() else { return };
                    cdp.post(
                        Some(&own),
                        "Fetch.failRequest",
                        json!({ "requestId": event.params["requestId"], "errorReason": "AccessDenied" }),
                    );
                }
            })
        };
        cdp.call(
            Some(&own),
            "Fetch.enable",
            json!({ "patterns": [{ "urlPattern": "file:*" }] }),
        )
        .await?;
        cdp.call(
            Some(&own),
            "Browser.setDownloadBehavior",
            json!({ "behavior": "allowAndName", "downloadPath": real }),
        )
        .await?;
        Ok(Self {
            folder: real,
            staging,
            copies: AtomicU64::new(0),
            breached,
            _refuser: AbortOnDrop(refuser),
        })
    }

    /// The driver's command as it may go to the browser (an upload's files swapped for the node's copies), or why it
    /// may not.
    pub async fn check(self: &Arc<Self>, mut command: Value) -> Result<Value, String> {
        if self.breached.load(Ordering::SeqCst) {
            return Err(
                "This browser session lost what keeps it to your folder, so it is ending. Start a new one with \
                 session_start."
                    .to_owned(),
            );
        }
        let method = command["method"].as_str().unwrap_or_default().to_owned();
        let params = &mut command["params"];
        match method.as_str() {
            "Page.navigate" | "Target.createTarget" => {
                let url = params["url"].as_str().unwrap_or_default();
                if local_url(url) {
                    return Err(format!(
                        "{url} is refused: a Navi's browser opens no files on this machine. Open a web address; to \
                         read a file in your folder, read it with your own tools."
                    ));
                }
            }
            "Browser.setDownloadBehavior" | "Page.setDownloadBehavior" => {
                self.downloads(params)?;
            }
            "DOM.setFileInputFiles" => {
                let copies = self.stage_all(&params["files"]).await?;
                params["files"] = copies;
            }
            // Files dragged onto the page: the page reads each as a file input's.
            "Input.dispatchDragEvent" if !params["data"]["files"].is_null() => {
                let copies = self.stage_all(&params["data"]["files"]).await?;
                params["data"]["files"] = copies;
            }
            _ => {}
        }
        Ok(command)
    }

    /// The node's copies of the files the driver named (a list of paths), or why one can't be uploaded.
    async fn stage_all(self: &Arc<Self>, files: &Value) -> Result<Value, String> {
        let files: Vec<String> = match files {
            Value::Array(files) => files
                .iter()
                .map(|f| f.as_str().unwrap_or_default().to_owned())
                .collect(),
            _ => return Err("files must be a list of paths in your folder".to_owned()),
        };
        let fence = self.clone();
        let copies = tokio::task::spawn_blocking(move || {
            files
                .iter()
                .map(|f| fence.stage(f))
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(json!(copies))
    }

    /// A download behavior the driver sets: refusing all, or saving to the folder itself under Chrome's names (the
    /// folder written as its real path).
    fn downloads(&self, params: &mut Value) -> Result<(), String> {
        let behavior = params["behavior"].as_str().unwrap_or_default();
        if behavior == "deny" {
            return Ok(());
        }
        let path = params["downloadPath"].as_str().unwrap_or_default();
        let real = Path::new(path).canonicalize().ok();
        if behavior != "allowAndName" || real.as_deref() != Some(&self.folder) {
            return Err(format!(
                "Downloads ({behavior}{}) are refused: a Navi's browser saves downloads only in its own folder, {}, \
                 not a folder inside it or anywhere else, and each under a name of Chrome's own, so no site \
                 overwrites a file there. Use agent-browser download <ref> ./<name>, then move the file.",
                if path.is_empty() {
                    String::new()
                } else {
                    format!(" to {path}")
                },
                self.folder.display()
            ));
        }
        params["downloadPath"] = json!(self.folder);
        Ok(())
    }

    /// A copy, only the node's, of the file at `path` in the folder (or relative to it), or why it can't be uploaded.
    fn stage(&self, path: &str) -> Result<String, String> {
        let outside = || {
            format!(
                "{path} is outside your folder, or a link out of it: a Navi's browser uploads only files in its own \
                 folder, {}",
                self.folder.display()
            )
        };
        // Not blocking on a FIFO the Navi left there; a regular file reads as usual.
        let mut file = std::os::unix::fs::OpenOptionsExt::custom_flags(
            std::fs::OpenOptions::new().read(true),
            nix::fcntl::OFlag::O_NONBLOCK.bits(),
        )
        .open(self.folder.join(path))
        .map_err(|e| format!("{path} can't be uploaded: {e}"))?;
        let real = real_path(&file).map_err(|_| outside())?;
        if !real.starts_with(&self.folder) {
            return Err(outside());
        }
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            return Err(format!("{path} isn't a file"));
        }
        // The name the Navi gave it, which the site sees, not where a link inside the folder leads.
        let name = Path::new(path)
            .file_name()
            .ok_or_else(|| format!("{path} names no file"))?;
        let dir = self
            .staging
            .join(self.copies.fetch_add(1, Ordering::Relaxed).to_string());
        let copied = crate::node::config::mkdir_private(&dir).and_then(|()| {
            let mut copy = std::fs::File::create_new(dir.join(name))?;
            std::io::copy(&mut file, &mut copy)
        });
        copied.map_err(|e| format!("{path} can't be uploaded: {e}"))?;
        Ok(dir.join(name).to_string_lossy().into_owned())
    }
}

impl Drop for Fence {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.staging);
    }
}

/// Whether the driver's `url` reads this machine's disk: `file:`, also behind `view-source:`, or `filesystem:`.
fn local_url(url: &str) -> bool {
    let mut url = url.trim().to_ascii_lowercase();
    while let Some(rest) = url.strip_prefix("view-source:") {
        url = rest.trim_start().to_owned();
    }
    url.starts_with("file:") || url.starts_with("filesystem:")
}

/// Where the open `file` is, through every link, as the kernel says (not as a path read again might).
#[cfg(target_os = "linux")]
fn real_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
fn real_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    let mut path = PathBuf::new();
    nix::fcntl::fcntl(file, nix::fcntl::FcntlArg::F_GETPATH(&mut path))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_drivers_urls_that_read_the_disk_are_known_however_written() {
        for url in [
            "file:///etc/hostname",
            "  FILE:/etc/hostname",
            "view-source:file:///etc/hostname",
            "view-source: view-source:file:///x",
            "filesystem:http://example.org/temporary/x",
        ] {
            assert!(local_url(url), "{url}");
        }
        for url in [
            "https://example.org/file:///x",
            "view-source:https://example.org",
            "about:blank",
            "",
        ] {
            assert!(!local_url(url), "{url}");
        }
    }
}
