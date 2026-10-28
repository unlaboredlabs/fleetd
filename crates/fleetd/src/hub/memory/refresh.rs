//! The nightly memory refresh: once a night, at `policy.memory_refresh_at` (04:00 by default) in the person's zone
//! (`policy.tz`, else the hub machine's), each project with the refresh on (`project_settings.memory_refresh`) and chat
//! or order activity since its last run gets a fresh lead session of its own. It reads the chat since the last run, the
//! decisions and the memory. It may use `memory_read`, `remember` and `forget` and nothing else ([`allowed_tools`]): it
//! starts with none of the runtime's own tools and none of the person's MCP servers, its node refuses any other tool
//! (so it starts only on a node that lists `CAP_ALLOWED_ONLY`), and the hub takes only those calls from it
//! (`tasks::policy`): project memory freely, user memory add only, and only to the person whose chat it read ([`you`]):
//! a Navi's owner, else the one person who wrote in it; with several, user memory is left alone. It opens no order, and
//! its replies reach no chat: only the lead's own thread is mirrored there. Its changes are kept here as it makes them
//! and posted at its end as one "Memory refreshed: +a ~b −c" line with Undo; a night that changed nothing posts
//! nothing. A session that fails, or still runs after [`RUN_LIMIT_MS`], is stopped. The Automations page lists it as a
//! built-in row ([`job`]), whose Run now starts one at once ([`run_now`]) held by the same rules.
use std::sync::Arc;
use std::time::Duration;

use chrono::{Days, NaiveTime, TimeZone};
use chrono_tz::Tz;
use fleetd_contracts::automations::{
    AutomationRunState, AutomationTrigger, MemoryRefreshJob, MemoryRefreshRun,
};
use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::effort::TaskProfile;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Decision, LeadState};
use fleetd_contracts::mcp_servers::{McpAgentRole, McpSessionConfig};
use fleetd_contracts::memory::{MemoryRefreshed, REFRESHED_LISTED, RememberedItem};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::node_link::CAP_ALLOWED_ONLY;
use fleetd_contracts::prim::{Count, Line, List};
use fleetd_contracts::sessions::SessionRole;
use rusqlite::{OptionalExtension, params};
use serde_json::json;

use super::{Target, You};
use crate::hub::api::Hub;
use crate::hub::chat::NewMessage;
use crate::hub::claude_accounts::{Whose, whose_for_lead};
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::leads::digest::clip;
use crate::hub::leads::hooks::BoxFuture;
use crate::hub::ledger::{Chain, DecisionFilter};
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

/// The global decision that moves the night's hour: "HH:MM" in the person's zone.
pub const AT_KEY: &str = "policy.memory_refresh_at";
pub const DEFAULT_AT: &str = "04:00";
/// The night's refresh starts within this long after its hour, or not that night: a hub that was down at 04:00
/// doesn't refresh at noon.
const WINDOW_MS: i64 = 3 * 3_600_000;
/// A refresh session still going after this long is stopped, and finished as it stands.
pub const RUN_LIMIT_MS: i64 = 3_600_000;
const TICK: Duration = Duration::from_secs(60);
/// The longest a zone's clocks have jumped forward at once, with room to spare.
const GAP_MINUTES: i64 = 180;
/// The chat a refresh reads: newest kept, each message cut.
const CHAT_CHARS: usize = 40_000;
const MESSAGE_CHARS: usize = 2_000;
const CHAT_ROWS: usize = 2_000;
const DECISIONS: usize = 200;
const END_EVENTS: [HubEventType; 4] = [
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadUsageLimited,
];

/// The tools a refresh session may use, and nothing else: fleetd's memory calls, the ones the hub takes from it
/// (`tasks::policy::MEMORY_REFRESH_OPS`). No runtime tool of its own (no shell, files, web or skills), no other
/// fleetd tool, no MCP server's: claude asks for any of those, and the node refuses.
pub fn allowed_tools() -> Vec<String> {
    crate::hub::tasks::policy::MEMORY_REFRESH_OPS
        .iter()
        .map(|op| format!("mcp__{}__{op}", crate::cli::agent_mcp::SERVER_NAME))
        .collect()
}

