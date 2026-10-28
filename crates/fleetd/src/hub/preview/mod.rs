//! Try it yourself (W58, docs/design/try-it.md): previews a person asked for, kept in table `previews` (one row per
//! preview with it as JSON) so a restarted hub still knows what runs where, and the agents' suggestions to try a PR
//! (`preview_suggestions`, one per PR).
//!
//! Nothing starts on its own (D161): the person starts one (preview_start, tools.rs) or the lead does in a turn that
//! answers them (calls.rs); an agent only suggests one. The hub picks the machine ([`place`]): the project's own, when
//! its node lists `previews` and its role takes sessions. It sends `preview_run` there, and the node reports with
//! `preview_report` as the run moves ([`on_report`]). Every change is a `preview.state` event.
//!
//! A preview ends ([`end`]) when someone presses End, after the project's idle time without use, at the 4 hour cap,
//! when its PR merges or closes or its order closes, and when its machine goes offline ([`sweep`], every 30 s).
//!
//! The node answers `preview_run` at once and reports as the run moves. On each new link it reports again each
//! preview it still runs, and it answers a stop for a preview it doesn't know with an ended report. So the hub settles
//! what it can't account for with a stop: a report of a preview it doesn't hold, a report of one it ended, and a
//! running preview its node hasn't reported on its current link within [`SETTLE_MS`] (after a hub or node restart).
pub mod calls;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::node_link::{CAP_PREVIEWS, HubToNode};
use fleetd_contracts::preview::{
    PREVIEW_CAP_MIN, Preview, PreviewAsker, PreviewConfig, PreviewEndReason, PreviewEventData,
    PreviewHead, PreviewId, PreviewOf, PreviewReport, PreviewRunFrame, PreviewState,
    PreviewStopFrame, PreviewTarget,
};
use fleetd_contracts::prim::{Line, List, NonEmpty};
use fleetd_contracts::train::ChangeState;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::api::{Caller, Hub, ToolError, allows, clip, is_human, unknown_project};
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms, parse_ms};

/// How long the hub waits for a node to say it took a preview.
const RUN_WAIT: Duration = Duration::from_secs(15);
/// How often the hub looks for previews to end.
const SWEEP_EVERY: Duration = Duration::from_secs(30);
const MINUTE_MS: i64 = 60_000;
/// Previews previews_list reads per project.
pub const LIST_MAX: usize = 200;
/// How long a node's new link has to report again the previews it runs before the hub stops the rest.
pub const SETTLE_MS: i64 = 60_000;

/// Looks up the hub owner's tailnet login: [`read_owner_login`], or a stand-in in tests.
pub type OwnerLookup = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;

/// Which of its node's links each running preview was last heard of on, to settle the ones a node no longer has; and
/// the hub owner's tailnet login.
pub struct Previews {
    /// Each machine's link as the sweep first saw it: its number and when.
    links: Mutex<HashMap<MachineId, (u64, i64)>>,
    /// The link each preview was last heard of (or stopped) on.
    heard: Mutex<HashMap<PreviewId, u64>>,
    /// The hub owner's tailnet login once found. Held across a lookup, so a start that comes in meanwhile waits for it.
    owner: tokio::sync::Mutex<Option<String>>,
    lookup: Mutex<OwnerLookup>,
    /// When GitHub was last asked about each running preview's PR that the merge train doesn't track.
    asked: Mutex<HashMap<PreviewId, i64>>,
}

impl Default for Previews {
    fn default() -> Self {
        Self {
            links: Mutex::default(),
            heard: Mutex::default(),
            owner: tokio::sync::Mutex::default(),
            lookup: Mutex::new(Arc::new(|| Box::pin(read_owner_login()))),
            asked: Mutex::default(),
        }
    }
}

impl Previews {
    /// Replaces how the owner's login is looked up (tests).
    pub fn set_owner_lookup(&self, lookup: OwnerLookup) {
        *self.lookup.lock().unwrap() = lookup;
    }
}

/// How often GitHub is asked whether a PR the train doesn't track, with a preview running, merged or closed.
pub const UNTRACKED_EVERY_MS: i64 = 5 * 60_000;

/// How long GitHub gets to say whether an untracked PR merged or closed.
const GITHUB_WAIT: Duration = Duration::from_secs(10);
/// How often untracked PRs with a preview running are looked at.
const UNTRACKED_SWEEP_EVERY: Duration = Duration::from_secs(60);

pub fn new_id() -> PreviewId {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    PreviewId::unchecked(format!("P{hex}"))
}

// ---- the store ----

