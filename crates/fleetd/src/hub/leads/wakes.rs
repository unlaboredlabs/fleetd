//! Wakes to a lead: triggers for one lead are debounced and coalesced into a single message: the code-rendered
//! digest, then one event line per trigger (`events`).
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{LeadState, WorkstreamId, WorkstreamState};

use super::digest::{DigestInput, WorkstreamFacts, idle_line, render_lead_digest};
use super::error::LeadError;
use super::events::Event;
use super::hooks::BoxFuture;
use super::lead::Leads;
use super::records::{LeadRecords, WorkstreamFilter};
use super::{Ctx, now_iso};
use crate::clock::Clock;
use crate::hub::prompts::PromptSet;
use crate::hub::store::{NewEvent, now_ms};

pub const WAKE_DEBOUNCE: Duration = Duration::from_secs(10);
/// A steady trigger stream still wakes the lead this long after the first pending trigger.
pub const WAKE_MAX_WAIT: Duration = Duration::from_secs(60);
/// How long a wake that skips the debounce still waits for what comes right behind it: a batch's PRs merge seconds
/// apart, and a train merge lands seconds after its review's result.
pub const WAKE_COALESCE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    TaskResult,
    TaskWaiting,
    Train,
    /// A person's words for the lead about an order (a steer, a stop).
    Human,
    /// A person raised the project's max agents (`tasks::cap`).
    CapRaised,
    /// A secret or approval request settled, or came back open (`approvals`).
    Request,
    /// fleetd resumed a dead task, or one waits for its offline machine (`tasks::recovery`): nothing for the lead to
    /// decide, so it never wakes the lead. It rides along with the next wake.
    Recovery,
    /// Agents on a machine kept dying, so fleetd stopped resuming them there (`tasks::breaker`).
    RecoveryPaused,
    /// A finished task's PR, found after its result line went out (D67): rides along with the next wake too.
    Quiet,
    /// The lead's own turn was cut off by its node stopping or restarting (`cut_off`): it carries on.
    CutOff,
    /// Work a Navi asked another project for opened, closed, merged or failed (hub/navi/bridge.rs).
    Factory,
}

#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "a few triggers per lead, held for seconds"
)]
pub enum Trigger {
    Intent {
        workstream_id: WorkstreamId,
        text: String,
    },
    /// A task ended, a task waits on input, a train event: the area
    /// that raises it renders its own "why" line(s).
    Line { kind: LineKind, text: String },
}

impl Trigger {
    /// M7 merge train: a merge, or a PR the train refused or gave up on, as its event line.
    pub fn train(line: &str) -> Self {
        Trigger::Line {
            kind: LineKind::Train,
            text: line.to_owned(),
        }
    }

    /// A merge or other train outcome, or a task's result (a finished agent, a review verdict): what an idle lead
    /// waits on to take its next step, so it goes after WAKE_COALESCE instead of the quiet window
    /// ([`LeadWakes::trigger`]).
    pub fn skips_debounce(&self) -> bool {
        matches!(
            self,
            Trigger::Line {
                kind: LineKind::TaskResult | LineKind::Train,
                ..
            }
        )
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Trigger::Intent { .. } => "intent",
            Trigger::Line { kind, .. } => match kind {
                LineKind::TaskResult => "task_result",
                LineKind::TaskWaiting => "task_waiting",
                LineKind::Train => "train",
                LineKind::Human => "human",
                LineKind::CapRaised => "cap_raised",
                LineKind::Request => "request",
                LineKind::Recovery => "recovery",
                LineKind::RecoveryPaused => "recovery_paused",
                LineKind::Quiet => "quiet",
                LineKind::CutOff => "cut_off",
                LineKind::Factory => "factory",
            },
        }
    }

    /// Never wakes the lead alone ([`LineKind::Recovery`], [`LineKind::Quiet`]).
    pub fn quiet(&self) -> bool {
        matches!(
            self,
            Trigger::Line {
                kind: LineKind::Recovery | LineKind::Quiet,
                ..
            }
        )
    }
}

/// The longest order said in one line, as `Event::Order` quotes it.
const ORDER_LINE: usize = 300;

