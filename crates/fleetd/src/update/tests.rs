//! The update core against a fake release feed and a fake runner: a failed download or a checksum mismatch changes
//! nothing, and a new build that doesn't come up healthy is put back.
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use fleetd_contracts::mcp::{UpdateStage, UpdateState};

use super::finish::{Health, Plan, Ports, Verdict, finish};
use super::service::{Service, services_in, unit_affixes};
use super::*;

/// A release feed in memory: `SHA256SUMS` over whatever assets it holds, unless a test says otherwise.
#[derive(Default)]
pub struct FakeFeed {
    pub files: Mutex<HashMap<String, Vec<u8>>>,
}

impl FakeFeed {
    pub fn with(assets: &[(&str, &[u8])], release: &str) -> Self {
        let mut files: HashMap<String, Vec<u8>> = assets
            .iter()
            .map(|(n, b)| ((*n).to_owned(), b.to_vec()))
            .collect();
        let sums: String = assets
            .iter()
            .map(|(n, b)| format!("{}  {n}\n", sha256_hex(b)))
            .collect();
        files.insert("SHA256SUMS".into(), sums.into_bytes());
        files.insert("release.json".into(), release.as_bytes().to_vec());
        Self {
            files: Mutex::new(files),
        }
    }
}

impl Feed for FakeFeed {
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        let found = self.files.lock().unwrap().get(name).cloned();
        Box::pin(async move { found.ok_or_else(|| format!("GET {name}: 404 Not Found")) })
    }
}

#[tokio::test]
async fn a_download_is_checked_against_the_releases_sums() {
    let feed = FakeFeed::with(&[("fleetd-linux-x64", b"new build")], "{}");
    assert_eq!(
        verified(&feed, "fleetd-linux-x64").await.unwrap(),
        b"new build"
    );

    let missing = verified(&feed, "fleetd-darwin-arm64").await.unwrap_err();
    assert_eq!(missing.stage, UpdateStage::Download);

    feed.files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64".into(), b"tampered".to_vec());
    let mismatch = verified(&feed, "fleetd-linux-x64").await.unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert!(
        mismatch.message.ends_with("nothing was changed"),
        "{mismatch}"
    );

    feed.files.lock().unwrap().remove("SHA256SUMS");
    let offline = verified(&feed, "fleetd-linux-x64").await.unwrap_err();
    assert_eq!(offline.stage, UpdateStage::Download);
}

#[tokio::test]
async fn reads_the_channels_newest_cli() {
    let feed = FakeFeed::with(
        &[],
        r#"{"cliVersion":"0.6.0-nightly.202610261056+1b563d7"}"#,
    );
    assert_eq!(
        release(&feed).await.unwrap().cli_version.as_deref(),
        Some("0.6.0-nightly.202610261056+1b563d7")
    );
    let broken = FakeFeed::with(&[], "not json");
    assert_eq!(
        release(&broken).await.unwrap_err().stage,
        UpdateStage::Download
    );
}

#[test]
fn a_swap_keeps_the_previous_binary_and_restore_puts_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("fleetd");
    let prev = dir.path().join("update/fleetd.prev");
    fs::write(&exe, b"old").unwrap();
    swap(&exe, b"new", b"old", &prev).unwrap();
    assert_eq!(fs::read(&exe).unwrap(), b"new");
    assert_eq!(fs::read(&prev).unwrap(), b"old");
    restore(&exe, &prev).unwrap();
    assert_eq!(fs::read(&exe).unwrap(), b"old");

    // Nowhere to keep the previous binary: the installed one stays.
    let blocked = dir.path().join("file");
    fs::write(&blocked, b"").unwrap();
    let failed = swap(&exe, b"new", b"old", &blocked.join("prev")).unwrap_err();
    assert_eq!(failed.stage, UpdateStage::Install);
    assert_eq!(fs::read(&exe).unwrap(), b"old");
}

#[test]
fn finds_this_binarys_units_hubs_first_and_leaves_a_labs_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (prefix, ext) = unit_affixes();
    let unit = |name: &str, exe: &str| {
        fs::write(
            dir.path().join(format!("{prefix}{name}{ext}")),
            format!("ExecStart={exe} run\n"),
        )
        .unwrap();
    };
    unit("node", "/home/u/.fleetd/bin/fleetd");
    unit("hub", "/home/u/.fleetd/bin/fleetd");
    unit("hub-lab3", "/tmp/lab3/fleetd");
    unit("listen", "/home/u/.fleetd/bin/fleetd");
    let found = services_in(dir.path(), Path::new("/home/u/.fleetd/bin/fleetd"));
    let units: Vec<&str> = found.iter().map(|s| s.unit.as_str()).collect();
    assert_eq!(units, ["hub", "node"]);
}

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
        Channel::of("0.4.0-nightly.20261017.abc1234", true),
        Channel::Nightly
    );
    assert_eq!(Channel::of("0.4.0", true), Channel::Stable);
    assert_eq!(Channel::of("0.0.0", false), Channel::Nightly);
    assert_eq!(Channel::parse("latest"), Ok(Channel::Stable));
    assert!(Channel::parse("beta").is_err());
}