fn put_on(c: &Connection, p: &Preview) -> Result<(), StoreError> {
    let started_ms = parse_ms(p.started_at.as_str()).unwrap_or_default();
    c.execute(
        "INSERT INTO previews (preview_id, machine_id, project_id, runner_id, state, started_ms, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (preview_id) DO UPDATE SET state = excluded.state, data = excluded.data",
        params![
            p.preview_id.as_str(),
            p.project_ref.machine_id.as_str(),
            p.project_ref.project_id.as_str(),
            p.machine_id.as_str(),
            state_text(p.state),
            started_ms,
            serde_json::to_string(p)?
        ],
    )?;
    Ok(())
}

/// Writes a preview a report moved, only while it still runs: ended and failed are final, whatever a late report
/// says. False: it was over by then, and nothing changed.
pub fn put_running_on(c: &Connection, p: &Preview) -> Result<bool, StoreError> {
    let n = c.execute(
        "UPDATE previews SET state = ?2, data = ?3 WHERE preview_id = ?1 AND state IN ('starting', 'ready')",
        params![
            p.preview_id.as_str(),
            state_text(p.state),
            serde_json::to_string(p)?
        ],
    )?;
    Ok(n == 1)
}

/// Stores a new preview unless one of the same PR or order and target already runs in its project; that one is
/// returned instead. One write at a time, so two quick asks start one preview.
pub fn claim_on(c: &Connection, p: &Preview) -> Result<Option<Preview>, StoreError> {
    let running = rows(
        c,
        "SELECT data FROM previews WHERE machine_id = ?1 AND project_id = ?2 AND state IN ('starting', 'ready')",
        params![
            p.project_ref.machine_id.as_str(),
            p.project_ref.project_id.as_str()
        ],
    )?;
    if let Some(same) = running
        .into_iter()
        .find(|q| same_of(&q.of, &p.of) && q.target == p.target)
    {
        return Ok(Some(same));
    }
    put_on(c, p)?;
    Ok(None)
}

/// How long after a preview ends its held session may still upload and report itself closing: the node uploads the
/// recording once the session closes, after the end, and tries for as long as its uploads do.
pub const HELD_UPLOAD_MS: i64 = crate::node::browser::upload::GIVE_UP.as_millis() as i64;

/// Whether an ended preview's held browser session may still upload its recording and report itself closing: for
/// [`HELD_UPLOAD_MS`] after it ended.
pub fn uploads_after_end(p: &Preview, now: i64) -> bool {
    p.ended_at
        .as_ref()
        .and_then(|t| parse_ms(t.as_str()))
        .is_some_and(|ended| now - ended < HELD_UPLOAD_MS)
}

/// Whether two previews are of the same PR or order. GitHub's repo names ignore case: acme/Shop#14 is acme/shop#14.
pub fn same_of(a: &PreviewOf, b: &PreviewOf) -> bool {
    match (a, b) {
        (
            PreviewOf::Pr { repo, number },
            PreviewOf::Pr {
                repo: other,
                number: n,
            },
        ) => number == n && repo.as_str().eq_ignore_ascii_case(other.as_str()),
        (
            PreviewOf::Order { workstream_id },
            PreviewOf::Order {
                workstream_id: other,
            },
        ) => workstream_id == other,
        _ => false,
    }
}

fn state_text(state: PreviewState) -> &'static str {
    match state {
        PreviewState::Starting => "starting",
        PreviewState::Ready => "ready",
        PreviewState::Ended => "ended",
        PreviewState::Failed => "failed",
    }
}

fn rows(
    c: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<Preview>, StoreError> {
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map(args, |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str(&data?)?);
    }
    Ok(out)
}

pub fn get(hub: &Hub, id: &PreviewId) -> Result<Option<Preview>, StoreError> {
    hub.db.with(|c| {
        let data: Option<String> = c
            .query_row(
                "SELECT data FROM previews WHERE preview_id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match data {
            Some(data) => Some(serde_json::from_str(&data)?),
            None => None,
        })
    })
}

/// A project's previews: those still running first, then the newest that ended.
pub fn list(hub: &Hub, r: &ProjectRef) -> Result<Vec<Preview>, StoreError> {
    let mut all = hub.db.with(|c| {
        rows(
            c,
            "SELECT data FROM previews WHERE machine_id = ?1 AND project_id = ?2
             ORDER BY started_ms DESC LIMIT ?3",
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                LIST_MAX as i64
            ],
        )
    })?;
    all.sort_by_key(|p| p.state.is_over());
    Ok(all)
}

/// Every preview still starting or ready, on any machine.
pub fn running(hub: &Hub) -> Result<Vec<Preview>, StoreError> {
    hub.db.with(|c| {
        rows(
            c,
            "SELECT data FROM previews WHERE state IN ('starting', 'ready') ORDER BY started_ms ASC",
            [],
        )
    })
}