/// One event line per trigger, in the order they came.
pub fn trigger_lines(triggers: &[Trigger]) -> Vec<String> {
    triggers
        .iter()
        .map(|t| match t {
            Trigger::Intent {
                workstream_id,
                text,
            } if text.contains('\n') || text.chars().count() > ORDER_LINE => {
                // An order that says more than a line (an automation's prompt, trigger and body) goes in whole: the
                // one line would cut it.
                let body: Vec<String> = text
                    .trim()
                    .lines()
                    .map(|l| format!("  {l}").trim_end().to_owned())
                    .collect();
                format!("- new order {workstream_id}, in full:\n{}", body.join("\n"))
            }
            Trigger::Intent {
                workstream_id,
                text,
            } => Event::Order {
                workstream: workstream_id.as_str(),
                text,
            }
            .render(),
            Trigger::Line { text, .. } => text.clone(),
        })
        .collect()
}

pub fn render_wake(set: &PromptSet, digest: &str, triggers: &[Trigger]) -> String {
    set.render(
        "lead.wake",
        &[
            ("state", &digest),
            ("events", &trigger_lines(triggers).join("\n")),
        ],
    )
}

/// Coalesces items per key: a key flushes once no new item arrived for `debounce`, or `max_wait` after its first
/// pending item, or `coalesce` after an item pushed with `now` unless the key flushed within `debounce`. Timers are
/// never cancelled: a superseded one wakes, sees a newer generation and does nothing. Taking the entry out is under the
/// same lock as that check and as `push`, so an item lands in exactly one flush, and a `now` item that comes while the
/// last flush is still in flight waits out the window like any other.
pub struct Debouncer<K, T> {
    clock: Arc<dyn Clock>,
    debounce_ms: i64,
    max_wait_ms: i64,
    coalesce_ms: i64,
    keys: Mutex<Keys<K, T>>,
    next_entry: AtomicU64,
}

struct Keys<K, T> {
    pending: HashMap<K, Pending<T>>,
    /// When each key last flushed.
    flushed_ms: HashMap<K, i64>,
}

struct Pending<T> {
    entry: u64,
    items: Vec<T>,
    generation: u64,
    first_ms: i64,
    /// Set by the first item that may skip the quiet window: the flush goes then, fixed, so the items right behind
    /// it ride along without pushing it later.
    now_at_ms: Option<i64>,
}

impl<K: Clone + Eq + Hash + Send + 'static, T: Send + 'static> Debouncer<K, T> {
    pub fn new(
        clock: Arc<dyn Clock>,
        debounce: Duration,
        max_wait: Duration,
        coalesce: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            clock,
            debounce_ms: debounce.as_millis() as i64,
            max_wait_ms: max_wait.as_millis() as i64,
            coalesce_ms: coalesce.as_millis() as i64,
            keys: Mutex::new(Keys {
                pending: HashMap::new(),
                flushed_ms: HashMap::new(),
            }),
            next_entry: AtomicU64::new(0),
        })
    }

    /// Queues `item`; `flush` runs with every pending item of `key` when its window closes, or `coalesce` after a
    /// `now` item when the key has not flushed within the debounce.
    pub fn push<F>(self: &Arc<Self>, key: K, item: T, now: bool, flush: F)
    where
        F: FnOnce(K, Vec<T>) -> BoxFuture<()> + Send + 'static,
    {
        let at = now_ms(self.clock.as_ref());
        let (entry, generation, delay_ms) = {
            let mut keys = self.keys.lock().unwrap();
            let quiet = keys
                .flushed_ms
                .get(&key)
                .is_none_or(|last| at - last >= self.debounce_ms);
            let p = keys.pending.entry(key.clone()).or_insert_with(|| Pending {
                entry: self.next_entry.fetch_add(1, Ordering::Relaxed),
                items: Vec::new(),
                generation: 0,
                first_ms: at,
                now_at_ms: None,
            });
            p.items.push(item);
            p.generation += 1;
            if now && quiet && p.now_at_ms.is_none() {
                p.now_at_ms = Some(at + self.coalesce_ms);
            }
            // The quiet window, cut short so the latest timer never sleeps past the max-wait deadline.
            let due = p.now_at_ms.unwrap_or(at + self.debounce_ms);
            let delay = (due.min(p.first_ms + self.max_wait_ms) - at).max(0);
            (p.entry, p.generation, delay)
        };
        // The deadline is taken now, not when the task first runs.
        let sleep = self.clock.sleep(Duration::from_millis(delay_ms as u64));
        let this = Arc::clone(self);
        tokio::spawn(async move {
            sleep.await;
            let items = {
                let mut keys = this.keys.lock().unwrap();
                match keys.pending.get(&key) {
                    Some(p) if p.entry == entry && p.generation == generation => {
                        let flushed = now_ms(this.clock.as_ref());
                        keys.flushed_ms.insert(key.clone(), flushed);
                        keys.pending.remove(&key).map(|p| p.items)
                    }
                    _ => None,
                }
            };
            if let Some(items) = items {
                flush(key, items).await;
            }
        });
    }
}