/// How a refresh session starts: the lead's fleetd tools (which the hub holds to the memory ones), only
/// [`allowed_tools`] of them usable, and fleetd's MCP server alone: none a person gave the leads or set up in their
/// claude.
pub fn launch_options() -> LaunchOptions {
    LaunchOptions {
        role: SessionRole::Lead,
        mcp_role: Some(McpAgentRole::Lead),
        mcp: Some(McpSessionConfig {
            user_servers: false,
            servers: Vec::new(),
        }),
        only_tools: Some(allowed_tools()),
        ..Default::default()
    }
}

/// Starts and stops refresh sessions on the project's machine; the hub's executors, or a test's.
pub trait Launcher: Send + Sync {
    fn launch(
        &self,
        machine_id: &MachineId,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<ThreadId, String>>;
    /// Ends the session's process, as a task's stop does.
    fn stop(&self, thread: &ThreadRef) -> BoxFuture<Result<(), String>>;
}

struct Executors(Arc<crate::hub::executor::Executors>);

impl Launcher for Executors {
    fn launch(
        &self,
        machine_id: &MachineId,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<ThreadId, String>> {
        let executors = Arc::clone(&self.0);
        let machine_id = machine_id.clone();
        Box::pin(async move {
            executors
                .launch(&machine_id, &input, options)
                .await
                .map(|(thread_id, _)| thread_id)
                .map_err(|e| e.to_string())
        })
    }

    fn stop(&self, thread: &ThreadRef) -> BoxFuture<Result<(), String>> {
        let executors = Arc::clone(&self.0);
        let thread = thread.clone();
        Box::pin(async move {
            executors
                .stop(&thread, false)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

/// The hub's executors, which start refresh sessions on the project's machine.
pub fn executors(hub: &Hub) -> impl Launcher + use<> {
    Executors(Arc::clone(&hub.executors))
}

/// The refresh's loop: one pass a minute, until the hub stops.
pub async fn run(hub: Arc<Hub>) {
    let launcher = executors(&hub);
    loop {
        if let Err(error) = tick(&hub, &launcher).await {
            tracing::warn!(%error, "memory refresh: pass failed");
        }
        hub.clock.sleep(TICK).await;
    }
}

/// One project's refresh state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    /// The last chat `seq` a finished refresh read.
    pub watermark: i64,
    /// The night (its hour, epoch ms) last refreshed, skipped as quiet, or tried.
    pub night_ms: Option<i64>,
    /// The refresh session running now.
    pub thread_id: Option<ThreadId>,
    pub started_ms: Option<i64>,
    /// The chat `seq` the running refresh read up to.
    pub read_to: Option<i64>,
    /// What the running refresh changed so far.
    pub items: Vec<RememberedItem>,
    /// The night last skipped for a node too old to run it, whose line is in the chat.
    pub skipped_ms: Option<i64>,
    /// How the last refresh went, or the running one started.
    pub last_run: Option<MemoryRefreshRun>,
}

fn get(db: &HubDb, r: &ProjectRef) -> Result<Run, StoreError> {
    let row = db.with(|c| {
        Ok(c.query_row(
            "SELECT watermark, night_ms, thread_id, started_ms, read_to, items, skipped_ms, last_run FROM memory_refreshes
             WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?)
    })?;
    let Some((watermark, night_ms, thread_id, started_ms, read_to, items, skipped_ms, last_run)) =
        row
    else {
        return Ok(Run::default());
    };
    Ok(Run {
        watermark,
        night_ms,
        thread_id: thread_id.map(ThreadId::unchecked),
        started_ms,
        read_to,
        items: serde_json::from_str(&items).unwrap_or_default(),
        skipped_ms,
        last_run: last_run.and_then(|l| serde_json::from_str(&l).ok()),
    })
}

fn put(db: &HubDb, r: &ProjectRef, run: &Run) -> Result<(), StoreError> {
    let items = serde_json::to_string(&run.items)?;
    let last_run = run
        .last_run
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    db.with(|c| {
        c.execute(
            "INSERT INTO memory_refreshes (machine_id, project_id, watermark, night_ms, thread_id, started_ms, read_to, items,
               skipped_ms, last_run)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (machine_id, project_id) DO UPDATE SET watermark = excluded.watermark,
               night_ms = excluded.night_ms, thread_id = excluded.thread_id, started_ms = excluded.started_ms,
               read_to = excluded.read_to, items = excluded.items, skipped_ms = excluded.skipped_ms,
               last_run = excluded.last_run",
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                run.watermark,
                run.night_ms,
                run.thread_id.as_ref().map(|t| t.as_str()),
                run.started_ms,
                run.read_to,
                items,
                run.skipped_ms,
                last_run
            ],
        )?;
        Ok(())
    })
}

/// The project whose running refresh is in `thread`: its calls are held to the memory ones.
pub fn project_of_thread(db: &HubDb, thread: &ThreadRef) -> Result<Option<ProjectRef>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT project_id FROM memory_refreshes WHERE machine_id = ? AND thread_id = ?",
            params![thread.machine_id.as_str(), thread.thread_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
    })
    .map(|id| {
        id.map(|id| ProjectRef {
            machine_id: thread.machine_id.clone(),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(id),
        })
    })
}

/// Whose user memory the running refresh of `r` adds to: a Navi's owner's, else that of the one person who wrote in
/// the chat it read. Nobody's when several did.
pub fn you(db: &HubDb, r: &ProjectRef) -> Result<You, StoreError> {
    let run = get(db, r)?;
    you_over(db, r, run.watermark, run.read_to.unwrap_or(i64::MAX))
}

/// [`you`] over the chat after `watermark`, up to `read_to`.
fn you_over(db: &HubDb, r: &ProjectRef, watermark: i64, read_to: i64) -> Result<You, StoreError> {
    let setup = db.claude_accounts().setup()?;
    if let Whose::Person(owner) = whose_for_lead(db, &setup, r)? {
        return You::of(db, Some(&owner));
    }
    let ids: Vec<String> = db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT DISTINCT json_extract(data, '$.person.personId') FROM chat_messages
             WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND seq <= ?4 AND held = 0
               AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.person') IS NOT NULL",
        )?;
        let ids = stmt
            .query_map(
                params![r.machine_id.as_str(), r.project_id.as_str(), watermark, read_to],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    })?;
    match &ids[..] {
        [] => You::of(db, None),
        [one] => You::of(
            db,
            Some(&fleetd_contracts::people::PersonId::unchecked(one)),
        ),
        _ => Ok(You::Nobody),
    }
}