/// `preview.state`, which tells the app to read the project's previews again.
fn announce(hub: &Hub, p: &Preview) -> Result<(), StoreError> {
    let data = PreviewEventData {
        project_ref: p.project_ref.clone(),
        preview_id: p.preview_id.clone(),
        of: p.of.clone(),
        state: p.state,
    };
    hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::PreviewState,
        machine_id: Some(p.project_ref.machine_id.clone()),
        project_id: Some(p.project_ref.project_id.clone()),
        thread_id: None,
        summary: format!(
            "preview of {} on {}: {}",
            of_words(&p.of),
            p.machine_id,
            state_text(p.state)
        ),
        data: Some(serde_json::to_value(data)?),
        attention: None,
    })?;
    Ok(())
}

/// Saves a project's preview setting: a person's in Settings, or an agent's proposal they approved.
pub fn save_config(hub: &Hub, r: &ProjectRef, config: &PreviewConfig) -> Result<(), StoreError> {
    hub.db.project_settings().set_preview(r, config)
}

/// "#14", or "W12" for an order's PRs together.
pub fn of_words(of: &PreviewOf) -> String {
    match of {
        PreviewOf::Pr { number, .. } => format!("#{}", number.get()),
        PreviewOf::Order { workstream_id } => workstream_id.to_string(),
    }
}

fn now_ts(hub: &Hub) -> Timestamp {
    iso_ms(now_ms(hub.clock.as_ref())).into()
}

fn line<const MAX: usize>(text: &str) -> Line<1, MAX> {
    Line::new(clip(text, MAX)).unwrap_or_else(|_| Line::unchecked("-"))
}

// ---- who may ----

/// A key that may start previews on the machine: a person's, with admin or operate there (D162).
pub fn may_start(caller: &Caller, machine: &MachineId) -> bool {
    is_human(caller) && allows(caller, Role::Operate, Some(machine))
}

pub fn refuse_start(caller: &Caller, machine: &MachineId) -> Result<(), ToolError> {
    if may_start(caller, machine) {
        return Ok(());
    }
    let why = if is_human(caller) {
        format!(
            "This key can only open previews that run on {machine}: starting one takes admin or operate there."
        )
    } else {
        "Only a person starts a preview: an agent may suggest one with preview_suggest.".to_owned()
    };
    Err(ToolError::new(ErrorCode::Forbidden, why)
        .with_fix("Ask someone with an admin or operate key to start it, or open one that runs."))
}

// ---- starting ----

/// What a start asks for.
pub struct Ask {
    pub of: PreviewOf,
    pub target: PreviewTarget,
    pub asked_by: PreviewAsker,
}

/// Starts a preview of `ask.of` on the machine that can host it, or returns the one of it already running. Refused,
/// in plain words, when the project says no way to run it, the PR or order isn't the project's or has nothing open,
/// or no machine can host it.
pub async fn start(hub: &Hub, r: &ProjectRef, ask: Ask) -> Result<Preview, ToolError> {
    if hub.store.project_get(r)?.is_none() {
        return Err(unknown_project(r));
    }
    let config = crate::hub::projects::settings::preview_config(hub, r)?;
    let Some(config) = config.filter(|c| c.targets().contains(&ask.target)) else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "This project doesn't say how to run its {} preview yet.",
                ask.target.as_str()
            ),
        )
        .with_fix(
            "Set it in Settings › Projects › Try it (project_settings_set with preview), or ask the lead to have an \
             agent propose one.",
        ));
    };
    if let Some(same) = list(hub, r)?
        .into_iter()
        .find(|p| !p.state.is_over() && same_of(&p.of, &ask.of) && p.target == ask.target)
    {
        return Ok(same);
    }
    // Only the hub owner's own devices may open it; with no owner to name, it doesn't start at all.
    let owner_login = owner_login(hub).await.ok_or_else(|| {
        ToolError::new(
            ErrorCode::Failed,
            "fleetd can't tell whose tailnet this hub is on, so it can't keep a preview to your own devices.",
        )
        .with_fix(
            "Make sure Tailscale runs and is logged in on the hub's machine (or set FLEETD_TAILNET_OWNER for the \
             hub), then try again.",
        )
    })?;
    let Checkout {
        base,
        heads,
        order_id,
    } = heads(hub, r, &ask.of).await?;
    let runner = place(hub, r)?;
    let now = now_ms(hub.clock.as_ref());
    let mut preview = Preview {
        preview_id: new_id(),
        project_ref: r.clone(),
        of: ask.of,
        target: ask.target,
        machine_id: runner.clone(),
        state: PreviewState::Starting,
        asked_by: ask.asked_by,
        head: (heads.len() == 1).then(|| heads[0].sha.clone()),
        steps: List::unchecked(Vec::new()),
        url: None,
        session_id: None,
        started_at: iso_ms(now).into(),
        ready_at: None,
        ended_at: None,
        end_reason: None,
        idle_until: None,
        note: None,
    };
    // Another ask may have started it meanwhile (it read GitHub, as this one did): that one is the preview.
    if let Some(same) = hub.db.transaction(|c| claim_on(c, &preview))? {
        return Ok(same);
    }
    announce(hub, &preview)?;
    heard(hub, &runner, &preview.preview_id);
    let frame = PreviewRunFrame {
        id: NonEmpty::unchecked("-"),
        preview_id: preview.preview_id.clone(),
        project_id: r.project_id.clone(),
        target: preview.target,
        base,
        heads: List::unchecked(heads),
        web: config.web.clone(),
        idle_minutes: config.idle_minutes,
        order_id,
        owner_login: Some(owner_login),
    };
    let refused = match hub
        .node_commands
        .run_preview(&runner, &frame, RUN_WAIT)
        .await
    {
        Ok(answer) => answer.error.map(|e| e.message),
        Err(e) => {
            // No answer in time, or the link dropped: the node may have taken it all the same, so nothing of it may
            // keep running there.
            stop(hub, &runner, &preview.preview_id, PreviewEndReason::Lost);
            Some(e.message)
        }
    };
    if let Some(why) = refused {
        preview.state = PreviewState::Failed;
        preview.ended_at = Some(now_ts(hub));
        preview.note = Some(line(&format!("{runner} didn't start it: {why}")));
        finish(hub, preview)?;
        return Err(ToolError::new(
            ErrorCode::Failed,
            format!("{runner} didn't start the preview: {why}"),
        )
        .with_fix("Try again once the machine is back, or read previews_list for what it said."));
    }
    // The node may have reported already; its word wins.
    Ok(get(hub, &preview.preview_id)?.unwrap_or(preview))
}

