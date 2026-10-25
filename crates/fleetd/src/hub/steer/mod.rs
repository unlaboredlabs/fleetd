//! Steering: a person's (or a lead's) words to a running agent, sent straight to its thread as one short message,
//! never through the wake debounce or with the digest. `queue` lands at the agent's next tool boundary as its own
//! turn; `now` stops its current step. Every steer has a receipt the node decides from claude's own frames
//! (`MachineEvent::Steer`), stored here and emitted as `steer.*` events. See docs/build/steering-spec.md.
pub mod store;
pub mod tools;

use std::sync::{Arc, Weak};

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ThreadRef};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::sessions::SendMode;
use fleetd_contracts::steer::{
    Steer, SteerBy, SteerEventData, SteerId, SteerMode, SteerReceipt, SteerStage, SteerTarget,
};
use fleetd_contracts::tasks::{Task, TaskState};

use crate::hub::api::{Caller, Hub, ToolError, allows, require};
use crate::hub::executor::Executors;
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::leads::events::Event;
use crate::hub::leads::records::is_closed;
use crate::hub::queue::ports::SendOpts;
use crate::hub::store::{NewEvent, iso_ms, now_ms};
use crate::hub::tasks::TaskCaller;

/// Who sends a steer.
pub enum By<'a> {
    Human(&'a Caller),
    /// A lead, for a task of its own project.
    Lead(&'a fleetd_contracts::ids::ProjectRef),
}

impl By<'_> {
    fn stored(&self) -> String {
        match self {
            By::Human(caller) => format!("key:{}", caller.key_id),
            By::Lead(_) => "lead".into(),
        }
    }

    fn steer_by(&self) -> SteerBy {
        match self {
            By::Human(caller) => SteerBy::Human {
                key_name: caller.name.clone(),
            },
            By::Lead(_) => SteerBy::Lead,
        }
    }
}

pub struct SteerRequest<'a> {
    pub target: SteerTarget,
    pub text: &'a str,
    pub mode: SteerMode,
    /// Rendered "References:" lines and delivered attachment paths.
    pub refs: Vec<String>,
    pub attached: Vec<String>,
    pub client_request_id: &'a str,
}

/// Where a steer goes.
struct Resolved {
    workstream_id: WorkstreamId,
    title: String,
    task: Option<Task>,
    thread: ThreadRef,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(ErrorCode::Invalid, message)
}

fn not_found(what: &str) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No {what}."))
        .with_fix("Call orders_board to see open orders and their agents.")
}

fn resolve(hub: &Hub, by: &By, target: &SteerTarget) -> Result<Resolved, ToolError> {
    match target {
        SteerTarget::Lead { workstream_id } => {
            let w = hub
                .leads
                .records
                .workstream_get(workstream_id)?
                .ok_or_else(|| not_found(&format!("order {workstream_id}")))?;
            let r = &w.project_ref;
            if let By::Human(caller) = by {
                if !allows(caller, Role::Read, Some(&r.machine_id)) {
                    return Err(not_found(&format!("order {workstream_id}")));
                }
                require(caller, Role::Operate, Some(&r.machine_id))?;
            }
            if is_closed(w.state) {
                return Err(invalid(format!(
                    "{workstream_id} has ended; its lead no longer works on it."
                ))
                .with_fix("Tell the project's lead in its chat (chat_send)."));
            }
            let lead = hub.leads.records.lead_get(r)?.ok_or_else(|| {
                invalid(format!(
                    "{workstream_id}'s project has no lead running yet."
                ))
                .with_fix("Start it with lead_start, then steer it.")
            })?;
            Ok(Resolved {
                workstream_id: w.workstream_id.clone(),
                title: w.title.to_string(),
                task: None,
                thread: ThreadRef {
                    machine_id: r.machine_id.clone(),
                    thread_id: lead.thread_id,
                },
            })
        }
        SteerTarget::Task { task_id } => {
            let task = hub
                .tasks
                .get(task_id)?
                .ok_or_else(|| not_found(&format!("task {task_id}")))?;
            let r = &task.project_ref;
            match by {
                By::Human(caller) => {
                    if !allows(caller, Role::Read, Some(&r.machine_id)) {
                        return Err(not_found(&format!("task {task_id}")));
                    }
                    require(caller, Role::Operate, Some(&r.machine_id))?;
                }
                By::Lead(own) if *own != r => {
                    return Err(not_found(&format!("task {task_id} in this project")));
                }
                By::Lead(_) => {}
            }
            if task.state == TaskState::Cancelled {
                return Err(invalid(format!("{task_id} was cancelled."))
                    .with_fix("Spawn a new task for the remaining work."));
            }
            let thread = task.thread_ref.clone().ok_or_else(|| {
                invalid(format!("{task_id} has not started yet.")).with_fix(
                    "Wait for it to start, or cancel it and spawn it with the new prompt.",
                )
            })?;
            let title = hub
                .leads
                .records
                .workstream_get(&task.workstream_id)?
                .map(|s| s.title.to_string())
                .unwrap_or_default();
            Ok(Resolved {
                workstream_id: task.workstream_id.clone(),
                title,
                task: Some(task),
                thread,
            })
        }
    }
}

fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", js_take(&flat, max - 1))
    } else {
        flat
    }
}

fn references(refs: &[String], attached: &[String]) -> String {
    let mut out = String::new();
    if !refs.is_empty() {
        out.push_str("\nReferences:\n");
        out.push_str(&refs.join("\n"));
    }
    if !attached.is_empty() {
        out.push_str("\nAttached:\n");
        out.push_str(&attached.join("\n"));
    }
    out
}

fn kind_name(task: &Task) -> String {
    serde_json::to_value(task.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// What the agent receives (`steer.message`, editable like every prompt).
fn message(hub: &Hub, steer: &Steer, to: &Resolved, by: &By, req: &SteerRequest) -> String {
    let scope = match &to.task {
        None => format!("{} '{}'", to.workstream_id, one_line(&to.title, 80)),
        Some(task) => format!(
            "{} ({}) for {}",
            task.task_id,
            kind_name(task),
            to.workstream_id
        ),
    };
    let who = match by {
        By::Human(_) => "the human",
        By::Lead(_) => "your lead",
    };
    hub.db
        .prompts()
        .for_thread(&to.thread.machine_id, to.thread.thread_id.as_str())
        .render(
            "steer.message",
            &[
                ("id", &steer.id),
                ("who", &who),
                ("scope", &scope),
                ("text", &one_line(req.text, 4000)),
                ("references", &references(&req.refs, &req.attached)),
            ],
        )
}

fn hhmm(iso: &str) -> String {
    iso.get(11..16).unwrap_or(iso).to_owned()
}

/// Sends a steer: stored as `queued`, then straight to the agent's thread (or the offline queue). A retried request
/// (the same key and clientRequestId) returns the stored steer and sends nothing.
pub async fn send(hub: &Hub, by: By<'_>, req: SteerRequest<'_>) -> Result<Steer, ToolError> {
    let to = resolve(hub, &by, &req.target)?;
    let crid = format!("steer:{}:{}", by.stored(), req.client_request_id);
    let run_id = Executors::send_run_id(&to.thread, &crid);
    let now = now_ms(hub.clock.as_ref());
    let draft = Steer {
        id: SteerId::from_n(1),
        target: req.target.clone(),
        workstream_id: to.workstream_id.clone(),
        thread: to.thread.clone(),
        run_id: NonEmpty::unchecked(run_id),
        by: by.steer_by(),
        mode: req.mode,
        text: Text::new(js_take(req.text, 4000)).map_err(invalid)?,
        stage: SteerStage::Queued,
        queued_at: iso_ms(now).into(),
        delivered_at: None,
        how: None,
        stopped_tool: None,
        seen_at: None,
        acked_at: None,
        ack_excerpt: None,
        detail: None,
    };
    let task_id = to.task.as_ref().map(|t| t.task_id.to_string());
    let (mut steer, created) = store::insert(
        &hub.db,
        store::NewSteer {
            steer: draft,
            task_id: task_id.as_deref(),
            by: by.stored(),
            queued_ms: now,
            request: crid.clone(),
        },
    )?;
    if !created {
        return Ok(steer);
    }
    emit(hub, &steer, HubEventType::SteerQueued, None);
    if let (By::Human(_), Some(task)) = (&by, &to.task) {
        tell_lead(hub, &steer, task);
    }
    let text = message(hub, &steer, &to, &by, &req);
    // A task that is not running gets it with its next run (a queued task when it starts, an ended one as its
    // continuation): held until then, and sent tagged with that run, so its receipts are the run's.
    if let Some(task) = to.task.as_ref().filter(|t| t.state != TaskState::Running) {
        let caller = TaskCaller {
            project_ref: task.project_ref.clone(),
            by: by.stored(),
        };
        steer.detail = Some(Text::unchecked(format!(
            "queued until {} starts; it gets this with its next run",
            task.task_id
        )));
        store::put(&hub.db, &steer, None, None)?;
        store::hold(&hub.db, &steer.id, Some(&text))?;
        return match hub.tasks.message(&caller, &task.task_id, &text).await {
            Ok(_) => Ok(store::get(&hub.db, &steer.id)?.map_or(steer, |(s, _)| s)),
            Err(e) => {
                fail(hub, &mut steer, &e.message)?;
                Err(e)
            }
        };
    }
    let opts = SendOpts {
        mode: match req.mode {
            SteerMode::Queue => SendMode::Boundary,
            SteerMode::Now => SendMode::Now,
        },
        steer: Some(steer.id.clone()),
        riders: Vec::new(),
    };
    match hub
        .queue
        .send_with(&to.thread, &text, &crid, None, opts)
        .await
    {
        Ok(sent) if sent.queued => {
            let until = sent.queued_until.as_deref().map(hhmm).unwrap_or_default();
            steer.detail = Some(Text::unchecked(format!(
                "waiting for {} (until {until})",
                to.thread.machine_id
            )));
            store::put(&hub.db, &steer, None, None)?;
            Ok(steer)
        }
        Ok(_) => Ok(steer),
        Err(e) => {
            fail(hub, &mut steer, &e.to_string())?;
            Err(ToolError::new(ErrorCode::Failed, e.to_string()))
        }
    }
}

/// A person steered a task directly: its lead hears it at its next wake (debounced, never an interrupt), so its plan
/// and its own messages to the task don't fork from it.
fn tell_lead(hub: &Hub, steer: &Steer, task: &Task) {
    let r = &task.project_ref;
    let line = Event::AgentSteered {
        task: task.task_id.as_str(),
        kind: &kind_name(task),
        steer: steer.id.as_str(),
        text: &steer.text,
    }
    .render();
    hub.leads.wakes.trigger(
        r,
        crate::hub::leads::wakes::Trigger::Line {
            kind: crate::hub::leads::wakes::LineKind::Human,
            text: line,
        },
    );
}

/// The lead digest's line under an order: the human's latest direct steers to its tasks, and how each landed.
pub fn digest_line(db: &crate::hub::store::HubDb, workstream_id: &WorkstreamId) -> Option<String> {
    let steers = store::list(db, workstream_id.as_str(), 20).ok()?;
    let parts: Vec<String> = steers
        .iter()
        .filter(|s| matches!(s.by, SteerBy::Human { .. }))
        .filter_map(|s| match &s.target {
            SteerTarget::Task { task_id } => Some((s, task_id)),
            SteerTarget::Lead { .. } => None,
        })
        .take(3)
        .map(|(s, task_id)| {
            let stage = match s.stage {
                SteerStage::Unacknowledged => "not acknowledged",
                other => other.as_str(),
            };
            format!("{} → {task_id} {stage}", s.id)
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// The tasks area is about to send a task's next run (a start from the queue or a continuation), whose message
/// carries every held steer in the order they came. All become that run's: the newest is the tag and the older ones
/// its riders, each tracked by the node with its own receipts.
pub fn take_held(
    db: &crate::hub::store::HubDb,
    task_id: &str,
    thread: &ThreadRef,
    client_request_id: &str,
) -> Option<fleetd_contracts::steer::SteerTag> {
    let mut held = store::held_for_task(db, task_id).ok()?;
    let mut leader = held.pop()?;
    let run_id = NonEmpty::unchecked(Executors::send_run_id(thread, client_request_id));
    leader.run_id = run_id.clone();
    leader.thread = thread.clone();
    leader.detail = None;
    store::bind(db, &leader).ok()?;
    let mut riders = Vec::new();
    for mut rider in held {
        rider.run_id = run_id.clone();
        rider.thread = thread.clone();
        rider.detail = Some(Text::unchecked(format!(
            "sent with {task_id}'s next run, together with {}",
            leader.id
        )));
        if store::ride(db, &rider, &leader.id).is_ok() {
            riders.push(rider.id);
        }
    }
    Some(fleetd_contracts::steer::SteerTag {
        id: leader.id,
        riders,
    })
}

/// The run it was bound to never went out (the machine was away): it and its riders are held again.
pub fn rehold(db: &crate::hub::store::HubDb, id: &SteerId) {
    let riders = store::riders(db, id).unwrap_or_default();
    for steer in std::iter::once(id.clone()).chain(riders.into_iter().map(|r| r.id)) {
        let Ok(Some((mut steer, _))) = store::get(db, &steer) else {
            continue;
        };
        let SteerTarget::Task { task_id } = &steer.target else {
            continue;
        };
        steer.detail = Some(Text::unchecked(format!(
            "queued until {task_id} starts; it gets this with its next run"
        )));
        let _ = store::put(db, &steer, None, None).and_then(|()| store::hold(db, &steer.id, None));
    }
}

fn fail(hub: &Hub, steer: &mut Steer, why: &str) -> Result<(), ToolError> {
    steer.stage = SteerStage::Failed;
    steer.detail = Text::new(js_take(why, 400)).ok();
    store::put(&hub.db, steer, None, None)?;
    emit(hub, steer, HubEventType::SteerFailed, None);
    Ok(())
}

fn rank(stage: SteerStage) -> u8 {
    match stage {
        SteerStage::Queued => 0,
        SteerStage::Delivered => 1,
        _ => 2,
    }
}

/// A node's receipt. Receipts replay after a link drop, so one that does not move the steer forward is ignored.
pub fn on_receipt(hub: &Hub, machine_id: &MachineId, r: &SteerReceipt) {
    let Ok(Some((mut steer, _))) = store::get(&hub.db, &r.steer_id) else {
        return tracing::warn!(steer = %r.steer_id, "a receipt for an unknown steer");
    };
    if steer.thread.machine_id != *machine_id || steer.run_id != r.run_id {
        return tracing::warn!(steer = %r.steer_id, "a receipt from another thread");
    }
    if steer.stage.is_final() || rank(r.stage) <= rank(steer.stage) {
        return;
    }
    // When the hub heard it, so the sweep's grace runs on the hub's own clock.
    let at_ms = Some(now_ms(hub.clock.as_ref()));
    let (mut delivered, mut acked) = (None, None);
    steer.stage = r.stage;
    if steer.seen_at.is_none() {
        steer.seen_at = r.seen_at.clone();
    }
    match r.stage {
        SteerStage::Delivered => {
            steer.delivered_at = Some(r.at.clone());
            steer.how = r.how;
            steer.stopped_tool = r.stopped_tool.clone();
            delivered = at_ms;
        }
        SteerStage::Acknowledged => {
            steer.acked_at = Some(r.at.clone());
            steer.ack_excerpt = r.excerpt.clone();
            acked = at_ms;
        }
        SteerStage::Failed | SteerStage::Expired => {
            steer.detail = r.reason.as_ref().map(|t| Text::unchecked(js_take(t, 400)));
        }
        SteerStage::Unacknowledged | SteerStage::Withdrawn | SteerStage::Queued => {}
    }
    // An acknowledgement that skipped `delivered` (it came first in a replay) still says when. A steer withdrawn,
    // failed or expired was never delivered.
    if steer.delivered_at.is_none()
        && matches!(
            r.stage,
            SteerStage::Acknowledged | SteerStage::Unacknowledged
        )
    {
        steer.delivered_at = Some(r.at.clone());
    }
    if let Err(error) = store::put(&hub.db, &steer, delivered, acked) {
        return tracing::error!(%error, "steer receipt not stored");
    }
    emit(hub, &steer, event_type(r.stage), None);
}

fn event_type(stage: SteerStage) -> HubEventType {
    match stage {
        SteerStage::Queued => HubEventType::SteerQueued,
        SteerStage::Delivered => HubEventType::SteerDelivered,
        SteerStage::Acknowledged => HubEventType::SteerAcknowledged,
        SteerStage::Unacknowledged => HubEventType::SteerUnacknowledged,
        SteerStage::Withdrawn => HubEventType::SteerWithdrawn,
        SteerStage::Failed | SteerStage::Expired => HubEventType::SteerFailed,
    }
}

fn target_name(steer: &Steer) -> String {
    match &steer.target {
        SteerTarget::Lead { workstream_id } => format!("the lead of {workstream_id}"),
        SteerTarget::Task { task_id } => task_id.to_string(),
    }
}

fn summary(steer: &Steer) -> String {
    let to = target_name(steer);
    let id = &steer.id;
    match steer.stage {
        SteerStage::Queued => format!("{id} to {to}: '{}'", one_line(&steer.text, 120)),
        SteerStage::Delivered => match (&steer.how, &steer.stopped_tool) {
            (Some(fleetd_contracts::steer::DeliveredHow::Stopped), Some(tool)) => {
                format!("{id} reached {to}: it stopped `{}`", one_line(tool, 80))
            }
            _ => format!("{id} reached {to}"),
        },
        SteerStage::Acknowledged => format!("{to} acknowledged {id}"),
        SteerStage::Unacknowledged => format!("{to} did not acknowledge {id}"),
        SteerStage::Withdrawn => format!("{id} to {to} withdrawn"),
        SteerStage::Failed => format!("{id} to {to} failed"),
        SteerStage::Expired => format!("{id} to {to} expired undelivered"),
    }
}

fn emit(hub: &Hub, steer: &Steer, kind: HubEventType, extra: Option<serde_json::Value>) {
    let queued = kind == HubEventType::SteerQueued;
    let data = SteerEventData {
        steer_id: steer.id.clone(),
        workstream_id: steer.workstream_id.clone(),
        task_id: match &steer.target {
            SteerTarget::Task { task_id } => Some(task_id.clone()),
            SteerTarget::Lead { .. } => None,
        },
        stage: steer.stage,
        how: steer.how,
        excerpt: steer.ack_excerpt.clone(),
        text: queued.then(|| js_take(&steer.text, 120).to_owned()),
        mode: queued.then_some(steer.mode),
        by: queued.then(|| steer.by.clone()),
        reason: steer
            .detail
            .as_ref()
            .filter(|_| kind == HubEventType::SteerFailed)
            .map(|r| r.to_string()),
    };
    let mut data = serde_json::to_value(data).unwrap_or_default();
    if let (Some(extra), Some(map)) = (extra, data.as_object_mut()) {
        map.extend(extra.as_object().cloned().unwrap_or_default());
    }
    let event = NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: kind,
        machine_id: Some(steer.thread.machine_id.clone()),
        project_id: None,
        thread_id: Some(steer.thread.thread_id.clone()),
        summary: js_take(&summary(steer), 200).to_owned(),
        data: Some(data),
        attention: None,
    };
    if let Err(error) = hub.events.append(event) {
        tracing::error!(%error, "steer event append failed");
    }
}

/// Withdraws a steer still queued: from the hub's offline queue, or from claude's own queue. Only its sender may.
pub async fn withdraw(hub: &Hub, caller: &Caller, id: &SteerId) -> Result<Steer, ToolError> {
    let (mut steer, by) = store::get(&hub.db, id)?
        .filter(|(s, _)| allows(caller, Role::Read, Some(&s.thread.machine_id)))
        .ok_or_else(|| not_found(&format!("steer {id}")))?;
    if by != format!("key:{}", caller.key_id) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            format!("{id} was sent from another device; only its sender can withdraw it."),
        ));
    }
    let taken = |steer: &Steer| {
        let when = steer
            .delivered_at
            .as_ref()
            .map(|t| format!(" at {}", &t.as_str()[11..19.min(t.as_str().len())]));
        invalid(format!(
            "{id} was already delivered{}.",
            when.unwrap_or_default()
        ))
        .with_fix("Once delivered it cannot be unsaid; send another steer saying what changed.")
    };
    match steer.stage {
        SteerStage::Withdrawn => return Ok(steer),
        SteerStage::Queued => {}
        SteerStage::Failed | SteerStage::Expired => {
            return Err(invalid(format!(
                "{id} never reached the agent; there is nothing to withdraw."
            )));
        }
        _ => return Err(taken(&steer)),
    }
    // Held for a task's next run: take its text back out of the task's pending message.
    if let Some(message) = store::held_message(&hub.db, id)?
        && let SteerTarget::Task { task_id } = &steer.target
    {
        if !hub.tasks.take_back(task_id, &message).await? {
            return Err(taken(&steer));
        }
        store::unhold(&hub.db, id)?;
        steer.stage = SteerStage::Withdrawn;
        steer.detail = None;
        store::put(&hub.db, &steer, None, None)?;
        emit(hub, &steer, HubEventType::SteerWithdrawn, None);
        return Ok(steer);
    }
    let dropped = hub.queue.withdraw_steer(id)
        || hub
            .executors
            .withdraw(&steer.thread, steer.run_id.as_str())
            .await
            .map_err(|e| ToolError::new(ErrorCode::Failed, e.to_string()))?;
    if !dropped {
        // The node's delivered receipt may not be here yet.
        let now = store::get(&hub.db, id)?.map_or(steer, |(s, _)| s);
        return Err(taken(&now));
    }
    if let Some((now, _)) = store::get(&hub.db, id)?
        && now.stage == SteerStage::Withdrawn
    {
        return Ok(now);
    }
    steer.stage = SteerStage::Withdrawn;
    store::put(&hub.db, &steer, None, None)?;
    emit(hub, &steer, HubEventType::SteerWithdrawn, None);
    Ok(steer)
}

/// How long a steer may wait for its next receipt on a thread that is no longer running.
pub const RECEIPT_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// Closes steers whose receipt can no longer come: their thread stopped running at least [`RECEIPT_GRACE`] ago
/// without one, because the node restarted (its tracking is in memory) or is older than this hub. A steer still in
/// the hub's offline queue is left to the queue's own expiry. Returns how many it closed.
pub fn sweep(hub: &Hub) -> usize {
    let now = now_ms(hub.clock.as_ref());
    let Ok(open) = store::open(&hub.db) else {
        return 0;
    };
    let mut closed = 0;
    for (mut steer, since) in open {
        if now - since < RECEIPT_GRACE.as_millis() as i64 || hub.queue.has_steer(&steer.id) {
            continue;
        }
        let status = hub
            .store
            .thread_get(&steer.thread)
            .ok()
            .flatten()
            .map(|t| t.thread.status);
        if matches!(
            status,
            Some(
                fleetd_contracts::model::ThreadStatus::Running
                    | fleetd_contracts::model::ThreadStatus::Waiting
            )
        ) {
            continue;
        }
        let machine = &steer.thread.machine_id;
        let (stage, why) = if steer.stage == SteerStage::Delivered {
            (
                SteerStage::Unacknowledged,
                format!(
                    "no reply came back from {machine}: its node restarted, or is older than this hub"
                ),
            )
        } else {
            (
                SteerStage::Failed,
                format!(
                    "{machine}'s node lost it before the agent took it in: it restarted, or is older than this hub"
                ),
            )
        };
        steer.stage = stage;
        steer.detail = Some(Text::unchecked(why));
        if store::put(&hub.db, &steer, None, None).is_ok() {
            emit(hub, &steer, event_type(stage), None);
            closed += 1;
        }
    }
    closed
}

/// [`sweep`] once a minute.
pub async fn run_sweep(hub: Arc<Hub>) {
    loop {
        hub.clock.sleep(std::time::Duration::from_secs(60)).await;
        let closed = sweep(&hub);
        if closed > 0 {
            tracing::info!(closed, "steers closed without a final receipt");
        }
    }
}

struct Sink(Weak<Hub>);

impl crate::hub::executor::SteerSink for Sink {
    fn receipt(&self, machine_id: &MachineId, receipt: &SteerReceipt) {
        if let Some(hub) = self.0.upgrade() {
            on_receipt(&hub, machine_id, receipt);
        }
    }
}

/// `fleetd task message T88 "<text>" [--now]`: the lead steers its own task, with the same modes and receipts.
struct TaskMessage(Weak<Hub>);

impl crate::hub::link::lead_calls::LeadCallHandler for TaskMessage {
    fn handle(
        &self,
        caller: crate::hub::link::lead_calls::LeadCaller,
        call: fleetd_contracts::lead_calls::LeadCall,
    ) -> crate::hub::link::lead_calls::LeadCallFuture {
        let hub = self.0.clone();
        Box::pin(async move {
            let hub = hub
                .upgrade()
                .ok_or_else(|| ToolError::new(ErrorCode::Failed, "the hub is stopping"))?;
            let fleetd_contracts::lead_calls::LeadCall::TaskMessage(c) = call else {
                return Err(invalid("Not a task message."));
            };
            let crid = format!("{:032x}", rand::random::<u128>());
            let steer = send(
                &hub,
                By::Lead(&caller.project_ref),
                SteerRequest {
                    target: SteerTarget::Task {
                        task_id: c.task_id.clone(),
                    },
                    text: c.message.as_str(),
                    mode: if c.now {
                        SteerMode::Now
                    } else {
                        SteerMode::Queue
                    },
                    refs: vec![],
                    attached: vec![],
                    client_request_id: &crid,
                },
            )
            .await?;
            let task = hub
                .tasks
                .get(&c.task_id)?
                .ok_or_else(|| not_found(&format!("task {}", c.task_id)))?;
            Ok(fleetd_contracts::lead_calls::LeadCallResult::TaskMessage(
                fleetd_contracts::lead_calls::TaskResultFrame {
                    task,
                    next: Some(format!(
                        "{} {}: its next reply acknowledges it.",
                        steer.id,
                        steer.detail.as_deref().unwrap_or("sent")
                    )),
                    steer_id: Some(steer.id),
                },
            ))
        })
    }
}

/// Receipts from the node and expiries from the offline queue reach the steers; the lead's `task message` goes
/// through them.
pub fn wire(hub: &Arc<Hub>) {
    hub.lead_calls
        .register("task_message", Arc::new(TaskMessage(Arc::downgrade(hub))));
    hub.executors
        .set_steer_sink(Arc::new(Sink(Arc::downgrade(hub))));
    let weak = Arc::downgrade(hub);
    hub.queue.on_steer_expired(Arc::new(move |id, reason| {
        let Some(hub) = weak.upgrade() else {
            return;
        };
        let Ok(Some((mut steer, _))) = store::get(&hub.db, id) else {
            return;
        };
        if steer.stage.is_final() {
            return;
        }
        steer.stage = if reason == "ttl" {
            SteerStage::Expired
        } else {
            SteerStage::Failed
        };
        steer.detail = Some(Text::unchecked(match reason {
            "ttl" => format!(
                "{} stayed offline past the queue's limit",
                steer.thread.machine_id
            ),
            _ => "the node refused it".to_owned(),
        }));
        if store::put(&hub.db, &steer, None, None).is_ok() {
            emit(&hub, &steer, HubEventType::SteerFailed, None);
        }
    }));
}

#[cfg(test)]
mod tests;