/// Keeps what the running refresh of project `r` just changed, for its line at the end. One statement, so two calls
/// of one turn both land.
pub fn record(db: &HubDb, r: &ProjectRef, item: RememberedItem) -> Result<(), StoreError> {
    let item = serde_json::to_string(&item)?;
    db.with(|c| {
        c.execute(
            "UPDATE memory_refreshes SET items = json_insert(items, '$[#]', json(?3))
             WHERE machine_id = ?1 AND project_id = ?2 AND thread_id IS NOT NULL",
            params![r.machine_id.as_str(), r.project_id.as_str(), item],
        )?;
        Ok(())
    })
}

/// Every change a "Memory refreshed" line stands for, the ones past what it lists too; None for a line without a
/// row (none yet), whose listed changes are all of them.
pub fn line_items(db: &HubDb, message_id: &str) -> Result<Option<Vec<RememberedItem>>, StoreError> {
    let items: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT items FROM memory_refresh_lines WHERE message_id = ?",
            [message_id],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(items.and_then(|i| serde_json::from_str(&i).ok()))
}

/// Keeps every change of line `message_id` in project `r`, as Undo marks them.
pub fn put_line_items(
    db: &HubDb,
    r: &ProjectRef,
    message_id: &str,
    items: &[RememberedItem],
) -> Result<(), StoreError> {
    let items = serde_json::to_string(items)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO memory_refresh_lines (message_id, machine_id, project_id, items) VALUES (?, ?, ?, ?)
             ON CONFLICT (message_id) DO UPDATE SET items = excluded.items",
            params![message_id, r.machine_id.as_str(), r.project_id.as_str(), items],
        )?;
        Ok(())
    })
}