/// The tailnet login whose devices may open previews: the hub owner's, kept once found. Until then each start looks
/// it up again, and a start that comes in while a lookup runs waits for that one. None: no one can say, and the
/// preview doesn't start.
pub async fn owner_login(hub: &Hub) -> Option<Line<1, 300>> {
    let mut owner = hub.previews.owner.lock().await;
    if owner.is_none() {
        let lookup = hub.previews.lookup.lock().unwrap().clone();
        *owner = lookup()
            .await
            .filter(|l| Line::<1, 300>::new(l.clone()).is_ok());
    }
    owner.as_ref().map(|l| Line::unchecked(l.clone()))
}

/// The hub machine's own `tailscale status --json` says whose it is; `FLEETD_TAILNET_OWNER` overrides it.
async fn read_owner_login() -> Option<String> {
    if let Ok(login) = std::env::var("FLEETD_TAILNET_OWNER") {
        return Some(login.trim().to_owned()).filter(|l| !l.is_empty());
    }
    let status = tokio::process::Command::new("tailscale")
        .args(["status", "--json"])
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(5), status).await {
        Ok(Ok(out)) if out.status.success() => {
            login_of_status(&String::from_utf8_lossy(&out.stdout))
        }
        _ => None,
    }
}

/// The login of the user who owns this machine, from `tailscale status --json`.
pub fn login_of_status(json: &str) -> Option<String> {
    let status: serde_json::Value = serde_json::from_str(json).ok()?;
    let user = status["Self"]["UserID"].as_i64()?;
    let login = status["User"][user.to_string()]["LoginName"].as_str()?;
    Some(login.to_owned()).filter(|l| !l.is_empty())
}

/// What the node checks out: one PR's head, or each unlanded PR of an order merged in turn onto their base.
struct Checkout {
    base: Option<Line<1, 255>>,
    heads: Vec<PreviewHead>,
    /// The order whose variables the preview gets: the order's own, or the order a PR belongs to.
    order_id: Option<WorkstreamId>,
}

