//! The update notice: at launch and every 6 hours, a release build asks its channel whether a newer app exists and,
//! if so, the sidebar says to run `fleetd update` (which replaces the app; see crates/fleetd/src/cli/update.rs).
//!
//! It reads release.json from the release's download URL: a CDN download, not the GitHub API, so no token and no
//! rate limit. The nightly tag never moves, so a redirect alone cannot tell a newer nightly; the ~250-byte body
//! can. curl ships with macOS and every desktop Linux, which keeps an HTTP client out of the app.

use std::process::Command;
use std::time::Duration;

use gpui::Context;

const REPO: &str = "unlaboredlabs/fleetd";
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Set by the release build (`0.4.0`, `0.4.0-nightly.20261017.abc1234`); a local build never checks.
const RELEASE_VERSION: Option<&str> = option_env!("FLEETD_VERSION");
pub const VERSION: &str = match RELEASE_VERSION {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// Calls `set` once, with the notice, when the channel has a different app build than this one.
pub fn watch<T: 'static>(cx: &mut Context<T>, set: fn(&mut T, String)) {
    let Some(current) = RELEASE_VERSION else { return };
    let base = std::env::var("FLEETD_BASE_URL").unwrap_or_else(|_| {
        if current.contains("-nightly.") {
            format!("https://github.com/{REPO}/releases/download/nightly")
        } else {
            format!("https://github.com/{REPO}/releases/latest/download")
        }
    });
    cx.spawn(async move |this, cx| {
        loop {
            let url = format!("{base}/release.json");
            let latest = cx.background_executor().spawn(async move { app_version(&url) }).await;
            if latest.is_some_and(|v| v != current) {
                _ = this.update(cx, |this, cx| {
                    set(this, "Update available: run fleetd update".into());
                    cx.notify();
                });
                return;
            }
            cx.background_executor().timer(EVERY).await;
        }
    })
    .detach();
}

fn app_version(url: &str) -> Option<String> {
    let out = Command::new("curl").args(["-fsSL", "--max-time", "20", url]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let release: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    release.get("appVersion")?.as_str().map(str::to_string)
}