/// What a line lists of `items`: the first [`REFRESHED_LISTED`], how many there are when that is not all, and how
/// many are undone.
pub fn listed(items: &[RememberedItem]) -> MemoryRefreshed {
    let undone = items.iter().filter(|i| i.undone == Some(true)).count();
    MemoryRefreshed {
        items: List::unchecked(items.iter().take(REFRESHED_LISTED).cloned().collect()),
        total: (items.len() > REFRESHED_LISTED).then(|| Count::unchecked(items.len() as i64)),
        undone: (undone > 0).then(|| Count::unchecked(undone as i64)),
    }
}

/// The hour of the night due now, as epoch ms: today's (or yesterday's) `at` in `tz`, when now is at most
/// [`WINDOW_MS`] past it. An `at` the clocks skip that night (spring forward) is the first minute after the gap.
pub fn night_due(now_ms: i64, tz: Tz, at: NaiveTime) -> Option<i64> {
    let now = tz.timestamp_millis_opt(now_ms).single()?;
    let today = now.date_naive();
    [Some(today), today.checked_sub_days(Days::new(1))]
        .into_iter()
        .flatten()
        .filter_map(|day| {
            let local = day.and_time(at);
            (0..=GAP_MINUTES).find_map(|m| {
                tz.from_local_datetime(&(local + chrono::Duration::minutes(m)))
                    .earliest()
                    .map(|t| t.timestamp_millis())
            })
        })
        .find(|&ms| ms <= now_ms && now_ms - ms < WINDOW_MS)
}

/// The first hour of a night after `now_ms`, as epoch ms; skipped-over hours as in [`night_due`].
pub fn next_night(now_ms: i64, tz: Tz, at: NaiveTime) -> Option<i64> {
    let today = tz.timestamp_millis_opt(now_ms).single()?.date_naive();
    (0..=2)
        .filter_map(|d| today.checked_add_days(Days::new(d)))
        .filter_map(|day| {
            let local = day.and_time(at);
            (0..=GAP_MINUTES).find_map(|m| {
                tz.from_local_datetime(&(local + chrono::Duration::minutes(m)))
                    .earliest()
                    .map(|t| t.timestamp_millis())
            })
        })
        .find(|&ms| ms > now_ms)
}

/// `policy.memory_refresh_at`, or 04:00; and the zone it is in.
fn schedule(hub: &Hub) -> (Tz, NaiveTime) {
    let global = |k: &str| hub.decisions.global_value(k).ok().flatten();
    let (tz, _) = crate::hub::attention::quiet_policy(global);
    let at = global(AT_KEY)
        .and_then(|v| NaiveTime::parse_from_str(&v, "%H:%M").ok())
        .unwrap_or_else(|| NaiveTime::parse_from_str(DEFAULT_AT, "%H:%M").unwrap());
    (tz, at)
}

/// Whether anyone spoke in the chat after `watermark`, or an order changed after `since_ms`.
fn active(
    db: &HubDb,
    r: &ProjectRef,
    watermark: i64,
    since_ms: Option<i64>,
) -> Result<bool, StoreError> {
    let since = iso_ms(since_ms.unwrap_or(0));
    db.with(|c| {
        Ok(c.query_row(
            "SELECT EXISTS (SELECT 1 FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
               AND held = 0 AND json_extract(data, '$.author') IN ('human', 'lead'))
             OR EXISTS (SELECT 1 FROM workstreams WHERE machine_id = ?1 AND project_id = ?2
               AND json_extract(data, '$.updatedAt') > ?4)",
            params![r.machine_id.as_str(), r.project_id.as_str(), watermark, since],
            |row| row.get(0),
        )?)
    })
}

