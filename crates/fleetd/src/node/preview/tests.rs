//! The runner end to end on a real git checkout: a tiny site the project serves with `python3 -m http.server`, its
//! port opened by the proxy on loopback (any address works in a test; the owner check is a fake tailscale), and
//! minutes of a few hundred milliseconds.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::preview::{
    PreviewEndReason, PreviewReport, PreviewRunFrame, PreviewState, PreviewStepState,
    PreviewStopFrame,
};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;

const OWNER: &str = "me@example.com";

/// Every peer is the owner's device.
struct Owner;

impl proxy::Whois for Owner {
    fn whois(&self, _peer: SocketAddr) -> proxy::BoxFuture<'_, std::io::Result<proxy::Peer>> {
        Box::pin(async {
            Ok(proxy::Peer {
                login: OWNER.to_owned(),
                tags: Vec::new(),
            })
        })
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A project: `origin` with `main` and branches, and the node's checkout of it.
struct Project {
    dir: tempfile::TempDir,
}

impl Project {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q"]);
        std::fs::write(origin.join("index.html"), "<h1>shop</h1>\n").unwrap();
        std::fs::write(origin.join("deps.lock"), "v1\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "shop"]);
        git(dir.path(), &["clone", "-q", "origin", "checkout"]);
        Self { dir }
    }

    fn origin(&self) -> PathBuf {
        self.dir.path().join("origin")
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("checkout")
    }

