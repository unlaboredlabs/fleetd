//! The watcher of a restart onto a new build. Whoever put the new binary in place writes a [`Plan`] and starts
//! `fleetd update-finish <plan>` from the binary it replaced (kept at `plan.prev`), outside the service it restarts
//! ([`super::service::spawn_outside`]), so the watcher works whatever the new build does and outlives the restart. It
//! restarts the service, waits for it to come up healthy on the new build, and if it doesn't, puts the previous binary
//! back and restarts that. Its [`Verdict`] goes to `plan.verdict`, where the hub reads it.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::mcp::{UpdateStage, UpdateState};
use serde::{Deserialize, Serialize};

use super::BoxFuture;
use super::service::{self, Service};

/// How long a restarted hub or node gets to come up healthy before the previous build goes back.
pub const HEALTH_WAIT_SECS: u64 = 90;
const POLL: Duration = Duration::from_secs(1);
/// Before the restart: the service answers whoever asked for the update first (a node its hub, the hub its run).
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// The installed binary the service runs, now the new build.
    pub exe: PathBuf,
    /// The binary it replaced.
    pub prev: PathBuf,
    pub service: Service,
    pub from: String,
    pub to: String,
    pub health: Health,
    pub wait_secs: u64,
    /// Where the verdict goes.
    pub verdict: PathBuf,
}

/// How the watcher tells the restarted service came up on a version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Health {
    /// A hub: `GET <url>/healthz` answers with its version.
    Hub { url: String },
    /// A node: it writes its version to `up` once its hub welcomed it ([`mark_up`]).
    Node { up: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// `done`, `rolled_back`, or `failed` when the service couldn't be restarted or even the previous build couldn't
    /// be put back.
    pub state: UpdateState,
    pub stage: Option<UpdateStage>,
    pub message: String,
}

/// What the watcher does to the world; tests stand in a fake runner.
pub trait Ports: Sync {
    fn restart(&self, service: &Service) -> Result<(), String>;
    /// The service answers on `version` now, and did so after `since_ms`.
    fn healthy<'a>(
        &'a self,
        health: &'a Health,
        version: &'a str,
        since_ms: i64,
    ) -> BoxFuture<'a, bool>;
    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()>;
    fn now_ms(&self) -> i64;
}

/// Restarts onto `plan.to`, or back onto `plan.from` when it doesn't come up; a restart the service manager refuses
/// only puts the previous binary back.
pub async fn finish(plan: &Plan, ports: &dyn Ports) -> Verdict {
    let to = crate::version_shown(&plan.to);
    let from = crate::version_shown(&plan.from);
    ports.sleep(SETTLE).await;
    let started = ports.now_ms();
    if let Err(e) = ports.restart(&plan.service) {
        // The service manager refused: nothing restarted and the service runs what it ran, so only the binary at the
        // path goes back. Were the service down, its manager (`Restart=always`, `KeepAlive`) starts that one.
        return Verdict {
            state: UpdateState::Failed,
            stage: Some(UpdateStage::Restart),
            message: match super::restore(&plan.exe, &plan.prev) {
                Ok(()) => format!(
                    "{e}, so it never restarted onto {to} and still runs {from}; its previous binary was put back"
                ),
                Err(back) => format!(
                    "{e}, so it never restarted onto {to} and still runs {from}, but its previous binary couldn't be \
                     put back ({back}): run `fleetd update` on that machine"
                ),
            },
        };
    }
    if up(plan, ports, &plan.to, started).await {
        return Verdict {
            state: UpdateState::Done,
            stage: None,
            message: format!("runs {to}"),
        };
    }
    let why = format!("{to} didn't come up healthy within {} s", plan.wait_secs);
    if let Err(e) = super::restore(&plan.exe, &plan.prev) {
        return Verdict {
            state: UpdateState::Failed,
            stage: Some(UpdateStage::Health),
            message: format!(
                "{why}, and putting {from} back failed ({e}): run `fleetd update` on that machine"
            ),
        };
    }
    let again = ports.now_ms();
    let back = ports.restart(&plan.service).is_ok() && up(plan, ports, &plan.from, again).await;
    Verdict {
        state: UpdateState::RolledBack,
        stage: Some(UpdateStage::Health),
        message: if back {
            format!("{why}, so {from} was put back and runs again")
        } else {
            format!(
                "{why}, so {from} was put back, but it didn't come up either: check the {} service",
                plan.service.name
            )
        },
    }
}