/// Finishes the refreshes whose session ended or ran too long, then starts the night's refresh of at most one
/// project, so a hub's projects start a minute apart.
pub async fn tick(hub: &Arc<Hub>, launcher: &dyn Launcher) -> Result<(), StoreError> {
    let now = now_ms(hub.clock.as_ref());
    for project in hub.store.projects_list(None, None)? {
        let r = ProjectRef {
            machine_id: project.machine_id.clone(),
            project_id: project.project_id.clone(),
        };
        let run = get(&hub.db, &r)?;
        if let (Some(thread_id), Some(started)) = (&run.thread_id, run.started_ms) {
            let thread = ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id: thread_id.clone(),
            };
            let completed = match ended(&hub.db, &thread, started)? {
                Some(completed) => completed,
                None if now - started > RUN_LIMIT_MS => false,
                None => continue,
            };
            // A session that didn't complete may still run, or be resumed: it goes, so nothing it does later is lost.
            if !completed && let Err(error) = launcher.stop(&thread).await {
                tracing::warn!(%error, project = %project.title, "memory refresh: session not stopped");
            }
            finish(hub, &r, completed)?;
        }
    }
    let (tz, at) = schedule(hub);
    let Some(night) = night_due(now, tz, at) else {
        return Ok(());
    };
    for project in hub.store.projects_list(None, None)? {
        let r = ProjectRef {
            machine_id: project.machine_id.clone(),
            project_id: project.project_id.clone(),
        };
        let mut run = get(&hub.db, &r)?;
        if run.thread_id.is_some()
            || run.night_ms.is_some_and(|n| n >= night)
            || !hub.db.project_settings().memory_refresh(&r)?
        {
            continue;
        }
        if !active(&hub.db, &r, run.watermark, run.night_ms)? {
            run.night_ms = Some(night);
            let last = outcome(
                night,
                AutomationTrigger::Schedule,
                AutomationRunState::Skipped,
                &[],
                Some(QUIET),
            );
            ran(hub, &r, &mut run, last)?;
            continue;
        }
        // A node too old to hold the session to its memory tools: tried again on the next pass, within the night's
        // window, and the chat says so once that night.
        if hub.link.node_lacks(&r.machine_id, CAP_ALLOWED_ONLY) {
            if run.skipped_ms != Some(night) {
                hub.chat
                    .system_line(&r, &format!("Memory refresh skipped: {}", too_old(&r)))?;
                run.skipped_ms = Some(night);
                let last = outcome(
                    night,
                    AutomationTrigger::Schedule,
                    AutomationRunState::Skipped,
                    &[],
                    Some(&too_old(&r)),
                );
                ran(hub, &r, &mut run, last)?;
            }
            continue;
        }
        // Tried again on the next pass, within the night's window.
        if held(hub, &r).is_some() {
            continue;
        }
        start(
            hub,
            launcher,
            &r,
            &project.title,
            run,
            night,
            AutomationTrigger::Schedule,
        )
        .await?;
        return Ok(());
    }
    Ok(())
}

/// Why a project with nothing new isn't refreshed.
const QUIET: &str = "Nothing new in the chat or its orders since the last refresh.";

fn too_old(r: &ProjectRef) -> String {
    format!("update {} to let it run", r.machine_id)
}

/// Why a refresh of `r` can't start now: its lead is mid-turn, its login is out of usage, or no node is linked.
fn held(hub: &Hub, r: &ProjectRef) -> Option<String> {
    if matches!(hub.leads.leads.get(r), Ok(Some(l)) if l.state == LeadState::Working) {
        return Some("The lead is mid-turn: try again once it is done.".into());
    }
    if let Some(gate) = hub.usage.gate_for(
        r.machine_id.as_str(),
        crate::hub::claude_accounts::lead_account_key(&hub.db, r).as_deref(),
    ) {
        return Some(gate);
    }
    (!hub.link.node_can(&r.machine_id, CAP_ALLOWED_ONLY))
        .then(|| format!("{} is offline.", r.machine_id))
}

/// A refresh's record for its row: when, what started it, how it went, and the changes in `items`.
fn outcome(
    at_ms: i64,
    trigger: AutomationTrigger,
    state: AutomationRunState,
    items: &[RememberedItem],
    why: Option<&str>,
) -> MemoryRefreshRun {
    let count =
        |sign: char| Count::unchecked(items.iter().filter(|i| i.sign() == sign).count() as i64);
    MemoryRefreshRun {
        at: iso_ms(at_ms).into(),
        trigger,
        state,
        added: count('+'),
        replaced: count('~'),
        removed: count('−'),
        why: why.map(|w| Line::unchecked(clip(&w.replace(['\r', '\n'], " "), 200))),
    }
}