    /// Where the commands write what ran, outside every worktree.
    fn log(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn ran(&self, name: &str) -> usize {
        std::fs::read_to_string(self.log(name))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    /// A branch off `main` adding `file`; answers its head.
    fn branch(&self, name: &str, file: &str, text: &str) -> String {
        let origin = self.origin();
        git(&origin, &["checkout", "-q", "-b", name, "main"]);
        std::fs::write(origin.join(file), text).unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", name]);
        let sha = git(&origin, &["rev-parse", "HEAD"]);
        git(&origin, &["checkout", "-q", "main"]);
        sha
    }

    fn web(&self, build: &str) -> serde_json::Value {
        json!({
            "setup": [format!("echo set >> {}", self.log("setup").display())],
            "build": format!("{build}; echo built >> {}", self.log("builds").display()),
            "start": "exec python3 -m http.server \"$PORT\" --bind 127.0.0.1",
            "inputs": ["deps.lock"],
        })
    }
}

fn preview_id(n: u32) -> String {
    format!("P{n:032x}")
}

fn frame(
    id: u32,
    heads: &[(&str, &str)],
    base: Option<&str>,
    web: serde_json::Value,
    idle: i64,
) -> PreviewRunFrame {
    let mut v = json!({
        "id": format!("r{id}"),
        "previewId": preview_id(id),
        "projectId": "p1",
        "target": "web",
        "heads": heads.iter().map(|(b, s)| json!({ "branch": b, "sha": s })).collect::<Vec<_>>(),
        "web": web,
        "idleMinutes": idle,
    });
    if let Some(base) = base {
        v["base"] = json!(base);
    }
    serde_json::from_value(v).unwrap()
}

struct Harness {
    previews: Arc<Previews>,
    reports: mpsc::UnboundedReceiver<String>,
    _home: tempfile::TempDir,
}

fn harness(project: &Project) -> Harness {
    let home = tempfile::tempdir().unwrap();
    let root = project.root();
    let detect: DetectTailnet = Arc::new(|| {
        Box::pin(async {
            Ok(proxy::Config {
                addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
                host: None,
                ports: 18400..=18499,
                owner: OWNER.to_owned(),
                whois: Arc::new(Owner),
            })
        })
    });
    let timing = Timing {
        minute: Duration::from_millis(100),
        tick: Duration::from_millis(20),
        ready_within: Duration::from_secs(15),
        build_timeout: Duration::from_secs(60),
    };
    let previews = Previews::new(
        home.path(),
        &PreviewNodeConfig::default(),
        Arc::new(move |_| Some(root.clone())),
        detect,
        timing,
    );
    let (tx, reports) = mpsc::unbounded_channel();
    previews.attach(tx);
    Harness {
        previews,
        reports,
        _home: home,
    }
}

impl Harness {
    /// The first report of `id` that `pred` takes, within 30 s.
    async fn until(&mut self, id: u32, pred: impl Fn(&PreviewReport) -> bool) -> PreviewReport {
        let want = preview_id(id);
        let wait = async {
            while let Some(line) = self.reports.recv().await {
                if let Ok(NodeToHub::PreviewReport(r)) = serde_json::from_str::<NodeToHub>(&line)
                    && r.preview_id.as_str() == want
                    && pred(&r)
                {
                    return r;
                }
            }
            panic!("reports ended");
        };
        tokio::time::timeout(Duration::from_secs(30), wait)
            .await
            .expect("the report came")
    }

    async fn ready(&mut self, id: u32) -> PreviewReport {
        let r = self.until(id, |r| r.state != PreviewState::Starting).await;
        assert_eq!(r.state, PreviewState::Ready, "{r:#?}");
        r
    }

    fn stop(&self, id: u32, reason: PreviewEndReason) {
        self.previews.stop(PreviewStopFrame {
            preview_id: fleetd_contracts::preview::PreviewId::new(preview_id(id)).unwrap(),
            reason,
        });
    }
}

async fn get(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    client.get(url).send().await.ok()?.text().await.ok()
}

fn states(r: &PreviewReport) -> Vec<PreviewStepState> {
    r.steps.iter().map(|s| s.state).collect()
}

#[tokio::test]
async fn a_preview_is_set_up_built_started_opened_and_thrown_away() {
    let project = Project::new();
    let sha = project.branch("feat", "page.html", "<p>new checkout</p>\n");
    let mut h = harness(&project);
    let run = h
        .previews
        .run(frame(1, &[("feat", &sha)], None, project.web("true"), 30));
    assert!(run.error.is_none(), "{:?}", run.error);

    let ready = h.ready(1).await;
    assert_eq!(
        states(&ready),
        vec![PreviewStepState::Done; 5],
        "{ready:#?}"
    );
    assert_eq!(ready.head.as_ref().map(|h| h.as_str()), Some(sha.as_str()));
    assert!(ready.idle_until.is_some());
    let url = ready.url.expect("opened on the tailnet").to_string();
    let page = get(&format!("{url}/page.html"))
        .await
        .expect("the app answers through its port");
    assert!(page.contains("new checkout"), "{page}");

    h.stop(1, PreviewEndReason::Ended);
    let ended = h.until(1, |r| r.state.is_over()).await;
    assert_eq!(
        (ended.state, ended.end_reason),
        (PreviewState::Ended, Some(PreviewEndReason::Ended))
    );
    assert!(ended.url.is_none());
    assert!(get(&url).await.is_none(), "the port is closed");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.previews.running(), 0);
}

#[tokio::test]
async fn the_same_commit_again_reuses_its_setup_and_its_build() {
    let project = Project::new();
    let sha = project.branch("feat", "page.html", "<p>a</p>\n");
    let mut h = harness(&project);
    h.previews
        .run(frame(1, &[("feat", &sha)], None, project.web("true"), 30));
    h.ready(1).await;
    h.stop(1, PreviewEndReason::Ended);
    h.until(1, |r| r.state.is_over()).await;

    h.previews
        .run(frame(2, &[("feat", &sha)], None, project.web("true"), 30));
    let again = h.ready(2).await;
    let states = states(&again);
    assert_eq!(states[1], PreviewStepState::Reused, "setup: {again:#?}");
    assert_eq!(states[2], PreviewStepState::Reused, "build: {again:#?}");
    assert_eq!((project.ran("setup"), project.ran("builds")), (1, 1));
    h.stop(2, PreviewEndReason::Ended);
    h.until(2, |r| r.state.is_over()).await;
}

#[tokio::test]
async fn a_failed_build_fails_the_preview_with_its_output_and_starts_nothing() {
    let project = Project::new();
    let sha = project.branch("feat", "page.html", "<p>a</p>\n");
    let mut h = harness(&project);
    h.previews.run(frame(
        1,
        &[("feat", &sha)],
        None,
        project.web("echo boom; exit 3"),
        30,
    ));
    let failed = h.until(1, |r| r.state.is_over()).await;
    assert_eq!(failed.state, PreviewState::Failed);
    let build = &failed.steps[2];
    assert_eq!(build.state, PreviewStepState::Failed);
    assert!(
        build
            .output_tail
            .as_ref()
            .is_some_and(|t| t.as_str().contains("boom")),
        "{build:#?}"
    );
    assert!(
        failed
            .note
            .as_ref()
            .is_some_and(|n| n.as_str().contains("exited 3")),
        "{failed:#?}"
    );
    assert_eq!(
        states(&failed)[3],
        PreviewStepState::Queued,
        "never started"
    );
}

#[tokio::test]
async fn a_preview_no_one_uses_ends_after_its_idle_time() {
    let project = Project::new();
    let sha = project.branch("feat", "page.html", "<p>a</p>\n");
    let mut h = harness(&project);
    // 5 of the test's minutes: half a second.
    h.previews
        .run(frame(1, &[("feat", &sha)], None, project.web("true"), 5));
    h.ready(1).await;
    let ended = h.until(1, |r| r.state.is_over()).await;
    assert_eq!(ended.end_reason, Some(PreviewEndReason::Idle), "{ended:#?}");
}

#[tokio::test]
async fn an_order_runs_its_prs_merged_together_and_a_conflict_fails_it() {
    let project = Project::new();
    let a = project.branch("cart", "cart.html", "cart\n");
    let b = project.branch("pay", "pay.html", "pay\n");
    let mut h = harness(&project);
    h.previews.run(frame(
        1,
        &[("cart", &a), ("pay", &b)],
        Some("main"),
        project.web("true"),
        30,
    ));
    let ready = h.ready(1).await;
    let url = ready.url.expect("opened").to_string();
    assert!(
        get(&format!("{url}/cart.html"))
            .await
            .is_some_and(|p| p.contains("cart"))
    );
    assert!(
        get(&format!("{url}/pay.html"))
            .await
            .is_some_and(|p| p.contains("pay"))
    );
    h.stop(1, PreviewEndReason::Ended);
    h.until(1, |r| r.state.is_over()).await;

    let c = project.branch("other-cart", "cart.html", "a different cart\n");
    h.previews.run(frame(
        2,
        &[("cart", &a), ("other-cart", &c)],
        Some("main"),
        project.web("true"),
        30,
    ));
    let failed = h.until(2, |r| r.state.is_over()).await;
    assert_eq!(failed.state, PreviewState::Failed);
    let note = failed.note.map(|n| n.to_string()).unwrap_or_default();
    assert!(
        note.contains("other-cart") && note.contains("cart.html"),
        "{note}"
    );
}

#[tokio::test]
async fn a_branch_or_commit_that_isnt_one_never_reaches_git() {
    let project = Project::new();
    let sha = project.branch("feat", "page.html", "<p>a</p>\n");
    let marker = project.log("pwned");
    let h = harness(&project);
    let upload_pack = format!("--upload-pack=touch {}", marker.display());
    for (branch, commit) in [
        (upload_pack.as_str(), sha.as_str()),
        ("feat", "--output=/tmp/x"),
        ("feat", "3f2a91c"),
        ("feat..main", sha.as_str()),
    ] {
        let run = h
            .previews
            .run(frame(1, &[(branch, commit)], None, project.web("true"), 30));
        assert!(run.error.is_some(), "{branch} {commit} was taken");
    }
    let run = h.previews.run(frame(
        2,
        &[("feat", &sha)],
        Some("-main"),
        project.web("true"),
        30,
    ));
    assert!(run.error.is_some(), "a base starting with - was taken");
    assert_eq!(h.previews.running(), 0);
    assert!(
        !marker.exists(),
        "git ran an option it was handed as a branch"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_node_that_starts_ends_what_its_last_run_left_running() {
    let home = tempfile::tempdir().unwrap();
    let slot = slots::project_dir(home.path(), "p1").join("1");
    std::fs::create_dir_all(&slot).unwrap();
    let mut child = std::os::unix::process::CommandExt::process_group(
        Command::new("sleep").arg("1000").current_dir(&slot),
        0,
    )
    .spawn()
    .unwrap();
    std::fs::write(slots::pid_file(&slot), child.id().to_string()).unwrap();
    let _previews = Previews::new(
        home.path(),
        &PreviewNodeConfig::default(),
        Arc::new(|_| None),
        Arc::new(|| Box::pin(async { Err(std::io::Error::other("no tailnet")) })),
        Timing::default(),
    );
    let status = child.wait().unwrap();
    assert!(!status.success(), "it was killed");
    assert!(!slots::pid_file(&slot).exists());
}