async fn heads(hub: &Hub, r: &ProjectRef, of: &PreviewOf) -> Result<Checkout, ToolError> {
    match of {
        PreviewOf::Pr { repo, number } => {
            let n = number.get();
            if let Some(change) = hub.train.records().latest_for(repo.as_str(), n) {
                if &change.project_ref != r {
                    return Err(ToolError::new(
                        ErrorCode::NotFound,
                        format!("{repo}#{n} is another project's PR."),
                    ));
                }
                if matches!(change.state, ChangeState::Merged | ChangeState::Abandoned) {
                    return Err(ToolError::new(
                        ErrorCode::Invalid,
                        format!(
                            "#{n} is {}: there's nothing left to try.",
                            if change.state == ChangeState::Merged {
                                "merged"
                            } else {
                                "closed"
                            }
                        ),
                    ));
                }
                return Ok(Checkout {
                    base: None,
                    heads: vec![PreviewHead {
                        branch: line(change.branch.as_str()),
                        sha: Line::unchecked(change.head_sha.as_str()),
                    }],
                    order_id: Some(change.workstream_id),
                });
            }
            if crate::hub::prs::owner_of(hub, repo.as_str()).as_ref() != Some(r) {
                return Err(ToolError::new(
                    ErrorCode::NotFound,
                    format!("{repo} isn't a repo this project lands PRs on."),
                )
                .with_fix("Pick a PR from the project's PR list."));
            }
            // A PR fleetd never queued: GitHub says where its head is.
            let pull = hub
                .train
                .github()
                .pull(repo.as_str(), n)
                .await
                .map_err(|e| {
                    ToolError::new(
                        ErrorCode::Failed,
                        format!("GitHub didn't say where #{n}'s head is: {}", e.message),
                    )
                    .with_fix("Try again shortly.")
                })?;
            if pull.state != "open" {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!("#{n} is {}: there's nothing left to try.", pull.state),
                ));
            }
            if !head_in(&pull.head, repo.as_str()) {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!(
                        "#{n} comes from a fork, or from a repo that no longer exists, and a preview checks out \
                         branches of {repo} only."
                    ),
                ));
            }
            Ok(Checkout {
                base: None,
                heads: vec![PreviewHead {
                    branch: line(&pull.head.ref_),
                    sha: Line::new(pull.head.sha.clone())
                        .map_err(|e| ToolError::new(ErrorCode::Failed, e))?,
                }],
                order_id: None,
            })
        }
        PreviewOf::Order { workstream_id } => {
            let w = hub.leads.records.workstream_get(workstream_id)?;
            if w.as_ref().map(|w| &w.project_ref) != Some(r) {
                return Err(ToolError::new(
                    ErrorCode::NotFound,
                    format!("There is no order {workstream_id} in this project."),
                ));
            }
            let changes = hub.train.records().unlanded(r, workstream_id.as_str());
            if changes.is_empty() {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!("{workstream_id} has no open PR to try."),
                )
                .with_fix("Try it once its agents have opened a PR."));
            }
            let heads: Vec<PreviewHead> = changes
                .iter()
                .map(|c| PreviewHead {
                    branch: line(c.branch.as_str()),
                    sha: Line::unchecked(c.head_sha.as_str()),
                })
                .collect();
            if heads.len() == 1 {
                return Ok(Checkout {
                    base: None,
                    heads,
                    order_id: Some(workstream_id.clone()),
                });
            }
            // Several PRs are merged together onto their base, which only GitHub knows. They run as one app only
            // from one repo.
            let first = &changes[0];
            let mut repos: Vec<String> = changes.iter().map(|c| c.repo.to_lowercase()).collect();
            repos.sort();
            repos.dedup();
            if repos.len() > 1 {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!(
                        "{workstream_id}'s PRs are in {} repos ({}), so they can't run together as one app.",
                        repos.len(),
                        repos.join(", ")
                    ),
                )
                .with_fix("Try each of its PRs on its own."));
            }
            let pull = hub
                .train
                .github()
                .pull(first.repo.as_str(), first.pr_number.get())
                .await
                .map_err(|e| {
                    ToolError::new(
                        ErrorCode::Failed,
                        format!(
                            "GitHub didn't say which branch {workstream_id}'s PRs go into: {}",
                            e.message
                        ),
                    )
                    .with_fix("Try again shortly, or try one of its PRs on its own.")
                })?;
            Ok(Checkout {
                base: Some(line(&pull.base.ref_)),
                heads,
                order_id: Some(workstream_id.clone()),
            })
        }
    }
}

/// Whether a PR's head is a branch of `repo` itself. A fork's, or one whose repo GitHub no longer names (deleted), is
/// not: a preview runs the code it checks out on our machine.
pub fn head_in(head: &crate::hub::train::github::PullHead, repo: &str) -> bool {
    head.repo
        .as_ref()
        .is_some_and(|h| h.full_name.eq_ignore_ascii_case(repo))
}

/// The machine a preview of `r` runs on: the project's own, where its repo is checked out, when its node runs
/// previews and its role takes sessions. Refused in plain words otherwise.
pub fn place(hub: &Hub, r: &ProjectRef) -> Result<MachineId, ToolError> {
    let m = &r.machine_id;
    let name = hub
        .store
        .machine_get(m)?
        .map_or_else(|| m.to_string(), |machine| machine.name);
    let refuse = |why: String, fix: &str| {
        Err(ToolError::new(ErrorCode::Failed, why).with_fix(fix.to_owned()))
    };
    if !hub.node_commands.linked(m) {
        return refuse(
            format!("{name} is offline, and a preview of this project runs there."),
            "Try again once it is online.",
        );
    }
    if !hub.link.node_can(m, CAP_PREVIEWS) {
        return refuse(
            format!("{name}'s fleetd doesn't run previews yet."),
            "Update fleetd on it, then try again.",
        );
    }
    let roles = hub.db.with(|c| crate::hub::machine_roles::roles_on(c, m))?;
    if !roles.sessions {
        return refuse(
            format!(
                "{name} hosts no screens: its role is agents only, and a preview opens in one."
            ),
            "A hub admin turns Screens on for it in Settings › Hub › Machines; ask one if that isn't you.",
        );
    }
    Ok(m.clone())
}