/// Keeps `run` with `last` as how its refresh went, and tells the app (`memory.refresh`), whose Automations page reads
/// the row again.
fn ran(hub: &Hub, r: &ProjectRef, run: &mut Run, last: MemoryRefreshRun) -> Result<(), StoreError> {
    let data = json!({ "projectRef": r, "trigger": last.trigger, "state": last.state });
    let summary = format!(
        "memory refresh of {}/{}: {}",
        r.machine_id,
        r.project_id,
        crate::hub::automations::state_str(last.state)
    );
    run.last_run = Some(last);
    put(&hub.db, r, run)?;
    hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::MemoryRefresh,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary,
        data: Some(data),
        attention: None,
    })?;
    Ok(())
}

/// The refresh as the Automations page lists it for `r`: on or off, its hour and zone, its next night, and the run
/// going now (with what it changed so far) or the last one.
pub fn job(hub: &Hub, r: &ProjectRef) -> Result<MemoryRefreshJob, StoreError> {
    let on = hub.db.project_settings().memory_refresh(r)?;
    let (tz, at) = schedule(hub);
    let run = get(&hub.db, r)?;
    let last_run = match run.last_run {
        Some(last) if run.thread_id.is_some() => Some(MemoryRefreshRun {
            at: last.at,
            ..outcome(
                0,
                last.trigger,
                AutomationRunState::Running,
                &run.items,
                None,
            )
        }),
        last => last,
    };
    Ok(MemoryRefreshJob {
        on,
        at: Line::unchecked(at.format("%H:%M").to_string()),
        tz: fleetd_contracts::wakes::TimeZone::unchecked(tz.name().to_owned()),
        next_run_at: on
            .then(|| next_night(now_ms(hub.clock.as_ref()), tz, at))
            .flatten()
            .map(|ms| iso_ms(ms).into()),
        last_run,
    })
}

/// Run now: a refresh of `r` started at once, as the night's is, held by the night's rules; why it didn't start.
pub async fn run_now(
    hub: &Arc<Hub>,
    launcher: &dyn Launcher,
    r: &ProjectRef,
) -> Result<Option<String>, StoreError> {
    let Some(project) = hub.store.project_get(r)? else {
        return Ok(Some(format!(
            "There is no project {}/{}.",
            r.machine_id, r.project_id
        )));
    };
    let run = get(&hub.db, r)?;
    let why = if !hub.db.project_settings().memory_refresh(r)? {
        Some("It is off for this project: turn it on first.".to_owned())
    } else if run.thread_id.is_some() {
        Some("A refresh is already running.".to_owned())
    } else if !active(&hub.db, r, run.watermark, run.night_ms)? {
        Some(QUIET.to_owned())
    } else if hub.link.node_lacks(&r.machine_id, CAP_ALLOWED_ONLY) {
        Some(format!("Its node is too old: {}.", too_old(r)))
    } else {
        held(hub, r)
    };
    if why.is_some() {
        return Ok(why);
    }
    let now = now_ms(hub.clock.as_ref());
    start(
        hub,
        launcher,
        r,
        &project.title,
        run,
        now,
        AutomationTrigger::Manual,
    )
    .await
}

/// Whether the session ended after `started_ms`: true when it completed.
fn ended(db: &HubDb, thread: &ThreadRef, started_ms: i64) -> Result<Option<bool>, StoreError> {
    let types: Vec<&str> = END_EVENTS.iter().map(|t| t.as_str()).collect();
    let types = serde_json::to_string(&types)?;
    let ty: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT type FROM events WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
               AND json_extract(data, '$.threadId') = ?3 AND created_ms >= ?4 ORDER BY seq LIMIT 1",
            params![types, thread.machine_id.as_str(), thread.thread_id.as_str(), started_ms],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(ty.map(|t| t == HubEventType::ThreadCompleted.as_str()))
}