impl<K: Clone + Eq + Hash + Send + 'static, T: Send + 'static> Debouncer<K, T> {
    /// Adds `item` to the flush already pending for `key`, without moving its time; hands it back when none is.
    pub fn join(&self, key: &K, item: T) -> Option<T> {
        match self.keys.lock().unwrap().pending.get_mut(key) {
            Some(p) => {
                p.items.push(item);
                None
            }
            None => Some(item),
        }
    }

    /// Whether items for `key` wait for their window to close.
    pub fn has_pending(&self, key: &K) -> bool {
        self.keys.lock().unwrap().pending.contains_key(key)
    }
}

/// The orders a wake serves: an intent's, and any `W<n>` a line names or whose task `T<n>` it
/// names. The time inspector splits the lead's turn equally over them.
fn trigger_workstreams(
    triggers: &[Trigger],
    task_order: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    static ID: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = ID.get_or_init(|| regex::Regex::new(r"\b[WT][1-9][0-9]*\b").expect("pattern"));
    let mut out: Vec<String> = Vec::new();
    for t in triggers {
        let found: Vec<String> = match t {
            Trigger::Intent { workstream_id, .. } => vec![workstream_id.to_string()],
            Trigger::Line { text, .. } => re
                .find_iter(text)
                .filter_map(|m| match m.as_str() {
                    t if t.starts_with('T') => task_order(t),
                    w => Some(w.to_owned()),
                })
                .collect(),
        };
        for w in found {
            if !out.contains(&w) {
                out.push(w);
            }
        }
    }
    out
}

fn key_of(r: &ProjectRef) -> String {
    format!("{}/{}", r.machine_id, r.project_id)
}

/// A wake's request id, which names its run on the node (`Executors::send_run_id`): `at` is the wake's
/// `last_wake_at`, so a reader of the lead's record knows the run its latest wake started.
pub fn wake_request_id(r: &ProjectRef, session_generation: i64, at: &str) -> String {
    format!("fleetd-wake:{}:{session_generation}:{at}", key_of(r))
}

pub struct LeadWakes {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    debouncer: Arc<Debouncer<ProjectRef, Trigger>>,
    flushing: tokio::sync::Mutex<()>,
    /// When the pending wake's first trigger came, per project: `lead.woken.firstTriggerAt`, so the time inspector
    /// sees the debounce. Kept through a usage hold, which re-triggers.
    first: std::sync::Mutex<HashMap<ProjectRef, String>>,
    /// Quiet lines that came while no wake was on its way, per project: they go first in the next one. Lost on a
    /// hub restart; the digest still shows the tasks' state.
    quiet: std::sync::Mutex<HashMap<ProjectRef, Vec<Trigger>>>,
    /// The idle stretch (when its slots last moved) whose idle line the project's lead was shown: one line per
    /// stretch, not one per wake. Lost on a hub restart, which starts a new stretch anyway.
    idle_shown: std::sync::Mutex<HashMap<ProjectRef, i64>>,
    /// Set once by `Area::new`: a wake to a cold lead, or to one whose MCP servers changed, starts a fresh session
    /// (`Leads::fresh_if_due`).
    pub leads: OnceLock<Weak<Leads>>,
}