// ---- moving and ending ----

/// A node's word on one of its previews. Only the machine it runs on reports it, and an ended or failed preview stays
/// as it ended.
pub fn on_report(hub: &Hub, machine: &MachineId, report: PreviewReport) {
    let result = (|| -> Result<(), StoreError> {
        let Some(p) = get(hub, &report.preview_id)? else {
            // One the hub doesn't hold (a row lost, or another hub's): its node throws it away.
            if !report.state.is_over() {
                stop(hub, machine, &report.preview_id, PreviewEndReason::Lost);
            }
            return Ok(());
        };
        if &p.machine_id != machine {
            tracing::warn!(preview = %p.preview_id, from = %machine, "preview report from another machine");
            return Ok(());
        }
        heard(hub, machine, &p.preview_id);
        if p.state.is_over() {
            // Ended here while its node was away: the node is told again.
            stop_again(hub, machine, &p, report.state);
            return Ok(());
        }
        apply(hub, machine, p, report)
    })();
    if let Err(e) = result {
        tracing::warn!(error = %e, "preview report not kept");
    }
}

/// An ended preview's node, still reporting it running, is told again to stop, with the reason it ended for.
fn stop_again(hub: &Hub, machine: &MachineId, ended: &Preview, reported: PreviewState) {
    if !reported.is_over() {
        let reason = ended.end_reason.unwrap_or(PreviewEndReason::Lost);
        stop(hub, machine, &ended.preview_id, reason);
    }
}

/// Moves `p`, as the hub read it, by its node's report. Written only while it still runs: if it ended since the
/// read, it stays as it ended.
pub fn apply(
    hub: &Hub,
    machine: &MachineId,
    mut p: Preview,
    report: PreviewReport,
) -> Result<(), StoreError> {
    let before = (p.state, p.steps.len(), p.url.clone(), p.session_id.clone());
    let now = now_ms(hub.clock.as_ref());
    p.state = report.state;
    if report.head.is_some() {
        p.head = report.head;
    }
    if !report.steps.is_empty() {
        p.steps = report.steps;
    }
    if report.url.is_some() {
        p.url = report.url;
    }
    if report.session_id.is_some() {
        p.session_id = report.session_id;
    }
    if report.note.is_some() {
        p.note = report.note;
    }
    if p.state == PreviewState::Ready && p.ready_at.is_none() {
        p.ready_at = Some(iso_ms(now).into());
    }
    if p.state.is_over() {
        p.ended_at = Some(iso_ms(now).into());
        p.idle_until = None;
        p.end_reason = report.end_reason.or(match p.state {
            PreviewState::Ended => Some(PreviewEndReason::Ended),
            _ => None,
        });
    } else if report.idle_until.is_some() {
        p.idle_until = report.idle_until;
    } else if p.state == PreviewState::Ready && p.idle_until.is_none() {
        p.idle_until = Some(iso_ms(now + idle_ms(hub, &p.project_ref)).into());
    }
    let after = (p.state, p.steps.len(), p.url.clone(), p.session_id.clone());
    let (ended_since, reported) = (report.end_reason.is_some(), report.state);
    if !hub.db.transaction(|c| put_running_on(c, &p))? {
        // It ended here after the read above: ended stays ended, and the node is told again why.
        if let Some(ended) = get(hub, &p.preview_id)? {
            stop_again(hub, machine, &ended, reported);
        }
        return Ok(());
    }
    // A "used" report only pushes idleUntil: the app needs no event for it.
    if before != after || ended_since {
        announce(hub, &p)?;
    }
    Ok(())
}

/// The project's idle time, in ms.
fn idle_ms(hub: &Hub, r: &ProjectRef) -> i64 {
    let minutes = crate::hub::projects::settings::preview_config(hub, r)
        .ok()
        .flatten()
        .map_or(fleetd_contracts::preview::PREVIEW_IDLE_DEFAULT_MIN, |c| {
            c.idle_minutes.get()
        });
    minutes * MINUTE_MS
}

