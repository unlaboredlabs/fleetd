//! `node_action` `update`: the node updates itself to the build its hub names (hub/update), with the CLI's own pieces
//! (`crate::update`): a download checked against the release's SHA256SUMS, the previous binary kept, and the watcher
//! that restarts the node's service and puts the previous binary back if the new one doesn't come up. It answers before
//! the restart; the hub sees the outcome in the version the node reconnects with, or, when the service manager refuses
//! the restart, in a second answer the node still running sends ([`not_restarted`]).
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::mcp::{HubChannel, UpdateStage, UpdateState};
use fleetd_contracts::node_link::NodeUpdate;

use crate::update::finish::{self, HEALTH_WAIT_SECS, Health, Plan};
use crate::update::service::{self, Service};
use crate::update::{Channel, Failure, Feed};

/// What the update did before the restart.
#[derive(Debug, PartialEq)]
pub enum Staged {
    /// The node already runs it.
    Current,
    /// The new binary is in place (or already was); the watcher restarts the node next.
    Restarting(Box<Plan>),
}

/// Where this node's binary and service are, and what it runs: the real ones, or a test's.
pub struct Place {
    pub home: PathBuf,
    pub exe: PathBuf,
    pub services: Vec<Service>,
    pub running: String,
    pub release_build: bool,
    pub asset: String,
}

impl Place {
    pub fn here(home: &Path) -> Result<Self, Failure> {
        let exe = crate::update::installed_exe().map_err(|e| {
            Failure::new(
                UpdateStage::Install,
                format!("couldn't find this node's binary: {e}"),
            )
        })?;
        Ok(Self {
            home: home.to_owned(),
            services: service::services(&exe),
            exe,
            running: crate::version().to_owned(),
            release_build: option_env!("FLEETD_VERSION").is_some(),
            asset: crate::update::cli_asset()
                .map_err(|e| Failure::new(UpdateStage::Download, e))?,
        })
    }

    fn dir(&self) -> PathBuf {
        self.home.join("update")
    }

    pub fn plan_path(&self) -> PathBuf {
        self.dir().join("node-plan.json")
    }
}

/// Puts `update.version` in place, checked, keeping `previous` (the running binary) for a rollback.
pub async fn stage(
    update: &NodeUpdate,
    place: &Place,
    feed: &dyn Feed,
    previous: impl FnOnce() -> std::io::Result<Vec<u8>>,
) -> Result<Staged, Failure> {
    let to = update.version.as_str();
    if to == place.running {
        return Ok(Staged::Current);
    }
    let Some(service) = place.services.iter().find(|s| !s.hub()).cloned() else {
        return Err(Failure::new(
            UpdateStage::Restart,
            "this node doesn't run as the service `fleetd machine add` sets up, so it can't restart itself: run \
             `fleetd update` on this machine",
        ));
    };
    if !place.release_build {
        return Err(Failure::new(
            UpdateStage::Install,
            "this node runs a local build of fleetd: install a release with curl -fsSL https://fleetd.sh | sh",
        ));
    }
    let newest = crate::update::release(feed).await?.cli_version;
    if newest.as_deref() != Some(to) {
        return Err(Failure::new(
            UpdateStage::Download,
            format!(
                "the channel's newest build is now {}, not the hub's {}: update again",
                newest
                    .as_deref()
                    .map_or_else(|| "none".to_owned(), crate::version_label),
                crate::version_label(to)
            ),
        ));
    }
    let sums = crate::update::sums(feed).await?;
    // On the hub's machine the hub's update already put this build at the shared path.
    let in_place = fs::read(&place.exe)
        .ok()
        .is_some_and(|b| sums.get(&place.asset) == Some(&crate::update::sha256_hex(&b)));
    let prev = place.dir().join("fleetd.prev");
    let previous = previous().map_err(|e| {
        Failure::new(
            UpdateStage::Install,
            format!("couldn't keep the running binary for a rollback: {e}; nothing was changed"),
        )
    })?;
    if in_place {
        fs::create_dir_all(place.dir())
            .and_then(|()| crate::update::replace_file(&prev, &previous))
            .map_err(|e| {
                Failure::new(
                    UpdateStage::Install,
                    format!(
                        "couldn't keep the running binary for a rollback: {e}; nothing was changed"
                    ),
                )
            })?;
    } else {
        let bytes = crate::update::checked(feed, &sums, &place.asset).await?;
        crate::update::swap(&place.exe, &bytes, &previous, &prev)?;
    }
    Ok(Staged::Restarting(Box::new(Plan {
        exe: place.exe.clone(),
        prev,
        service,
        from: place.running.clone(),
        to: to.to_owned(),
        health: Health::Node {
            up: finish::up_path(&place.home),
        },
        wait_secs: HEALTH_WAIT_SECS,
        verdict: place.dir().join("node-verdict.json"),
    })))
}