impl LeadWakes {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>) -> Arc<Self> {
        let debouncer = Debouncer::new(
            Arc::clone(&ctx.clock),
            WAKE_DEBOUNCE,
            WAKE_MAX_WAIT,
            WAKE_COALESCE,
        );
        Arc::new(Self {
            ctx,
            records,
            debouncer,
            flushing: tokio::sync::Mutex::new(()),
            first: std::sync::Mutex::new(HashMap::new()),
            quiet: std::sync::Mutex::new(HashMap::new()),
            idle_shown: std::sync::Mutex::new(HashMap::new()),
            leads: OnceLock::new(),
        })
    }

    /// Queues a trigger; the lead is woken once no new trigger has arrived for WAKE_DEBOUNCE, or WAKE_MAX_WAIT after
    /// the first. One the lead waits on ([`Trigger::skips_debounce`]) goes WAKE_COALESCE after it, with whatever is
    /// pending or comes in that time, when the lead is idle and was not woken within WAKE_DEBOUNCE: the long window only
    /// pays off by batching a burst into one turn, and while the lead is busy (or a wake is still on its way) triggers
    /// coalesce as before.
    pub fn trigger(self: &Arc<Self>, r: &ProjectRef, trigger: Trigger) {
        if trigger.quiet() {
            if let Some(held) = self.debouncer.join(r, trigger) {
                self.quiet
                    .lock()
                    .unwrap()
                    .entry(r.clone())
                    .or_default()
                    .push(held);
            }
            return;
        }
        self.first_trigger(r);
        let now = trigger.skips_debounce() && self.lead_idle(r);
        let this = Arc::clone(self);
        self.debouncer
            .push(r.clone(), trigger, now, move |r, triggers| {
                Box::pin(async move { this.flush(r, triggers).await })
            });
    }

    /// The lead's thread is idle as the store last saw it: not mid-turn, not waiting on a person, not starting.
    fn lead_idle(&self, r: &ProjectRef) -> bool {
        let Ok(Some(lead)) = self.records.lead_get(r) else {
            return false;
        };
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id,
        };
        let thread = self.ctx.store.thread_get(&thread).ok().flatten();
        super::lead::lead_state(thread.map(|t| t.thread).as_ref(), false) == LeadState::Idle
    }

    /// Whether a wake for the project's lead is already on its way (triggers waiting out the debounce).
    pub fn pending(&self, r: &ProjectRef) -> bool {
        self.debouncer.has_pending(r)
    }

    /// The quiet lines held for the project's next wake.
    pub fn held(&self, r: &ProjectRef) -> Vec<String> {
        self.quiet
            .lock()
            .unwrap()
            .get(r)
            .map(|t| trigger_lines(t))
            .unwrap_or_default()
    }

    /// The lead digest as of now: the state block at the top of its first message and of every wake.
    pub async fn digest(&self, r: &ProjectRef) -> Result<String, LeadError> {
        Ok(self.digest_to_send(r).await?.0)
    }

    /// The idle line of stretch `since` reached the lead: later digests leave it out until the next stretch.
    pub(super) fn idle_sent(&self, r: &ProjectRef, since: Option<i64>) {
        if let Some(since) = since {
            self.idle_shown.lock().unwrap().insert(r.clone(), since);
        }
    }

    /// The digest, and the idle stretch whose line it carries: the sender passes that to `idle_sent` once the
    /// message is out, so a wake that never went doesn't use up the line.
    pub(super) async fn digest_to_send(
        &self,
        r: &ProjectRef,
    ) -> Result<(String, Option<i64>), LeadError> {
        let ctx = &self.ctx;
        let project = ctx.store.project_get(r)?;
        let workstreams = self.records.workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            state: Some(WorkstreamState::Open),
            limit: 50,
        })?;
        let since = self.records.lead_get(r)?.and_then(|l| l.last_wake_at);
        let open_requests = ctx.ports().open_requests(Some(r), 50)?;
        // Global, project and every workstream-scoped decision in the project; the digest ranks them.
        let decisions = ctx.ports().decisions_in_project(r, 500)?;
        let tasks = ctx
            .hooks
            .tasks
            .get()
            .map(|t| t.digest_lines(r, since.as_ref(), 50));
        let agents = ctx.hooks.tasks.get().map(|t| t.agents(r));
        let usage = ctx.hooks.usage_gate(r);
        let train = ctx.hooks.train_lines(r, since.as_ref());
        let elsewhere = ctx.hooks.elsewhere(r);
        let idle = agents.as_ref().and_then(|a| {
            let line = idle_line(a, &workstreams, &open_requests, usage.is_some())?;
            let shown = self.idle_shown.lock().unwrap().get(r) == Some(&a.idle_since_ms);
            (!shown).then_some((line, a.idle_since_ms))
        });
        let (idle, idle_since) = idle.unzip();
        let facts = self.workstream_facts(&workstreams);
        let at = now_iso(ctx);
        let text = render_lead_digest(&DigestInput {
            project_ref: r,
            title: project
                .as_ref()
                .map_or(r.project_id.as_str(), |p| p.title.as_str()),
            at: &at,
            workstreams: &workstreams,
            open_requests: &open_requests,
            decisions: &decisions,
            agents,
            idle,
            usage,
            tasks,
            train,
            elsewhere,
            checklist: crate::hub::checklist::digest_lines(&ctx.db, r),
            facts: &facts,
        });
        Ok((text, idle_since))
    }

    /// Per workstream with a brief: its steers and plan figure.
    pub fn workstream_facts(
        &self,
        workstreams: &[fleetd_contracts::ledger::Workstream],
    ) -> HashMap<WorkstreamId, WorkstreamFacts> {
        let mut facts = HashMap::new();
        for w in workstreams.iter().filter(|w| w.brief.is_some()) {
            let steers = crate::hub::steer::digest_line(&self.ctx.db, &w.workstream_id);
            facts.insert(w.workstream_id.clone(), WorkstreamFacts { steers });
        }
        facts
    }

    fn first_trigger(&self, r: &ProjectRef) {
        self.first
            .lock()
            .unwrap()
            .entry(r.clone())
            .or_insert_with(|| now_iso(&self.ctx));
    }

    async fn flush(self: Arc<Self>, r: ProjectRef, triggers: Vec<Trigger>) {
        let _guard = self.flushing.lock().await;
        // Held quiet lines came before every trigger here: one that comes while a wake is pending joins it.
        let held = self.quiet.lock().unwrap().remove(&r).unwrap_or_default();
        let triggers = held.into_iter().chain(triggers).collect();
        if let Err(error) = self.flush_inner(&r, triggers).await {
            tracing::warn!(project = %key_of(&r), %error, "lead wake failed");
        }
    }

    async fn flush_inner(
        self: &Arc<Self>,
        r: &ProjectRef,
        triggers: Vec<Trigger>,
    ) -> Result<(), LeadError> {
        if let Err(archived) = super::lead::refuse_archived(&self.ctx.db, r) {
            tracing::info!(project = %key_of(r), reason = %archived.message, "lead wake dropped");
            return Ok(());
        }
        let Some(lead) = self.records.lead_get(r)? else {
            // No lead yet: its first message carries the digest, which shows the same state.
            tracing::info!(project = %key_of(r), triggers = triggers.len(), "lead wake dropped: project has no lead");
            return Ok(());
        };
        // An archived Navi's lead takes no turns; the digest at its next start shows the same state.
        if self
            .ctx
            .store
            .project_get(r)?
            .is_some_and(|p| p.archived_at.is_some())
        {
            tracing::info!(project = %key_of(r), triggers = triggers.len(), "lead wake dropped: the Navi is archived");
            return Ok(());
        }
        // The lead's first message carried a digest listing every intent made before it started; a wake would say it
        // twice. Strictly earlier: one made in the same millisecond may have missed the digest.
        let triggers: Vec<Trigger> = triggers
            .into_iter()
            .filter(|t| match t {
                Trigger::Intent { workstream_id, .. } => self
                    .records
                    .workstream_get(workstream_id)
                    .ok()
                    .flatten()
                    .is_none_or(|w| w.created_at.as_str() >= lead.started_at.as_str()),
                _ => true,
            })
            .collect();
        if triggers.is_empty() {
            return Ok(());
        }
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id.clone(),
        };
        // M4 usage: a wake is a turn, so it waits while the login is paused or the lead is parked, then goes again.
        if self.ctx.hooks.usage_hold(&thread).is_some() {
            let clear = self.ctx.hooks.when_clear(&thread);
            let this = Arc::clone(self);
            let r = r.clone();
            tokio::spawn(async move {
                clear.await;
                for t in triggers {
                    this.trigger(&r, t);
                }
            });
            return Ok(());
        }
        let set = self
            .ctx
            .db
            .prompts()
            .for_thread(&r.machine_id, lead.thread_id.as_str());
        // A lead due a fresh session gets its events in the first message of a fresh session, which carries the state block itself.
        let fresh = match self.leads.get().and_then(Weak::upgrade) {
            Some(leads) => leads
                .fresh_if_due(
                    r,
                    &render_wake(&self.ctx.db.prompts().current(Some(r)), "", &triggers),
                )
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!(project = %key_of(r), %error, "fresh lead not started; resuming it");
                    None
                }),
            None => None,
        };
        let at = now_iso(&self.ctx);
        let fresh = match fresh {
            Some(_) => self.records.lead_get(r)?,
            None => None,
        };
        let (lead, queued) = match fresh {
            Some(fresh) => (fresh, false),
            None => {
                let (digest, idle) = self.digest_to_send(r).await?;
                let message = render_wake(&set, &digest, &triggers);
                let crid = wake_request_id(r, lead.session_generation, &at);
                // Through the offline write queue, so a wake to an offline machine waits for it instead of being dropped.
                match self.ctx.ports().send(thread, message, crid).await {
                    Ok(queued) => {
                        self.idle_sent(r, idle);
                        (lead, queued)
                    }
                    Err(reason) => {
                        tracing::warn!(project = %key_of(r), %reason, "lead wake not delivered");
                        return Ok(());
                    }
                }
            }
        };
        let n = triggers.len();
        self.records.lead_put(&super::records::StoredLead {
            last_wake_at: Some(at.clone().into()),
            ..lead.clone()
        })?;
        let first = self
            .first
            .lock()
            .unwrap()
            .remove(r)
            .unwrap_or_else(|| at.clone());
        let mut data = serde_json::json!({
            "triggers": triggers.iter().map(Trigger::kind).collect::<Vec<_>>(),
            "firstTriggerAt": first,
            "workstreamIds": trigger_workstreams(&triggers, |t| {
                let n = t[1..].parse::<i64>().ok()?;
                self.ctx
                    .db
                    .with(|c| {
                        Ok(rusqlite::OptionalExtension::optional(c.query_row(
                            "SELECT workstream_id FROM tasks WHERE n = ?1",
                            [n],
                            |r| r.get::<_, String>(0),
                        ))?)
                    })
                    .ok()
                    .flatten()
            }),
        });
        if queued {
            data["queued"] = serde_json::Value::Bool(true);
        }
        self.ctx.events.append(NewEvent {
            at: at.into(),
            r#type: HubEventType::LeadWoken,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: Some(lead.thread_id),
            summary: format!(
                "Lead of {} {} with {n} trigger{}",
                r.project_id,
                if queued { "wake queued" } else { "woken" },
                if n == 1 { "" } else { "s" }
            ),
            data: Some(data),
            attention: None,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::test_clock::ManualClock;

    type Flushes = Arc<Mutex<Vec<(u32, Vec<u32>, u64)>>>;

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn push(
        d: &Arc<Debouncer<u32, u32>>,
        clock: &Arc<ManualClock>,
        flushes: &Flushes,
        key: u32,
        item: u32,
    ) {
        push_now(d, clock, flushes, key, item, false);
    }

    fn push_now(
        d: &Arc<Debouncer<u32, u32>>,
        clock: &Arc<ManualClock>,
        flushes: &Flushes,
        key: u32,
        item: u32,
        now: bool,
    ) {
        let flushes = Arc::clone(flushes);
        let clock = Arc::clone(clock);
        d.push(key, item, now, move |key, items| {
            Box::pin(async move {
                flushes
                    .lock()
                    .unwrap()
                    .push((key, items, now_ms(clock.as_ref()) as u64))
            })
        });
    }

    async fn advance(clock: &ManualClock, secs: u64) {
        clock.advance(Duration::from_secs(secs));
        settle().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn coalesces_into_one_flush_ten_seconds_after_the_last_trigger() {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT, WAKE_COALESCE);
        let flushes: Flushes = Default::default();
        push(&d, &clock, &flushes, 1, 1);
        advance(&clock, 5).await;
        push(&d, &clock, &flushes, 1, 2);
        advance(&clock, 9).await;
        push(&d, &clock, &flushes, 1, 3);
        advance(&clock, 9).await;
        assert!(flushes.lock().unwrap().is_empty());
        advance(&clock, 1).await;
        assert_eq!(*flushes.lock().unwrap(), vec![(1, vec![1, 2, 3], 24_000)]);
        // Quiet afterwards: nothing flushes again.
        advance(&clock, 60).await;
        assert_eq!(flushes.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn flushes_sixty_seconds_after_the_first_trigger_under_a_steady_stream_then_opens_a_fresh_window()
     {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT, WAKE_COALESCE);
        let flushes: Flushes = Default::default();
        // A trigger every 8 s never leaves a 10 s quiet window.
        for i in 1..=7 {
            push(&d, &clock, &flushes, 1, i);
            advance(&clock, 8).await;
        }
        assert!(flushes.lock().unwrap().is_empty());
        push(&d, &clock, &flushes, 1, 8);
        advance(&clock, 3).await;
        assert!(flushes.lock().unwrap().is_empty());
        advance(&clock, 1).await;
        assert_eq!(
            *flushes.lock().unwrap(),
            vec![(1, (1..=8).collect(), 60_000)]
        );

        // The next trigger opens a new window measured from itself.
        push(&d, &clock, &flushes, 1, 9);
        advance(&clock, 9).await;
        assert_eq!(flushes.lock().unwrap().len(), 1);
        advance(&clock, 1).await;
        assert_eq!(flushes.lock().unwrap()[1], (1, vec![9], 70_000));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_now_item_flushes_soon_with_what_comes_by_then_unless_the_key_just_flushed() {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT, WAKE_COALESCE);
        let flushes: Flushes = Default::default();
        push(&d, &clock, &flushes, 1, 1);
        advance(&clock, 3).await;
        // Due WAKE_COALESCE after it, with the item already waiting and those that come by then (a batch's second
        // merge, the result behind it), none of which moves the flush later.
        push_now(&d, &clock, &flushes, 1, 2, true);
        advance(&clock, 2).await;
        push_now(&d, &clock, &flushes, 1, 3, true);
        advance(&clock, 2).await;
        push(&d, &clock, &flushes, 1, 4);
        settle().await;
        assert!(flushes.lock().unwrap().is_empty());
        advance(&clock, 1).await;
        assert_eq!(*flushes.lock().unwrap(), vec![(1, vec![1, 2, 3, 4], 8_000)]);

        // Within the debounce of that flush (its wake may still be on its way), a now item and an item behind it
        // coalesce in the quiet window as before: one more flush, never one per item.
        advance(&clock, 1).await;
        push_now(&d, &clock, &flushes, 1, 5, true);
        push(&d, &clock, &flushes, 1, 6);
        advance(&clock, 9).await;
        assert_eq!(flushes.lock().unwrap().len(), 1);
        advance(&clock, 1).await;
        assert_eq!(flushes.lock().unwrap()[1], (1, vec![5, 6], 19_000));

        // Quiet for the debounce since: the short window again. Another key's flush doesn't count.
        push_now(&d, &clock, &flushes, 2, 7, true);
        advance(&clock, 5).await;
        assert_eq!(flushes.lock().unwrap()[2], (2, vec![7], 24_000));
        advance(&clock, 5).await;
        push_now(&d, &clock, &flushes, 1, 8, true);
        advance(&clock, 5).await;
        assert_eq!(flushes.lock().unwrap()[3], (1, vec![8], 34_000));
        assert_eq!(flushes.lock().unwrap().len(), 4);
    }

    /// A quiet item rides along with a pending flush, never moving it, and starts none on its own.
    #[tokio::test(flavor = "current_thread")]
    async fn a_joined_item_rides_along_and_starts_no_flush() {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT, WAKE_COALESCE);
        let flushes: Flushes = Default::default();
        assert_eq!(d.join(&1, 9), Some(9));
        advance(&clock, 60).await;
        assert!(flushes.lock().unwrap().is_empty());
        push(&d, &clock, &flushes, 1, 1);
        advance(&clock, 9).await;
        assert_eq!(d.join(&1, 2), None);
        advance(&clock, 1).await;
        assert_eq!(*flushes.lock().unwrap(), vec![(1, vec![1, 2], 70_000)]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn debounces_each_key_on_its_own() {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT, WAKE_COALESCE);
        let flushes: Flushes = Default::default();
        push(&d, &clock, &flushes, 1, 1);
        advance(&clock, 6).await;
        push(&d, &clock, &flushes, 2, 2);
        advance(&clock, 4).await;
        assert_eq!(
            flushes
                .lock()
                .unwrap()
                .iter()
                .map(|f| f.0)
                .collect::<Vec<_>>(),
            vec![1]
        );
        advance(&clock, 6).await;
        assert_eq!(
            flushes
                .lock()
                .unwrap()
                .iter()
                .map(|f| f.0)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
