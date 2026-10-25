//! Automations: a project's stored prompt with its triggers, a cron schedule in an IANA time zone, an incoming
//! webhook and Run now. Each run opens an order for the project's lead (channel `automation`), which starts the work
//! without a person's message; reviews, the merge train and gated approvals apply as to any order. One run at a time
//! per automation: a trigger while its order is open is skipped and recorded. The scheduler sleeps on the hub clock
//! until the earliest schedule is due; a schedule missed while the hub was down runs once, late, on its return.
//!
//! A webhook URL is `<hub url>/hooks/<automationId>/<secret>`. The hub keeps the secret's SHA-256 only, compares in
//! constant time, and never logs the secret or the body; the body is kept with its run and given to the lead.
pub mod calls;
pub mod tools;
pub mod webhook;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono_tz::Tz;
use fleetd_contracts::automations::{
    AUTOMATIONS_PER_PROJECT, Automation, AutomationId, AutomationName, AutomationPrompt,
    AutomationRun, AutomationRunId, AutomationRunState, AutomationSchedule, AutomationTrigger,
    RUNS_KEPT,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamState};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::{Count, Line};
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::leads::lead::AutoStart;
use crate::hub::leads::wakes::{Trigger, trigger_lines};
use crate::hub::leads::workstreams::IntakeInput;
use crate::hub::leads::{Area, LeadError};
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};
use crate::hub::wakes::LATE_AFTER;
use crate::hub::wakes::schedule::{next_cron, parse_cron, zoned_parts};

/// The longest order text the ledger keeps (`IntakeText`).
const ORDER_CHARS: usize = 4000;

/// A new automation: the app's automation_create or the lead's.
#[derive(Clone, Debug)]
pub struct NewAutomation {
    pub project_ref: ProjectRef,
    pub name: AutomationName,
    pub prompt: AutomationPrompt,
    pub schedule: Option<AutomationSchedule>,
    pub webhook: bool,
    /// A keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    /// Makes a retry return the automation the first call made.
    pub client_request_id: Option<String>,
}

/// An edit: only the fields given change.
#[derive(Clone, Debug, Default)]
pub struct Edit {
    pub name: Option<AutomationName>,
    pub prompt: Option<AutomationPrompt>,
    /// `Some(None)` takes the schedule off.
    pub schedule: Option<Option<AutomationSchedule>>,
    /// true adds a webhook URL (an existing one stays), false removes it.
    pub webhook: Option<bool>,
}

/// What starts a run.
#[derive(Clone, Debug)]
pub enum Start {
    /// Run now, by a keyId, "human" or "lead:<machineId>/<projectId>".
    Manual { by: String },
    /// The webhook, with its body.
    Webhook { payload: String },
    /// The schedule, due at `due_ms`.
    Schedule { due_ms: i64 },
}

impl Start {
    fn trigger(&self) -> AutomationTrigger {
        match self {
            Start::Manual { .. } => AutomationTrigger::Manual,
            Start::Webhook { .. } => AutomationTrigger::Webhook,
            Start::Schedule { .. } => AutomationTrigger::Schedule,
        }
    }
}