/// Ends a preview: marked ended at once, and its node told to throw it away. One already over stays as it is.
pub fn end(
    hub: &Hub,
    p: Preview,
    reason: PreviewEndReason,
    note: Option<&str>,
) -> Result<Preview, StoreError> {
    Ok(end_now(hub, p, reason, note)?.0)
}

/// [`end`], and whether this call ended it (false: it was over already).
fn end_now(
    hub: &Hub,
    mut p: Preview,
    reason: PreviewEndReason,
    note: Option<&str>,
) -> Result<(Preview, bool), StoreError> {
    if p.state.is_over() {
        return Ok((p, false));
    }
    p.state = PreviewState::Ended;
    p.end_reason = Some(reason);
    p.ended_at = Some(now_ts(hub));
    p.idle_until = None;
    if let Some(note) = note {
        p.note = Some(line(note));
    }
    let (p, ended_here) = finish(hub, p)?;
    if ended_here && reason != PreviewEndReason::Lost {
        stop(hub, &p.machine_id, &p.preview_id, reason);
    }
    Ok((p, ended_here))
}

/// Writes a preview that is over now, and tells the app, unless it was over already: ended is final, and the stored
/// one stands. Returns what is stored, and whether this write ended it.
fn finish(hub: &Hub, p: Preview) -> Result<(Preview, bool), StoreError> {
    if hub.db.transaction(|c| put_running_on(c, &p))? {
        announce(hub, &p)?;
        return Ok((p, true));
    }
    let stored = get(hub, &p.preview_id)?.unwrap_or(p);
    Ok((stored, false))
}

/// `preview_stop` to a node that runs previews; nothing to one that doesn't, or isn't there.
fn stop(hub: &Hub, m: &MachineId, id: &PreviewId, reason: PreviewEndReason) {
    if hub.link.node_can(m, CAP_PREVIEWS) {
        let frame = HubToNode::PreviewStop(PreviewStopFrame {
            preview_id: id.clone(),
            reason,
        });
        let _ = hub.node_commands.send(m, frame);
    }
}

/// Notes that the machine's current link spoke of a preview (or was told to stop it).
fn heard(hub: &Hub, m: &MachineId, id: &PreviewId) {
    if let Some(link) = hub.node_commands.link_id(m) {
        hub.previews.heard.lock().unwrap().insert(id.clone(), link);
    }
}

/// A running preview its node hasn't reported on its current link, once that link has had [`SETTLE_MS`] to: its node
/// lost it (or never had it), and answers the stop with an ended report.
fn unaccounted(hub: &Hub, p: &Preview, now: i64) -> bool {
    let Some(link) = hub.node_commands.link_id(&p.machine_id) else {
        return false;
    };
    let since = {
        let mut links = hub.previews.links.lock().unwrap();
        let seen = links.entry(p.machine_id.clone()).or_insert((link, now));
        if seen.0 != link {
            *seen = (link, now);
        }
        seen.1
    };
    now - since >= SETTLE_MS && hub.previews.heard.lock().unwrap().get(&p.preview_id) != Some(&link)
}

/// Why a running preview should end now, if it should.
fn due(hub: &Hub, p: &Preview, now: i64) -> Option<(PreviewEndReason, String)> {
    let started = parse_ms(p.started_at.as_str()).unwrap_or(now);
    if now >= started + PREVIEW_CAP_MIN * MINUTE_MS {
        return Some((
            PreviewEndReason::Cap,
            format!(
                "ended after {} hours, the most a preview runs",
                PREVIEW_CAP_MIN / 60
            ),
        ));
    }
    if let Some(idle) = p.idle_until.as_ref().and_then(|t| parse_ms(t.as_str()))
        && now >= idle
    {
        return Some((
            PreviewEndReason::Idle,
            "ended after no one used it for the project's idle time".to_owned(),
        ));
    }
    match &p.of {
        PreviewOf::Pr { repo, number } => {
            let change = hub.train.records().latest_for(repo.as_str(), number.get());
            match change.map(|c| c.state) {
                Some(ChangeState::Merged) => {
                    return Some((PreviewEndReason::Done, format!("#{} merged", number.get())));
                }
                Some(ChangeState::Abandoned) => {
                    return Some((PreviewEndReason::Done, format!("#{} closed", number.get())));
                }
                _ => {}
            }
        }
        PreviewOf::Order { workstream_id } => {
            let closed = hub
                .leads
                .records
                .workstream_get(workstream_id)
                .ok()
                .flatten()
                .is_some_and(|w| crate::hub::leads::records::is_closed(w.state));
            if closed {
                return Some((PreviewEndReason::Done, format!("{workstream_id} closed")));
            }
        }
    }
    let offline = hub
        .store
        .machine_get(&p.machine_id)
        .ok()
        .flatten()
        .is_some_and(|m| m.status == MachineStatus::Offline);
    if offline {
        return Some((
            PreviewEndReason::Lost,
            format!("{} went offline", p.machine_id),
        ));
    }
    None
}

