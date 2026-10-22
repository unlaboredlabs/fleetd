//! The doctor (M11): every setup check, live. Runs on demand (doctor_list with rerun) and from the sweep every 15
//! min; emits one doctor.changed per machine (and one for the hub) whose checks changed status since the last run.
//! Every fix is a command for a person to run; doctor_fix answers with it.
use super::checks::{self, CmdOutcome, DoctorCheck, Entry, HostProbe, MachineView, Probe};
use super::config::{HubConfig, MachineSetup, Platform, restart_command};
use crate::clock::Clock;
use crate::hub::usage::ports::{BoxFut, EventLog, NewEvent};
use crate::hub::usage::service::UsageStatus;
use crate::hub::usage::time::{clip, iso, system_ms};
use fleetd_contracts::node_link::NodeDisk;
use fleetd_contracts::sessions::RunnerInfo;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

pub const DOCTOR_EVERY_MS: i64 = 15 * 60_000;

/// A refusal in the tools' `{ code, message, fix }` shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DoctorRefused {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResults {
    pub checks: Vec<DoctorCheck>,
    pub checked_at: String,
}

/// What a node action answered (node-link `NodeActionResult`).
#[derive(Clone, Debug)]
pub struct ActionOutcome {
    pub message: String,
    pub probe: Option<HostProbe>,
}

/// A project's writer areas, for the doctor's areas check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectAreas {
    pub title: String,
    pub areas: Vec<String>,
    pub inferred: bool,
    /// Its policy file still has `defaults` (model, effort), which fleetd ignores.
    pub ignored_defaults: bool,
}

/// The hub services the checks read.
pub trait DoctorFleet: Send + Sync {
    fn machines(&self) -> BoxFut<'_, Vec<MachineView>>;
    /// Usage::status with the machine's UsageSource reading.
    fn usage(&self, machine_id: &str) -> BoxFut<'_, UsageStatus>;
    /// NodeCommands::run_action: `probe`; `Err` is the link's message.
    fn node_action(
        &self,
        machine_id: &str,
        action: &str,
    ) -> BoxFut<'_, Result<ActionOutcome, String>>;
    /// The node's runner (`runner_info` over the link): claude's version, login and conformance. `None` while the
    /// machine's node can't answer it; its claude checks then wait for it.
    fn runner_info(&self, machine_id: &str) -> BoxFut<'_, Option<RunnerInfo>>;
    /// The machine's projects whose checkout its node refuses to run commands in: `(path, why)`.
    fn refused_projects(&self, machine_id: &str) -> BoxFut<'_, Vec<(String, String)>>;
    /// Free space where the machine's worktrees live, as its node's heartbeat last reported it, and why the guard
    /// holds new agents there, if it does.
    fn guard(&self, _machine_id: &str) -> (Option<NodeDisk>, Option<String>) {
        (None, None)
    }
    /// Each of the machine's projects whose policy reads: its title, area names, and whether they were inferred.
    fn project_areas(&self, _machine_id: &str) -> BoxFut<'_, Vec<ProjectAreas>> {
        Box::pin(async { Vec::new() })
    }
}

pub struct DoctorDeps {
    /// Where the hub listens, for its own reachability check.
    pub listen_host: String,
    pub listen_port: u16,
    /// `<hub home>`, whose setup.json is read at each run.
    pub home: std::path::PathBuf,
    pub fleet: Arc<dyn DoctorFleet>,
    pub events: Arc<dyn EventLog>,
    pub clock: Arc<dyn Clock>,
}