pub struct Automations {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    leads: Arc<Area>,
    changed: watch::Sender<u64>,
    /// Held while a run is checked and recorded, so two triggers at once start one run.
    starting: Mutex<()>,
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 9];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// A new webhook secret: 32 random bytes, URL-safe.
fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn secret_hash(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Equal without an early exit, so the time taken says nothing about where two hashes differ.
fn same_hash(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn unhex(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if text.len() != 64 {
        return None;
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The URL a webhook posts to.
pub fn webhook_url(hub_url: &str, id: &AutomationId, secret: &str) -> String {
    format!("{}/hooks/{id}/{secret}", hub_url.trim_end_matches('/'))
}

fn zone(schedule: &AutomationSchedule) -> Result<Tz, LeadError> {
    Tz::from_str_insensitive(schedule.tz.as_str()).map_err(|_| {
        LeadError::invalid(
            format!("'{}' is not an IANA time zone.", schedule.tz),
            "Use a zone name such as Europe/Berlin or America/New_York.",
        )
    })
}

/// The schedule's first run strictly after `after_ms`; refused when it doesn't parse or never runs.
pub fn next_after(schedule: &AutomationSchedule, after_ms: i64) -> Result<i64, LeadError> {
    let tz = zone(schedule)?;
    let cron = parse_cron(schedule.cron.as_str()).map_err(|e| {
        LeadError::invalid(
            format!("The cron '{}' doesn't parse: {e}.", schedule.cron),
            "Give five fields, minute hour day-of-month month day-of-week, such as 0 9 * * 1-5.",
        )
    })?;
    next_cron(&cron, after_ms, tz).ok_or_else(|| {
        LeadError::invalid(
            format!("The cron '{}' never runs.", schedule.cron),
            "Pick days that exist, such as 0 9 1 * * for the 1st of each month.",
        )
    })
}

/// `2026-10-27 09:00 Europe/Berlin`: the instant on the schedule's wall clock.
fn local(ms: i64, schedule: &AutomationSchedule) -> String {
    let Ok(tz) = zone(schedule) else {
        return iso_ms(ms);
    };
    let t = zoned_parts(ms, tz);
    format!(
        "{}-{:02}-{:02} {:02}:{:02} {}",
        t.year, t.month, t.day, t.hour, t.minute, schedule.tz
    )
}

fn state_str(state: AutomationRunState) -> &'static str {
    match state {
        AutomationRunState::Running => "running",
        AutomationRunState::Done => "done",
        AutomationRunState::Stopped => "stopped",
        AutomationRunState::Skipped => "skipped",
        AutomationRunState::Failed => "failed",
    }
}

fn why(text: impl AsRef<str>) -> Option<Line<0, 200>> {
    let one_line = text.as_ref().replace(['\r', '\n'], " ");
    Some(Line::unchecked(crate::hub::leads::digest::clip(
        &one_line, 200,
    )))
}

/// The markdown fence that no run of backticks inside `body` closes.
fn fence(body: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    "`".repeat((longest + 1).max(3))
}

/// The order a run opens: the automation's name as its title, where it came from, the prompt, and a webhook's body
/// as far as it fits (the rest is one `automation_runs` call away).
pub fn order_text(a: &Automation, run: &AutomationRun, payload: Option<&str>) -> String {
    let how = match run.trigger {
        AutomationTrigger::Schedule => {
            let schedule = a.schedule.as_ref();
            let due = run
                .scheduled_at
                .as_ref()
                .and_then(|t| crate::hub::store::parse_ms(t.as_str()));
            let when = match (schedule, due) {
                (Some(s), Some(ms)) => format!("its schedule ({}), due {}", s.cron, local(ms, s)),
                _ => "its schedule".to_owned(),
            };
            match &run.late_min {
                Some(late) => format!(
                    "{when}; the hub was down then, so this is that run {} min late, once",
                    late.get()
                ),
                None => when,
            }
        }
        AutomationTrigger::Webhook => "its webhook".to_owned(),
        AutomationTrigger::Manual => "Run now".to_owned(),
    };
    let mut text = format!(
        "{}\nFrom automation {} (run {}, started by {how}). Start the work without asking the human first; \
         reviews, the merge train and approvals apply as always.\n\n{}",
        a.name, a.automation_id, run.run_id, a.prompt
    );
    if let Some(body) = payload {
        let bytes = body.len();
        let f = fence(body);
        let head = format!("\n\nThe webhook's body ({bytes} bytes):\n{f}\n");
        let cut_note = format!(
            "\n{f}\nCut here; automation_runs with runId {} has the whole body.",
            run.run_id
        );
        let room = ORDER_CHARS
            .saturating_sub(text.chars().count() + head.chars().count() + cut_note.chars().count());
        if body.chars().count() <= room {
            text.push_str(&format!("{head}{body}\n{f}"));
        } else {
            let part: String = body.chars().take(room).collect();
            text.push_str(&format!("{head}{part}{cut_note}"));
        }
    }
    text.chars().take(ORDER_CHARS).collect()
}

fn decode(data: &str) -> Result<Automation, StoreError> {
    Ok(serde_json::from_str(data)?)
}

fn decode_run(data: &str) -> Result<AutomationRun, StoreError> {
    Ok(serde_json::from_str(data)?)
}

fn not_found(id: &str) -> LeadError {
    LeadError::not_found(
        format!("There is no automation {id}."),
        "automation_list shows the project's automations.",
    )
}

impl Automations {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
        leads: Arc<Area>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            events,
            clock,
            leads,
            changed: watch::channel(0).0,
            starting: Mutex::new(()),
            task: Mutex::new(None),
        })
    }

    /// Starts the scheduler; `stop` (or aborting the handle) ends it.
    pub fn start(self: &Arc<Self>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        let handle = tokio::spawn(async move { me.scheduler().await });
        if let Some(old) = self
            .task
            .lock()
            .expect("lock")
            .replace(handle.abort_handle())
        {
            old.abort();
        }
        handle
    }

    /// Stops the scheduler (a hub shutdown, or a test's restart).
    pub fn stop(&self) {
        if let Some(h) = self.task.lock().expect("lock").take() {
            h.abort();
        }
    }

    fn signal(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    fn event(
        &self,
        a: &Automation,
        r#type: HubEventType,
        summary: String,
        data: serde_json::Value,
    ) {
        let mut data = data;
        data["projectRef"] = json!(a.project_ref);
        data["automationId"] = json!(a.automation_id);
        if let Err(error) = self.events.append(NewEvent {
            at: iso_ms(self.now()).into(),
            r#type,
            machine_id: Some(a.project_ref.machine_id.clone()),
            project_id: Some(a.project_ref.project_id.clone()),
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        }) {
            tracing::error!(%error, "automation event not appended");
        }
    }

    fn changed_event(&self, a: &Automation, change: &str, by: &str) {
        self.event(
            a,
            HubEventType::AutomationChanged,
            format!("Automation \u{201c}{}\u{201d} {change}", a.name),
            json!({ "change": change, "by": by }),
        );
    }

    // ---- storage ---------------------------------------------------------------------------------

    fn row(&self, id: &str) -> Result<Option<Automation>, StoreError> {
        let data: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data FROM automations WHERE automation_id = ?",
                [id],
                |r| r.get(0),
            )
            .optional()?)
        })?;
        data.map(|d| decode(&d)).transpose()
    }

    fn put(&self, a: &Automation) -> Result<(), StoreError> {
        let next = a
            .next_run_at
            .as_ref()
            .and_then(|t| crate::hub::store::parse_ms(t.as_str()));
        let stored = Automation {
            last_run: None,
            ..a.clone()
        };
        self.db.with(|c| {
            c.execute(
                "UPDATE automations SET paused = ?, next_run_ms = ?, data = ? WHERE automation_id = ?",
                params![
                    a.paused,
                    next,
                    serde_json::to_string(&stored)?,
                    a.automation_id.as_str()
                ],
            )?;
            Ok(())
        })
    }

    fn put_run(&self, run: &AutomationRun) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "UPDATE automation_runs SET state = ?, workstream_id = ?, data = ? WHERE run_id = ?",
                params![
                    state_str(run.state),
                    run.workstream_id.as_ref().map(|w| w.as_str()),
                    serde_json::to_string(run)?,
                    run.run_id.as_str()
                ],
            )?;
            Ok(())
        })
    }

    fn runs_of(&self, id: &str, limit: usize) -> Result<Vec<AutomationRun>, StoreError> {
        let rows: Vec<String> = self.db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT data FROM automation_runs WHERE automation_id = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?",
            )?;
            let rows = stmt
                .query_map(params![id, limit as i64], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })?;
        rows.iter().map(|d| decode_run(d)).collect()
    }

    /// A running run whose order has closed since is over: done or stopped as its order was.
    fn settle(&self, mut run: AutomationRun) -> Result<AutomationRun, LeadError> {
        if run.state != AutomationRunState::Running {
            return Ok(run);
        }
        let Some(w) = &run.workstream_id else {
            return Ok(run);
        };
        let (state, at) = match self.leads.workstreams.get(w)? {
            Some(ws) if ws.state == WorkstreamState::Open => return Ok(run),
            Some(ws) => (
                if ws.state == WorkstreamState::Done {
                    AutomationRunState::Done
                } else {
                    AutomationRunState::Stopped
                },
                ws.updated_at,
            ),
            None => (AutomationRunState::Stopped, iso_ms(self.now()).into()),
        };
        run.state = state;
        run.ended_at = Some(at);
        self.put_run(&run)?;
        Ok(run)
    }

    fn with_last_run(&self, mut a: Automation) -> Result<Automation, LeadError> {
        a.last_run = match self
            .runs_of(a.automation_id.as_str(), 1)?
            .into_iter()
            .next()
        {
            Some(run) => Some(self.settle(run)?),
            None => None,
        };
        Ok(a)
    }

    pub fn get(&self, id: &str) -> Result<Option<Automation>, LeadError> {
        match self.row(id)? {
            Some(a) => Ok(Some(self.with_last_run(a)?)),
            None => Ok(None),
        }
    }

    /// The automation, refused unless it is `project`'s.
    pub fn own(&self, project: &ProjectRef, id: &str) -> Result<Automation, LeadError> {
        match self.get(id)? {
            Some(a) if a.project_ref == *project => Ok(a),
            Some(_) => Err(LeadError::new(
                ErrorCode::Forbidden,
                format!("{id} belongs to another project."),
                "Use an automation of this project; automation_list shows them.",
            )),
            None => Err(not_found(id)),
        }
    }

    /// The project's automations, oldest first, each with its last run.
    pub fn list(&self, r: &ProjectRef) -> Result<Vec<Automation>, LeadError> {
        let rows: Vec<String> = self.db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT data FROM automations WHERE machine_id = ? AND project_id = ? ORDER BY rowid",
            )?;
            let rows = stmt
                .query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |r| {
                    r.get(0)
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })?;
        rows.iter()
            .map(|d| self.with_last_run(decode(d)?))
            .collect()
    }

    /// Newest first, at most `limit`.
    pub fn runs(&self, id: &str, limit: usize) -> Result<Vec<AutomationRun>, LeadError> {
        self.runs_of(id, limit)?
            .into_iter()
            .map(|r| self.settle(r))
            .collect()
    }

    /// One run of `id` with its webhook body, if it had one.
    pub fn run_with_payload(
        &self,
        id: &str,
        run_id: &str,
    ) -> Result<Option<(AutomationRun, Option<String>)>, LeadError> {
        let row: Option<(String, Option<String>)> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data, payload FROM automation_runs WHERE automation_id = ? AND run_id = ?",
                [id, run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
        })?;
        match row {
            Some((data, payload)) => Ok(Some((self.settle(decode_run(&data)?)?, payload))),
            None => Ok(None),
        }
    }

    /// Makes the automation; with `webhook`, also its secret, which is returned here once and never kept.
    pub fn create(&self, input: NewAutomation) -> Result<(Automation, Option<String>), LeadError> {
        if let Some(key) = &input.client_request_id {
            let existing: Option<String> = self.db.with(|c| {
                Ok(c.query_row(
                    "SELECT data FROM automations WHERE created_by = ? AND client_request_id = ?",
                    params![input.by, key],
                    |r| r.get(0),
                )
                .optional()?)
            })?;
            if let Some(data) = existing {
                return Ok((self.with_last_run(decode(&data)?)?, None));
            }
        }
        let r = &input.project_ref;
        if self.leads.ctx.store.project_get(r)?.is_none() {
            return Err(LeadError::no_project(r));
        }
        let count: i64 = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM automations WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )?)
        })?;
        if count as usize >= AUTOMATIONS_PER_PROJECT {
            return Err(LeadError::invalid(
                format!(
                    "The project has {AUTOMATIONS_PER_PROJECT} automations, the most it keeps."
                ),
                "Delete one it no longer needs, or fold two into one prompt.",
            ));
        }
        let now = self.now();
        let next = input
            .schedule
            .as_ref()
            .map(|s| next_after(s, now))
            .transpose()?;
        let at = iso_ms(now);
        let a = Automation {
            automation_id: AutomationId::unchecked(random_id("au_")),
            project_ref: r.clone(),
            name: input.name,
            prompt: input.prompt,
            schedule: input.schedule,
            webhook: input.webhook,
            paused: false,
            next_run_at: next.map(|n| iso_ms(n).into()),
            last_run: None,
            created_by: input.by.clone(),
            created_at: at.clone().into(),
            updated_at: at.into(),
        };
        let secret = input.webhook.then(new_secret);
        self.db.with(|c| {
            c.execute(
                "INSERT INTO automations (automation_id, machine_id, project_id, created_by, client_request_id, paused,
                   next_run_ms, webhook_hash, data)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
                params![
                    a.automation_id.as_str(),
                    r.machine_id.as_str(),
                    r.project_id.as_str(),
                    input.by,
                    input.client_request_id,
                    next,
                    secret.as_deref().map(|s| hex(&secret_hash(s))),
                    serde_json::to_string(&a)?
                ],
            )?;
            Ok(())
        })?;
        self.changed_event(&a, "created", &input.by);
        self.signal();
        Ok((a, secret))
    }

    /// Applies `edit`; a new webhook's secret is returned once.
    pub fn update(
        &self,
        id: &str,
        edit: Edit,
        by: &str,
    ) -> Result<(Automation, Option<String>), LeadError> {
        let mut a = self.row(id)?.ok_or_else(|| not_found(id))?;
        if let Some(name) = edit.name {
            a.name = name;
        }
        if let Some(prompt) = edit.prompt {
            a.prompt = prompt;
        }
        if let Some(schedule) = edit.schedule {
            a.schedule = schedule;
        }
        let now = self.now();
        let next = match (&a.schedule, a.paused) {
            (Some(s), false) => Some(next_after(s, now)?),
            _ => None,
        };
        a.next_run_at = next.map(|n| iso_ms(n).into());
        let secret = match edit.webhook {
            Some(true) if !a.webhook => Some(new_secret()),
            _ => None,
        };
        if let Some(on) = edit.webhook {
            a.webhook = on;
        }
        a.updated_at = iso_ms(now).into();
        self.put(&a)?;
        if edit.webhook == Some(false) || secret.is_some() {
            self.set_hash(id, secret.as_deref())?;
        }
        self.changed_event(&a, "edited", by);
        self.signal();
        Ok((self.with_last_run(a)?, secret))
    }

    fn set_hash(&self, id: &str, secret: Option<&str>) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "UPDATE automations SET webhook_hash = ? WHERE automation_id = ?",
                params![secret.map(|s| hex(&secret_hash(s))), id],
            )?;
            Ok(())
        })
    }

    /// Paused: its schedule and webhook start nothing. Resumed: the schedule goes on from now; what it missed
    /// while paused doesn't run.
    pub fn pause(&self, id: &str, paused: bool, by: &str) -> Result<Automation, LeadError> {
        let mut a = self.row(id)?.ok_or_else(|| not_found(id))?;
        if a.paused == paused {
            return self.with_last_run(a);
        }
        let now = self.now();
        a.paused = paused;
        a.next_run_at = match (&a.schedule, paused) {
            (Some(s), false) => Some(iso_ms(next_after(s, now)?).into()),
            _ => None,
        };
        a.updated_at = iso_ms(now).into();
        self.put(&a)?;
        self.changed_event(&a, if paused { "paused" } else { "resumed" }, by);
        self.signal();
        self.with_last_run(a)
    }

    /// A new webhook secret; the old URL stops working at once.
    pub fn rotate(&self, id: &str, by: &str) -> Result<(Automation, String), LeadError> {
        let mut a = self.row(id)?.ok_or_else(|| not_found(id))?;
        let secret = new_secret();
        a.webhook = true;
        a.updated_at = iso_ms(self.now()).into();
        self.put(&a)?;
        self.set_hash(id, Some(&secret))?;
        self.changed_event(&a, "has a new webhook URL", by);
        Ok((self.with_last_run(a)?, secret))
    }

    /// Deletes it and its runs; an order a run opened stays an order.
    pub fn delete(&self, id: &str, by: &str) -> Result<(), LeadError> {
        let a = self.row(id)?.ok_or_else(|| not_found(id))?;
        self.db.transaction(|c| {
            c.execute("DELETE FROM automation_runs WHERE automation_id = ?", [id])?;
            c.execute("DELETE FROM automations WHERE automation_id = ?", [id])?;
            Ok(())
        })?;
        self.changed_event(&a, "deleted", by);
        self.signal();
        Ok(())
    }

    /// The automation whose webhook `secret` opens, else None: an unknown id and a wrong secret look the same.
    pub fn webhook_target(&self, id: &str, secret: &str) -> Result<Option<Automation>, LeadError> {
        let stored: Option<Option<String>> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT webhook_hash FROM automations WHERE automation_id = ?",
                [id],
                |r| r.get(0),
            )
            .optional()?)
        })?;
        let given = secret_hash(secret);
        // A missing automation still costs a comparison.
        let expected = stored.flatten().and_then(|h| unhex(&h));
        let ok = same_hash(&given, &expected.unwrap_or([0u8; 32])) && expected.is_some();
        if !ok {
            return Ok(None);
        }
        self.get(id)
    }

    // ---- runs ------------------------------------------------------------------------------------

    /// A run: skipped (and recorded) while the automation is paused (schedule and webhook only) or another run's
    /// order is open; else it opens the order and starts the project's lead if it has none.
    pub async fn run(&self, id: &str, start: Start) -> Result<AutomationRun, LeadError> {
        let (a, run) = self.open(id, start)?;
        self.wake_lead(&a, &run).await;
        Ok(run)
    }

    /// [`Automations::run`] up to its order: recorded, and the order opened (the lead hears of it), without waiting
    /// for a lead to start. Hand the result to [`Automations::wake_lead`].
    pub fn open(&self, id: &str, start: Start) -> Result<(Automation, AutomationRun), LeadError> {
        let guard = self.starting.lock().expect("lock");
        let a = self.get(id)?.ok_or_else(|| not_found(id))?;
        let now = self.now();
        let trigger = start.trigger();
        let busy = a
            .last_run
            .as_ref()
            .filter(|r| r.state == AutomationRunState::Running);
        let skipped = match (&start, busy) {
            (Start::Schedule { .. } | Start::Webhook { .. }, _) if a.paused => {
                Some("the automation is paused".to_owned())
            }
            (_, Some(r)) => Some(match &r.workstream_id {
                Some(w) => format!("run {} is still going ({w} is open)", r.run_id),
                None => format!("run {} is still starting", r.run_id),
            }),
            _ => None,
        };
        let (scheduled_at, late_min) = match &start {
            Start::Schedule { due_ms } => {
                let late = now - due_ms;
                (
                    Some(iso_ms(*due_ms).into()),
                    (late >= LATE_AFTER.as_millis() as i64)
                        .then(|| Count::unchecked((late as f64 / 60_000.0).round() as i64)),
                )
            }
            _ => (None, None),
        };
        let payload = match &start {
            Start::Webhook { payload } => Some(payload.clone()),
            _ => None,
        };
        let mut run = AutomationRun {
            run_id: AutomationRunId::unchecked(random_id("ar_")),
            automation_id: a.automation_id.clone(),
            trigger,
            at: iso_ms(now).into(),
            state: if skipped.is_some() {
                AutomationRunState::Skipped
            } else {
                AutomationRunState::Running
            },
            workstream_id: None,
            scheduled_at,
            late_min,
            payload_bytes: payload.as_ref().map(|p| Count::unchecked(p.len() as i64)),
            why: skipped.as_ref().and_then(why),
            by: match &start {
                Start::Manual { by } => Some(by.clone()),
                _ => None,
            },
            ended_at: skipped.is_some().then(|| iso_ms(now).into()),
        };
        self.db.transaction(|c| {
            c.execute(
                "INSERT INTO automation_runs (run_id, automation_id, at_ms, state, workstream_id, payload, data)
                 VALUES (?, ?, ?, ?, NULL, ?, ?)",
                params![
                    run.run_id.as_str(),
                    id,
                    now,
                    state_str(run.state),
                    payload,
                    serde_json::to_string(&run)?
                ],
            )?;
            // The newest RUNS_KEPT stay.
            c.execute(
                "DELETE FROM automation_runs WHERE automation_id = ?1 AND run_id NOT IN
                   (SELECT run_id FROM automation_runs WHERE automation_id = ?1 ORDER BY at_ms DESC, rowid DESC LIMIT ?2)",
                params![id, RUNS_KEPT as i64],
            )?;
            Ok(())
        })?;
        if let Some(reason) = &skipped {
            drop(guard);
            self.run_event(&a, &run, format!("skipped: {reason}"));
            return Ok((a, run));
        }
        let opened = self.leads.workstreams.intake(IntakeInput {
            project_ref: a.project_ref.clone(),
            text: order_text(&a, &run, payload.as_deref()),
            client_request_id: run.run_id.to_string(),
            channel: IntakeChannel::Automation,
            by: format!("automation:{}", a.automation_id),
        });
        match opened {
            Ok(outcome) => run.workstream_id = Some(outcome.workstream_id),
            Err(e) => {
                run.state = AutomationRunState::Failed;
                run.why = why(&e.message);
                run.ended_at = Some(iso_ms(self.now()).into());
            }
        }
        self.put_run(&run)?;
        drop(guard);
        if run.workstream_id.is_none() {
            self.run_event(&a, &run, "failed: its order could not be opened".into());
        }
        Ok((a, run))
    }

    /// Starts the project's lead if it has none, its first message ending with the order as a wake would say it
    /// (the digest names a draft by its title only); a running lead was woken by the order itself. A lead that can't
    /// start now (machine offline, runner logged out) starts with the order waiting once it can.
    pub async fn wake_lead(&self, a: &Automation, run: &AutomationRun) {
        let Some(w) = &run.workstream_id else {
            return;
        };
        let first = match self.leads.workstreams.get(w) {
            Ok(Some(order)) => trigger_lines(&[Trigger::Intent {
                workstream_id: w.clone(),
                text: order.source.text.to_string(),
            }])
            .join("\n"),
            _ => String::new(),
        };
        let first = (!first.is_empty()).then_some(first.as_str());
        let lead = match self.leads.leads.auto_start(&a.project_ref, first).await {
            AutoStart::Running(_) => "the lead has it".to_owned(),
            AutoStart::Started(_) => "the lead started with it".to_owned(),
            AutoStart::Held(e) => format!("it waits for the lead: {}", e.message),
        };
        self.run_event(a, run, format!("opened {w}; {lead}"));
    }

    fn run_event(&self, a: &Automation, run: &AutomationRun, what: String) {
        let by = match run.trigger {
            AutomationTrigger::Schedule => "on schedule",
            AutomationTrigger::Webhook => "from its webhook",
            AutomationTrigger::Manual => "by Run now",
        };
        self.event(
            a,
            HubEventType::AutomationRun,
            crate::hub::leads::digest::clip(
                &format!("Automation \u{201c}{}\u{201d} ran {by}: {what}", a.name),
                200,
            ),
            json!({
                "runId": run.run_id,
                "trigger": run.trigger,
                "state": run.state,
                "workstreamId": run.workstream_id,
            }),
        );
    }

    // ---- the schedule ----------------------------------------------------------------------------

    /// A due schedule: its next run moves on first, from now, so runs missed while the hub was down collapse into
    /// this one; then the run.
    async fn fire(&self, id: &str, due_ms: i64) -> Result<(), LeadError> {
        let Some(mut a) = self.row(id)? else {
            return Ok(());
        };
        let now = self.now();
        a.next_run_at = match (&a.schedule, a.paused) {
            (Some(s), false) => next_after(s, now).ok().map(|n| iso_ms(n).into()),
            _ => None,
        };
        self.put(&a)?;
        self.run(id, Start::Schedule { due_ms }).await?;
        Ok(())
    }

    /// Sleeps until the earliest schedule is due, or until an automation changes.
    async fn scheduler(self: Arc<Self>) {
        let mut changed = self.changed.subscribe();
        loop {
            changed.borrow_and_update();
            let due: Result<Option<(String, i64)>, StoreError> = self.db.with(|c| {
                Ok(c.query_row(
                    "SELECT automation_id, next_run_ms FROM automations WHERE next_run_ms IS NOT NULL
                     ORDER BY next_run_ms LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
            });
            let Ok(Some((id, due_ms))) = due else {
                let _ = changed.changed().await;
                continue;
            };
            let wait = due_ms - self.now();
            if wait > 0 {
                tokio::select! {
                    () = self.clock.sleep(Duration::from_millis(wait as u64)) => {}
                    _ = changed.changed() => {}
                }
                continue;
            }
            if let Err(error) = self.fire(&id, due_ms).await {
                // Its next run was moved on before the run, so one failure doesn't spin the loop.
                tracing::error!(automation = %id, error = %error.message, "automation run failed");
                let _ = self.db.with(|c| {
                    c.execute(
                        "UPDATE automations SET next_run_ms = NULL WHERE automation_id = ? AND next_run_ms = ?",
                        params![id, due_ms],
                    )?;
                    Ok(())
                });
            }
        }
    }
}

/// Text the hub already measured (a webhook body under its cap), as a `Text`.
pub fn text_of<const MAX: usize>(s: &str) -> fleetd_contracts::prim::Text<0, MAX> {
    fleetd_contracts::prim::Text::unchecked(s.chars().take(MAX).collect::<String>())
}