/// What the node answers the hub, and the watcher's verdict file when it started one.
#[derive(Debug, PartialEq)]
pub struct Answer {
    pub message: String,
    pub verdict: Option<PathBuf>,
}

/// The node action: stage the update, then start the watcher that restarts this node.
pub async fn run(update: &NodeUpdate, home: &Path) -> Result<Answer, Failure> {
    let place = Place::here(home)?;
    let channel = match update.channel {
        HubChannel::Nightly => Channel::Nightly,
        HubChannel::Stable => Channel::Stable,
        HubChannel::Unknown => {
            return Err(Failure::new(
                UpdateStage::Download,
                "the hub asked for a channel this fleetd doesn't know",
            ));
        }
    };
    let feed = crate::update::HttpFeed::new(channel.base_url());
    match stage(update, &place, &feed, crate::update::running_binary).await? {
        Staged::Current => Ok(Answer {
            message: format!("already runs {}", crate::version_label(&update.version)),
            verdict: None,
        }),
        Staged::Restarting(plan) => {
            if let Err(e) = finish::start(&plan, &place.plan_path()) {
                let _ = crate::update::restore(&plan.exe, &plan.prev);
                return Err(Failure::new(
                    UpdateStage::Restart,
                    format!(
                        "couldn't start the restart ({e}), so the previous binary was put back"
                    ),
                ));
            }
            Ok(Answer {
                message: format!("restarting on {}", crate::version_label(&plan.to)),
                verdict: Some(plan.verdict),
            })
        }
    }
}