/// Starts the refresh of `night` (Run now's: its moment); why it didn't start, which its row shows.
async fn start(
    hub: &Arc<Hub>,
    launcher: &dyn Launcher,
    r: &ProjectRef,
    title: &str,
    mut run: Run,
    night: i64,
    trigger: AutomationTrigger,
) -> Result<Option<String>, StoreError> {
    // Tried once a night: a launch that fails waits for the next one.
    run.night_ms = Some(night);
    put(&hub.db, r, &run)?;
    let now = now_ms(hub.clock.as_ref());
    let failed = |mut run: Run, why: String| {
        let last = outcome(now, trigger, AutomationRunState::Failed, &[], Some(&why));
        ran(hub, r, &mut run, last).map(|()| Some(why))
    };
    let (chat, read_to) = chat_since(&hub.db, r, run.watermark)?;
    let decisions = hub
        .decisions
        .list(&DecisionFilter {
            chain: Some(Chain {
                project_ref: r.clone(),
                workstream_id: None,
            }),
            limit: Some(DECISIONS as i64),
            ..Default::default()
        })
        .unwrap_or_default();
    let set = hub.db.prompts().current(Some(r));
    let prompt = prompt(
        &set.render("lead.memory", &[("project", &title)]),
        &memory_now(hub, r, run.watermark, read_to),
        &decisions,
        &chat,
    );
    let input = LaunchInput {
        project_id: r.project_id.clone(),
        prompt,
        profile: TaskProfile::High,
        // Its node asks for any tool not allowed, and refuses it.
        runtime_mode: RuntimeMode::ApprovalRequired,
        title: Some(
            format!("fleetd memory refresh: {title}")
                .chars()
                .take(80)
                .collect(),
        ),
        client_request_id: format!("fleetd-memory:{}/{}:{night}", r.machine_id, r.project_id),
    };
    // Nobody asked for it: it runs on the account the project's lead does (a Navi's, its owner's).
    let claude_account = match crate::hub::claude_accounts::for_lead(&hub.db, &hub.link, r) {
        Ok(account) => account,
        Err(refused) => {
            tracing::warn!(project = %title, "memory refresh: not started: {}", refused.message);
            return failed(run, refused.message);
        }
    };
    let options = LaunchOptions {
        claude_account,
        ..launch_options()
    };
    match launcher.launch(&r.machine_id, input, options).await {
        Ok(thread_id) => {
            run.thread_id = Some(thread_id);
            run.started_ms = Some(now);
            run.read_to = Some(read_to);
            run.items = Vec::new();
            let last = outcome(now, trigger, AutomationRunState::Running, &[], None);
            ran(hub, r, &mut run, last).map(|()| None)
        }
        Err(error) => {
            tracing::warn!(%error, project = %title, "memory refresh: not started");
            failed(run, format!("It didn't start: {error}"))
        }
    }
}

/// Ends the running refresh of `r`: its line when it changed anything, and the chat it read marked read when it
/// completed. One that failed or ran out of time reads the same chat again the next night.
pub fn finish(hub: &Hub, r: &ProjectRef, completed: bool) -> Result<(), StoreError> {
    let mut run = get(&hub.db, r)?;
    if run.thread_id.is_none() {
        return Ok(());
    }
    let items = std::mem::take(&mut run.items);
    let started = run.started_ms.unwrap_or_else(|| now_ms(hub.clock.as_ref()));
    let trigger = run
        .last_run
        .as_ref()
        .map_or(AutomationTrigger::Schedule, |l| l.trigger);
    let last = if completed {
        outcome(started, trigger, AutomationRunState::Done, &items, None)
    } else {
        outcome(
            started,
            trigger,
            AutomationRunState::Failed,
            &items,
            Some(
                "It failed or ran past its hour, and was stopped; the next one reads the same chat again.",
            ),
        )
    };
    if !items.is_empty() {
        let (message, _) = hub.chat.add(
            r,
            NewMessage {
                author: Some(ChatAuthor::System),
                text: fleetd_contracts::memory::refreshed_summary(&items),
                memory_refreshed: Some(listed(&items)),
                ..Default::default()
            },
        )?;
        put_line_items(&hub.db, r, message.message_id.as_str(), &items)?;
    }
    if completed && let Some(read_to) = run.read_to {
        run.watermark = run.watermark.max(read_to);
    }
    run.thread_id = None;
    run.started_ms = None;
    run.read_to = None;
    run.items = Vec::new();
    ran(hub, r, &mut run, last)
}