/// The service manager and the restarted service, as a test scripts them: which version comes up healthy, and a
/// clock the watcher's waits move.
pub struct FakeRunner {
    /// What runs after each restart: the version the restarted service answers on, or None for one that never
    /// comes up.
    pub comes_up: Mutex<Vec<Option<String>>>,
    pub restarts: Mutex<Vec<String>>,
    pub refuse_restart: bool,
    running: Mutex<Option<String>>,
    now: AtomicI64,
}

impl FakeRunner {
    pub fn new(comes_up: &[Option<&str>]) -> Self {
        Self {
            comes_up: Mutex::new(
                comes_up
                    .iter()
                    .rev()
                    .map(|v| v.map(str::to_owned))
                    .collect(),
            ),
            restarts: Mutex::default(),
            refuse_restart: false,
            running: Mutex::default(),
            now: AtomicI64::new(1_000_000),
        }
    }
}

impl Ports for FakeRunner {
    fn restart(&self, service: &Service) -> Result<(), String> {
        self.restarts.lock().unwrap().push(service.name.clone());
        if self.refuse_restart {
            return Err(format!(
                "restarting {} exited with exit status: 1",
                service.name
            ));
        }
        *self.running.lock().unwrap() = self.comes_up.lock().unwrap().pop().flatten();
        Ok(())
    }

    fn healthy<'a>(&'a self, _: &'a Health, version: &'a str, _: i64) -> BoxFuture<'a, bool> {
        let up = self.running.lock().unwrap().as_deref() == Some(version);
        Box::pin(async move { up })
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
        self.now.fetch_add(
            i64::try_from(duration.as_millis()).unwrap(),
            Ordering::SeqCst,
        );
        Box::pin(async {})
    }

    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

const OLD: &str = "0.0.0-nightly.202610251000+aaaaaaa";
const NEW: &str = "0.0.0-nightly.202610261056+1b563d7";

fn plan(dir: &Path) -> Plan {
    let exe = dir.join("fleetd");
    let prev = dir.join("update/fleetd.prev");
    fs::write(&exe, b"old").unwrap();
    swap(&exe, b"new", b"old", &prev).unwrap();
    Plan {
        exe,
        prev,
        service: Service {
            name: "fleetd-hub.service".into(),
            unit: "hub".into(),
        },
        from: OLD.into(),
        to: NEW.into(),
        health: Health::Hub {
            url: "http://127.0.0.1:4790".into(),
        },
        wait_secs: 90,
        verdict: dir.join("update/hub-verdict.json"),
    }
}

#[tokio::test]
async fn a_new_build_that_comes_up_stays() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner::new(&[Some(NEW)]);
    let verdict = finish(&plan, &runner).await;
    assert_eq!(verdict.state, UpdateState::Done);
    assert_eq!(fs::read(&plan.exe).unwrap(), b"new");
    assert_eq!(*runner.restarts.lock().unwrap(), ["fleetd-hub.service"]);
}

#[tokio::test]
async fn a_new_build_that_doesnt_come_up_healthy_is_put_back() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner::new(&[None, Some(OLD)]);
    let verdict = finish(&plan, &runner).await;
    assert_eq!(
        verdict,
        Verdict {
            state: UpdateState::RolledBack,
            stage: Some(UpdateStage::Health),
            message: format!(
                "Nightly · Oct 26, 10:56 UTC · 1b563d7 ({NEW}) didn't come up healthy within 90 s, so \
                 Nightly · Oct 25, 10:00 UTC · aaaaaaa ({OLD}) was put back and runs again"
            ),
        }
    );
    assert_eq!(
        fs::read(&plan.exe).unwrap(),
        b"old",
        "the previous binary is back"
    );
    assert_eq!(runner.restarts.lock().unwrap().len(), 2);
    assert!(
        runner.now_ms() >= 1_000_000 + 90_000,
        "it waited the whole 90 s"
    );
}

#[tokio::test]
async fn a_restart_that_fails_puts_the_previous_build_back() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner {
        refuse_restart: true,
        ..FakeRunner::new(&[])
    };
    let verdict = finish(&plan, &runner).await;
    assert_eq!(verdict.state, UpdateState::RolledBack);
    assert_eq!(verdict.stage, Some(UpdateStage::Restart));
    assert!(
        verdict.message.contains("didn't come up either"),
        "{}",
        verdict.message
    );
    assert_eq!(fs::read(&plan.exe).unwrap(), b"old");
}