async fn up(plan: &Plan, ports: &dyn Ports, version: &str, since_ms: i64) -> bool {
    let deadline = since_ms + i64::try_from(plan.wait_secs).unwrap_or(i64::MAX / 1000) * 1000;
    loop {
        if ports.healthy(&plan.health, version, since_ms).await {
            return true;
        }
        if ports.now_ms() >= deadline {
            return false;
        }
        ports.sleep(POLL).await;
    }
}

/// `<node home>/update/up`: the node's version once its hub welcomed it, for the watcher of its restart.
pub fn up_path(node_home: &Path) -> PathBuf {
    node_home.join("update").join("up")
}

/// Called by the node on every welcome; a failure only costs a needless rollback, so it is logged.
pub fn mark_up(node_home: &Path, version: &str) {
    let path = up_path(node_home);
    let wrote = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| super::replace_file(&path, version.as_bytes()));
    if let Err(e) = wrote {
        tracing::warn!("couldn't write {}: {e}", path.display());
    }
}

pub fn read_verdict(path: &Path) -> Option<Verdict> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Writes `plan` beside its verdict and starts the watcher from `plan.prev`, outside the service.
pub fn start(plan: &Plan, plan_path: &Path) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?;
    if let Some(dir) = plan_path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(&plan.verdict);
    super::replace_file(plan_path, &json).map_err(|e| e.to_string())?;
    service::spawn_outside(&plan.prev, &["update-finish", &plan_path.to_string_lossy()])
}

/// The real world: the service manager, `/healthz` and the node's up file.
pub struct RealPorts {
    http: reqwest::Client,
}

impl Default for RealPorts {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Ports for RealPorts {
    fn restart(&self, service: &Service) -> Result<(), String> {
        service::restart(service)
    }

    fn healthy<'a>(
        &'a self,
        health: &'a Health,
        version: &'a str,
        since_ms: i64,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match health {
                Health::Hub { url } => {
                    let Ok(response) = self.http.get(format!("{url}/healthz")).send().await else {
                        return false;
                    };
                    let body: serde_json::Value = response.json().await.unwrap_or_default();
                    body.get("version").and_then(|v| v.as_str()) == Some(version)
                }
                Health::Node { up } => {
                    let fresh = fs::metadata(up)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .is_some_and(|t| i64::try_from(t.as_millis()).unwrap_or(0) >= since_ms);
                    fresh && fs::read_to_string(up).is_ok_and(|v| v.trim() == version)
                }
            }
        })
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(duration))
    }

    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0)
    }
}

/// `fleetd update-finish <plan>`: the watcher itself. Its verdict is its output; the exit code is 0 unless the plan
/// can't be read.
pub fn run(plan_path: &Path) -> std::process::ExitCode {
    let plan: Plan = match fs::read(plan_path)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
    {
        Ok(plan) => plan,
        Err(e) => {
            eprintln!("fleetd update-finish: {}: {e}", plan_path.display());
            return std::process::ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("fleetd update-finish: {e}");
            return std::process::ExitCode::from(1);
        }
    };
    let verdict = runtime.block_on(finish(&plan, &RealPorts::default()));
    println!("{}", verdict.message);
    match serde_json::to_vec_pretty(&verdict) {
        Ok(json) => {
            if let Err(e) = super::replace_file(&plan.verdict, &json) {
                eprintln!("fleetd update-finish: {}: {e}", plan.verdict.display());
            }
        }
        Err(e) => eprintln!("fleetd update-finish: {e}"),
    }
    std::process::ExitCode::SUCCESS
}