/// A loopback URL for a listen address: a wildcard host is reached on loopback.
pub fn self_url(host: &str, port: u16) -> String {
    let host = match host {
        "0.0.0.0" | "" => "127.0.0.1",
        "::" => "::1",
        h => h,
    };
    if host.contains(':') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

fn machine_of(check_id: &str) -> Option<&str> {
    let scope = &check_id[..check_id.find('/').unwrap_or(0)];
    (scope != "hub").then_some(scope)
}

#[derive(Default)]
struct State {
    /// Latest entry per check id, hub checks first, then machines in id order.
    latest: Vec<Entry>,
    checked_at: Option<String>,
    last_run_ms: Option<i64>,
}

pub struct Doctor {
    deps: DoctorDeps,
    /// Held by every run and fix, so they never overlap.
    state: tokio::sync::Mutex<State>,
    http: reqwest::Client,
}

/// `<cmd> <args>` with a 30 s timeout and the given environment (`None`: inherited).
async fn run_cmd(cmd: &str, args: &[&str], env: Option<HashMap<String, String>>) -> CmdOutcome {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(env) = env {
        c.env_clear().envs(env);
    }
    match tokio::time::timeout(Duration::from_secs(30), c.output()).await {
        Err(_) => CmdOutcome::SpawnError(format!("{cmd} timed out after 30 s")),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            CmdOutcome::SpawnError("ENOENT".into())
        }
        Ok(Err(e)) => CmdOutcome::SpawnError(e.to_string()),
        Ok(Ok(out)) => CmdOutcome::Ran {
            exit_code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
    }
}

/// The hub's one-shot environment allowlist: the hub's own `CLAUDE*` variables never
/// reach the child, and without `CLAUDE_CONFIG_DIR` claude reads the user's login from `$HOME/.claude`.
pub fn router_env() -> HashMap<String, String> {
    let own: HashMap<String, String> = std::env::vars().collect();
    crate::hub::intake::oneshot::one_shot_env(&own)
        .into_iter()
        .collect()
}

impl Doctor {
    pub fn new(deps: DoctorDeps) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .expect("http client");
        Arc::new(Doctor {
            deps,
            state: tokio::sync::Mutex::new(State::default()),
            http,
        })
    }

    fn now_ms(&self) -> i64 {
        system_ms(self.deps.clock.now())
    }

    fn config(&self) -> (HubConfig, Option<String>) {
        super::config::read_hub_config(&self.deps.home)
    }

    /// GET `<url>/healthz`: a refused connection, a timeout and a non-2xx answer all fail.
    async fn health(&self, url: &str) -> Probe {
        match self.http.get(format!("{url}/healthz")).send().await {
            Ok(r) if r.status().is_success() => Probe::Ok,
            Ok(r) => Probe::Failed(format!("HTTP {}", r.status().as_u16())),
            Err(e) if e.is_timeout() => Probe::Failed("TimeoutError".into()),
            Err(e) if e.is_connect() => Probe::Failed("ECONNREFUSED".into()),
            Err(_) => Probe::Failed("error".into()),
        }
    }

    async fn hub_checks(&self) -> Vec<Entry> {
        let (config, problem) = self.config();
        let own = self_url(&self.deps.listen_host, self.deps.listen_port);
        let public = config
            .url
            .clone()
            .filter(|u| u.starts_with("https://") && problem.is_none());
        let env: Vec<(String, String)> = router_env().into_iter().collect();
        let (reachable, gh, claude, runner, https) = tokio::join!(
            self.health(&own),
            run_cmd("gh", &["auth", "status"], None),
            run_cmd("claude", &["auth", "status", "--json"], Some(router_env())),
            crate::node::runner::conformance::probe(std::path::Path::new("claude"), &env),
            async {
                match &public {
                    Some(u) => Some(self.health(u.trim_end_matches('/')).await),
                    None => None,
                }
            }
        );
        let hub_setup = MachineSetup {
            ssh_host: String::new(),
            local: true,
            platform: if cfg!(target_os = "macos") {
                Platform::Darwin
            } else {
                Platform::Linux
            },
            uid: current_uid(),
            unit_suffix: config.unit_suffix.clone().unwrap_or_default(),
        };
        vec![
            checks::hub_reachable(
                &format!("{own}/healthz"),
                &reachable,
                restart_command("hub", Some(&hub_setup)),
            ),
            checks::gh_auth(&gh),
            checks::hub_claude_login(&claude, runner.proxy.as_deref()),
            checks::hub_claude_version(&runner),
            checks::https_reachable(
                &config,
                problem.as_deref(),
                self.deps.listen_port,
                https.as_ref(),
            ),
        ]
    }

    async fn machine_checks(&self, machine: &MachineView) -> Vec<Entry> {
        let id = machine.machine_id.as_str();
        let (config, _) = self.config();
        let setup = config.machines.get(id);
        let fleet = &self.deps.fleet;
        let online = machine.status != "offline";
        let (runner, usage, probe, refused) = tokio::join!(
            async {
                if online {
                    fleet.runner_info(id).await
                } else {
                    None
                }
            },
            fleet.usage(id),
            async {
                if !online {
                    return Err(format!("{id} is offline."));
                }
                match fleet.node_action(id, "probe").await {
                    Ok(ActionOutcome { probe: Some(p), .. }) => Ok(p),
                    Ok(outcome) => Err(format!("{id}'s node did not probe: {}", outcome.message)),
                    Err(e) => Err(e),
                }
            },
            async {
                if online {
                    Some(fleet.refused_projects(id).await)
                } else {
                    None
                }
            }
        );
        let areas = if online {
            fleet.project_areas(id).await
        } else {
            Vec::new()
        };
        let mut out = vec![checks::machine_online(machine, setup, runner.as_ref())];
        if let Some(info) = &runner {
            out.extend(checks::runner_checks(id, info));
        }
        out.push(checks::commit_identity(
            id,
            probe.as_ref().map_err(String::as_str),
            &config,
        ));
        let (disk, paused) = fleet.guard(id);
        out.push(checks::disk_space(
            id,
            !online,
            disk.as_ref(),
            paused.as_deref(),
        ));
        out.push(checks::idle_sleep(
            id,
            probe.as_ref().map_err(String::as_str),
            machine.last_slept.as_ref(),
            self.now_ms(),
        ));
        out.push(checks::usage_breaker(id, &usage.breaker));
        if let Some(refused) = refused {
            out.push(checks::cmd_roots(id, &refused));
        }
        if !areas.is_empty() {
            out.push(checks::areas(id, &areas));
        }
        out
    }

    /// Changed statuses per machine ("hub" for hub checks); new checks count only after the first run.
    async fn emit_changes(&self, before: &HashMap<String, Entry>, after: &[Entry], baseline: bool) {
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for Entry { check, .. } in after {
            let from = before.get(&check.id).map(|e| e.check.status);
            if from == Some(check.status)
                || (from.is_none() && (baseline || check.status == checks::DoctorStatus::Ok))
            {
                continue;
            }
            let key = check.machine_id.clone().unwrap_or_else(|| "hub".into());
            if !groups.contains_key(&key) {
                order.push(key.clone());
            }
            let mut change = json!({ "id": check.id, "to": check.status });
            if let Some(f) = from {
                change["from"] = json!(f);
            }
            groups.entry(key).or_default().push(change);
        }
        let at = iso(self.now_ms());
        for key in order {
            let changes = &groups[&key];
            let text: Vec<String> = changes
                .iter()
                .map(|c| {
                    format!(
                        "{} {} → {}",
                        c["id"].as_str().unwrap_or(""),
                        c["from"].as_str().unwrap_or("new"),
                        c["to"].as_str().unwrap_or("")
                    )
                })
                .collect();
            self.deps
                .events
                .append(NewEvent {
                    at: at.clone(),
                    kind: "doctor.changed".into(),
                    machine_id: (key != "hub").then(|| key.clone()),
                    summary: clip(&format!("doctor: {}", text.join(", ")), 200),
                    data: Some(json!({ "changes": &changes[..changes.len().min(20)] })),
                    ..Default::default()
                })
                .await;
        }
    }

    /// Replaces the entries of the groups just run (all of them when `machine_ids` is `None`) and emits changes.
    async fn record(&self, state: &mut State, fresh: Vec<Entry>, machine_ids: Option<&[String]>) {
        let before: HashMap<String, Entry> = state
            .latest
            .iter()
            .map(|e| (e.check.id.clone(), e.clone()))
            .collect();
        let replaced = |e: &Entry| match machine_ids {
            None => true,
            Some(ids) => {
                e.check.scope != "hub" && ids.iter().any(|m| Some(m) == e.check.machine_id.as_ref())
            }
        };
        let mut merged: Vec<Entry> = state
            .latest
            .iter()
            .filter(|e| !replaced(e))
            .cloned()
            .collect();
        merged.extend(fresh.iter().cloned());
        let (mut hub, mut machines): (Vec<Entry>, Vec<Entry>) =
            merged.into_iter().partition(|e| e.check.scope == "hub");
        machines.sort_by(|a, b| a.check.machine_id.cmp(&b.check.machine_id));
        hub.append(&mut machines);
        state.latest = hub;
        self.emit_changes(&before, &fresh, state.checked_at.is_none())
            .await;
        state.checked_at = Some(iso(self.now_ms()));
    }

    async fn run_all(&self, state: &mut State) {
        let machines = self.deps.fleet.machines().await;
        let hub = self.hub_checks();
        let per_machine = async {
            let mut out = Vec::new();
            // At most 8 machines at once.
            for chunk in machines.chunks(8) {
                for entries in futures_join_all(chunk.iter().map(|m| self.machine_checks(m))).await
                {
                    out.extend(entries);
                }
            }
            out
        };
        let (mut fresh, per_machine) = tokio::join!(hub, per_machine);
        fresh.extend(per_machine);
        self.record(state, fresh, None).await;
        state.last_run_ms = Some(self.now_ms());
    }

    /// The latest results; runs every check first when `rerun` is set or nothing has run yet.
    pub async fn list(&self, rerun: bool) -> DoctorResults {
        let mut state = self.state.lock().await;
        if rerun || state.checked_at.is_none() {
            self.run_all(&mut state).await;
        }
        DoctorResults {
            checks: state.latest.iter().map(|e| e.check.clone()).collect(),
            checked_at: state.checked_at.clone().unwrap_or_else(|| iso(0)),
        }
    }

    /// The sweep's hook: runs every check when the last run is 15 min old.
    pub async fn run_if_due(&self) {
        let mut state = self.state.lock().await;
        let now = self.now_ms();
        if state
            .last_run_ms
            .is_none_or(|last| now - last >= DOCTOR_EVERY_MS)
        {
            self.run_all(&mut state).await;
        }
    }

    fn refused(message: String, fix: Option<String>) -> DoctorRefused {
        DoctorRefused {
            code: "invalid",
            message,
            fix,
        }
    }

    /// Re-runs a check and answers with the command that fixes it: every fix needs a person.
    pub async fn fix(&self, check_id: &str) -> Result<(String, DoctorCheck), DoctorRefused> {
        let _state = self.state.lock().await;
        let machine_id = machine_of(check_id).map(str::to_string);
        let machines = self.deps.fleet.machines().await;
        let machine = machines
            .iter()
            .find(|m| Some(&m.machine_id) == machine_id.as_ref())
            .cloned();
        let list_fix = || Some("Call doctor_list for the current checks.".to_string());
        if let (Some(id), None) = (&machine_id, &machine) {
            return Err(Self::refused(format!("No machine {id}."), list_fix()));
        }
        let now = match &machine {
            None => self.hub_checks().await,
            Some(m) => self.machine_checks(m).await,
        };
        let Some(entry) = now.into_iter().find(|e| e.check.id == check_id) else {
            return Err(Self::refused(
                format!("No doctor check {check_id}."),
                list_fix(),
            ));
        };
        Err(match &entry.check.fix {
            None => Self::refused(
                format!(
                    "{check_id} has nothing to fix ({}).",
                    entry.check.status.as_str()
                ),
                None,
            ),
            Some(f) => Self::refused(
                format!("{check_id} needs a person: {}.", f.label),
                f.command.clone(),
            ),
        })
    }
}

/// Runs the futures concurrently and returns their outputs in order.
async fn futures_join_all<F: std::future::Future>(
    futures: impl Iterator<Item = F>,
) -> Vec<F::Output> {
    let mut set = Vec::new();
    for f in futures {
        set.push(Box::pin(f));
    }
    let mut out = Vec::with_capacity(set.len());
    // Polled together: each machine's checks wait on the network, not on each other.
    let mut pending: Vec<Option<F::Output>> = (0..set.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (i, f) in set.iter_mut().enumerate() {
            if pending[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => pending[i] = Some(v),
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    for v in pending {
        out.extend(v);
    }
    out
}

fn current_uid() -> u32 {
    // No libc call without unsafe: the owner of the hub user's home directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(crate::cli::home_dir())
            .map(|m| m.uid())
            .unwrap_or(0)
    }
    #[cfg(not(unix))]
    {
        0
    }
}