/// After the node answered "restarting": the watcher's verdict, if this process lives to read it. A restart that
/// happened ends this process first, so a verdict read here means the service manager refused the restart, and the
/// hub hears why at once instead of waiting for a node that never comes back.
pub async fn not_restarted(verdict: &Path, wait: Duration) -> Option<Failure> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if let Some(v) = finish::read_verdict(verdict)
            && v.state != UpdateState::Done
        {
            return Some(Failure::new(
                v.stage.unwrap_or(UpdateStage::Restart),
                v.message,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(VERDICT_POLL).await;
    }
}

const VERDICT_POLL: Duration = Duration::from_secs(1);

#[cfg(test)]
mod tests {
    use fleetd_contracts::prim::Text;

    use super::*;
    use crate::update::tests::FakeFeed;

    const OLD: &str = "0.0.0-nightly.202610251000+aaaaaaa";
    const NEW: &str = "0.0.0-nightly.202610261056+1b563d7";

    fn place(dir: &Path) -> Place {
        let exe = dir.join("bin/fleetd");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"old").unwrap();
        Place {
            home: dir.join("node"),
            exe,
            services: vec![Service {
                name: "fleetd-node.service".into(),
                unit: "node".into(),
            }],
            running: OLD.into(),
            release_build: true,
            asset: "fleetd-linux-x64".into(),
        }
    }

    fn to(version: &str) -> NodeUpdate {
        NodeUpdate {
            version: Text::unchecked(version.to_owned()),
            channel: HubChannel::Nightly,
        }
    }

    fn feed(binary: &[u8]) -> FakeFeed {
        FakeFeed::with(
            &[("fleetd-linux-x64", binary)],
            &format!(r#"{{"cliVersion":"{NEW}"}}"#),
        )
    }

    #[tokio::test]
    async fn puts_the_new_build_in_place_and_keeps_the_running_one() {
        let dir = tempfile::tempdir().unwrap();
        let place = place(dir.path());
        let Staged::Restarting(plan) =
            stage(&to(NEW), &place, &feed(b"new"), || Ok(b"old".to_vec()))
                .await
                .unwrap()
        else {
            panic!("not staged");
        };
        assert_eq!(fs::read(&place.exe).unwrap(), b"new");
        assert_eq!(fs::read(&plan.prev).unwrap(), b"old");
        assert_eq!(plan.service.unit, "node");
        assert_eq!((plan.from.as_str(), plan.to.as_str()), (OLD, NEW));
    }

    #[tokio::test]
    async fn a_failed_download_or_a_checksum_mismatch_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let place = place(dir.path());
        let tampered = feed(b"new");
        tampered
            .files
            .lock()
            .unwrap()
            .insert("fleetd-linux-x64".into(), b"evil".to_vec());
        let failed = stage(&to(NEW), &place, &tampered, || Ok(b"old".to_vec()))
            .await
            .unwrap_err();
        assert_eq!(failed.stage, UpdateStage::Checksum);
        assert_eq!(fs::read(&place.exe).unwrap(), b"old");

        let gone = feed(b"new");
        gone.files.lock().unwrap().remove("fleetd-linux-x64");
        let failed = stage(&to(NEW), &place, &gone, || Ok(b"old".to_vec()))
            .await
            .unwrap_err();
        assert_eq!(failed.stage, UpdateStage::Download);
        assert_eq!(fs::read(&place.exe).unwrap(), b"old");
    }

    /// The hub's Mac: the node runs the hub's binary, and the hub's update replaced it before asking the node. The
    /// node only restarts, and keeps the build it runs for its rollback, not the one the hub just put at the path.
    #[tokio::test]
    async fn on_the_hubs_machine_it_only_restarts_and_keeps_the_build_it_runs() {
        let dir = tempfile::tempdir().unwrap();
        let place = place(dir.path());
        let running = crate::update::Kept::open(&place.exe).unwrap();
        crate::update::swap(
            &place.exe,
            b"new",
            b"old",
            &dir.path().join("hub/update/fleetd.prev"),
        )
        .unwrap();
        let empty = feed(b"new");
        // Downloading would fail: the binary in place is the one the sums name.
        empty.files.lock().unwrap().remove("fleetd-linux-x64");
        let staged = stage(&to(NEW), &place, &empty, || running.bytes())
            .await
            .unwrap();
        let Staged::Restarting(plan) = staged else {
            panic!("not staged");
        };
        assert_eq!(fs::read(&place.exe).unwrap(), b"new");
        assert_eq!(fs::read(&plan.prev).unwrap(), b"old");
    }

    #[tokio::test]
    async fn already_current_or_not_a_service_or_the_channel_moved_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut place = place(dir.path());
        let current = stage(&to(OLD), &place, &feed(b"new"), || Ok(b"old".to_vec())).await;
        assert_eq!(current, Ok(Staged::Current));

        let newer = "0.0.0-nightly.202610261200+2222222";
        let moved = stage(&to(newer), &place, &feed(b"new"), || Ok(b"old".to_vec()))
            .await
            .unwrap_err();
        assert_eq!(moved.stage, UpdateStage::Download);
        assert!(moved.message.contains("update again"), "{moved}");

        place.services.clear();
        let by_hand = stage(&to(NEW), &place, &feed(b"new"), || Ok(b"old".to_vec()))
            .await
            .unwrap_err();
        assert_eq!(by_hand.stage, UpdateStage::Restart);
        assert_eq!(fs::read(&place.exe).unwrap(), b"old");
    }

    /// A verdict read by the node still running means the restart was refused: it becomes the node's second answer.
    #[tokio::test]
    async fn a_verdict_the_node_lives_to_read_is_a_refused_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-verdict.json");
        let wait = Duration::from_millis(50);
        assert_eq!(not_restarted(&path, wait).await, None);
        let refused = finish::Verdict {
            state: UpdateState::Failed,
            stage: Some(UpdateStage::Restart),
            message:
                "restarting fleetd-node.service exited with exit status: 1, so it never restarted"
                    .into(),
        };
        fs::write(&path, serde_json::to_vec(&refused).unwrap()).unwrap();
        let failed = not_restarted(&path, wait).await.unwrap();
        assert_eq!(failed.stage, UpdateStage::Restart);
        assert_eq!(failed.message, refused.message);
    }
}