/// The chat after `watermark` as lines, oldest first, within [`CHAT_CHARS`] (newest kept, with a note of what was
/// cut), and the newest `seq` there is. The human's and the lead's messages, and what was remembered or forgotten.
fn chat_since(db: &HubDb, r: &ProjectRef, watermark: i64) -> Result<(String, i64), StoreError> {
    let rows: Vec<(i64, String)> = db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND held = 0
             ORDER BY seq DESC LIMIT ?4",
        )?;
        let rows = stmt
            .query_map(
                params![r.machine_id.as_str(), r.project_id.as_str(), watermark, CHAT_ROWS as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    let read_to = rows.first().map_or(watermark, |(seq, _)| *seq);
    let (mut lines, mut used, mut cut) = (Vec::new(), 0, 0);
    for (_, data) in &rows {
        let Ok(m) = serde_json::from_str::<ChatMessage>(data) else {
            continue;
        };
        let Some(line) = chat_line(&m) else { continue };
        if used + line.len() > CHAT_CHARS {
            cut += 1;
            continue;
        }
        used += line.len();
        lines.push(line);
    }
    lines.reverse();
    let mut out = String::new();
    if cut > 0 {
        out.push_str(&format!("({cut} older messages left out.)\n"));
    }
    out.push_str(&lines.join("\n"));
    Ok((out, read_to))
}

fn chat_line(m: &ChatMessage) -> Option<String> {
    let text = clip(m.text.as_str().trim(), MESSAGE_CHARS);
    if text.is_empty() {
        return None;
    }
    let who = match m.author {
        ChatAuthor::Human => "Human",
        ChatAuthor::Lead => "Lead",
        ChatAuthor::System if m.remembered.is_some() => "fleetd",
        ChatAuthor::System | ChatAuthor::Agent => return None,
    };
    Some(format!("{who}: {text}"))
}

/// Every memory file of the project and the user memory of [`you`], whole, each under its name.
fn memory_now(hub: &Hub, r: &ProjectRef, watermark: i64, read_to: i64) -> String {
    let memory = hub.db.memory();
    let you = you_over(&hub.db, r, watermark, read_to).unwrap_or(You::Nobody);
    let user = match you.target() {
        Some(t) => memory.read(&t),
        None => {
            "(Several people wrote in this chat, so user memory is left alone tonight.)".to_owned()
        }
    };
    let mut files = vec![("user.md (add only)".to_owned(), user)];
    files.push((
        format!("{} (project)", super::INDEX_FILE),
        memory.read(&Target::project(r, None)),
    ));
    for topic in memory.topics(r) {
        files.push((
            format!("{topic}.md (project, topic {topic})"),
            memory.read(&Target::project(r, Some(&topic))),
        ));
    }
    let caps = memory.caps();
    let mut out = format!(
        "Caps, in characters: user.md {}, MEMORY.md {}, each topic {}, the project's files together {} (now {}).",
        caps.user.get(),
        caps.index.get(),
        caps.topic.get(),
        caps.project.get(),
        memory.project_chars(r)
    );
    for (name, text) in files {
        let text = text.trim_end();
        out.push_str(&format!(
            "\n\n### {name}\n{}",
            if text.is_empty() { "(empty)" } else { text }
        ));
    }
    out
}

/// The refresh session's one message: its prompt, then the memory, the decisions and the chat.
pub fn prompt(rules: &str, memory: &str, decisions: &[Decision], chat: &str) -> String {
    let decisions = if decisions.is_empty() {
        "(none)".to_owned()
    } else {
        decisions
            .iter()
            .map(|d| {
                let why = d
                    .why
                    .as_ref()
                    .map(|w| format!(" ({})", w.as_str()))
                    .unwrap_or_default();
                format!("- {} {}: {}{why}", d.decision_id, d.key, d.value.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let chat = if chat.trim().is_empty() {
        "(none)"
    } else {
        chat
    };
    format!(
        "{}\n\n## Memory now\n{memory}\n\n## Active decisions\n{decisions}\n\n## Chat since the last refresh\n{chat}",
        rules.trim_end()
    )
}