/// Ends every running preview that is due: idle, at the cap, its PR or order done, its machine gone. Returns how many
/// it ended.
pub fn sweep(hub: &Hub) -> Result<usize, StoreError> {
    let now = now_ms(hub.clock.as_ref());
    let mut ended = 0;
    let previews = running(hub)?;
    let live: HashSet<&PreviewId> = previews.iter().map(|p| &p.preview_id).collect();
    hub.previews
        .heard
        .lock()
        .unwrap()
        .retain(|id, _| live.contains(id));
    for p in &previews {
        if let Some((reason, note)) = due(hub, p, now) {
            if end_now(hub, p.clone(), reason, Some(&note))?.1 {
                ended += 1;
            }
        } else if unaccounted(hub, p, now) {
            tracing::info!(preview = %p.preview_id, machine = %p.machine_id, "preview not reported again: stopped");
            stop(hub, &p.machine_id, &p.preview_id, PreviewEndReason::Lost);
            heard(hub, &p.machine_id, &p.preview_id);
        }
    }
    Ok(ended)
}

/// The sweep every 30 s, until the hub stops.
pub async fn run_sweep(hub: Arc<Hub>) {
    loop {
        match sweep(&hub) {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "previews ended"),
            Err(e) => tracing::warn!(error = %e, "previews not swept"),
        }
        hub.clock.sleep(SWEEP_EVERY).await;
    }
}

/// Every [`UNTRACKED_SWEEP_EVERY`], apart from the sweep so a slow GitHub never holds it up: ends previews of PRs
/// the train doesn't track that merged or closed. Each GitHub read gets [`GITHUB_WAIT`].
pub async fn run_untracked(hub: Arc<Hub>) {
    loop {
        let github = |repo: String, n: i64| {
            let hub = hub.clone();
            async move {
                let read = hub.train.github().pull(&repo, n);
                let pull = tokio::time::timeout(GITHUB_WAIT, read).await.ok()?.ok()?;
                Some((pull.state, pull.merged || pull.merged_at.is_some()))
            }
        };
        match end_untracked(&hub, github).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "previews of untracked PRs ended"),
            Err(e) => tracing::warn!(error = %e, "previews of untracked PRs not checked"),
        }
        hub.clock.sleep(UNTRACKED_SWEEP_EVERY).await;
    }
}

/// Ends each running preview of a PR the merge train doesn't track (one fleetd never queued) once `pull` says it
/// merged or closed: its state (`open` or `closed`) and whether it merged, or none when GitHub didn't say. Each PR is
/// asked about at most every [`UNTRACKED_EVERY_MS`]. Returns how many it ended.
pub async fn end_untracked<F, Fut>(hub: &Hub, pull: F) -> Result<usize, StoreError>
where
    F: Fn(String, i64) -> Fut,
    Fut: std::future::Future<Output = Option<(String, bool)>>,
{
    let now = now_ms(hub.clock.as_ref());
    let previews = running(hub)?;
    {
        let live: HashSet<&PreviewId> = previews.iter().map(|p| &p.preview_id).collect();
        hub.previews
            .asked
            .lock()
            .unwrap()
            .retain(|id, _| live.contains(id));
    }
    let mut ended = 0;
    for p in previews {
        let PreviewOf::Pr { repo, number } = &p.of else {
            continue;
        };
        let n = number.get();
        if hub.train.records().latest_for(repo.as_str(), n).is_some() {
            continue;
        }
        {
            let mut asked = hub.previews.asked.lock().unwrap();
            if asked
                .get(&p.preview_id)
                .is_some_and(|at| now - at < UNTRACKED_EVERY_MS)
            {
                continue;
            }
            asked.insert(p.preview_id.clone(), now);
        }
        let note = match pull(repo.to_string(), n).await {
            Some((_, true)) => format!("#{n} merged"),
            Some((state, false)) if state != "open" => format!("#{n} closed"),
            _ => continue,
        };
        // Read again: it may have ended while GitHub answered.
        if let Some(p) = get(hub, &p.preview_id)?
            && end_now(hub, p, PreviewEndReason::Done, Some(&note))?.1
        {
            ended += 1;
        }
    }
    Ok(ended)
}

/// Takes the nodes' reports and registers the lead calls.
pub fn wire(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let reports: Arc<crate::hub::link::server::PreviewReports> =
        Arc::new(move |machine: &MachineId, report: PreviewReport| {
            if let Some(hub) = weak.upgrade() {
                on_report(&hub, machine, report);
            }
        });
    let _ = hub.link.preview_reports.set(reports);
    calls::register_lead_calls(hub);
}
