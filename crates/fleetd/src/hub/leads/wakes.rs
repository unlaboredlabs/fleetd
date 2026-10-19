//! Wakes to a lead: triggers for one lead are debounced and coalesced into a single message: the code-rendered
//! digest, then one event line per trigger (`events`).
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::ledger::WorkstreamId;

use super::digest::{DigestInput, WorkstreamFacts, render_lead_digest};
use super::error::LeadError;
use super::events::{Event, frame};
use super::hooks::BoxFuture;
use super::ports::{Answer, followed_up};
use super::records::{LeadRecords, WorkstreamFilter};
use super::{Ctx, now_iso};
use crate::clock::Clock;
use crate::hub::store::{NewEvent, now_ms};

pub const WAKE_DEBOUNCE: Duration = Duration::from_secs(10);
/// A steady trigger stream still wakes the lead this long after the first pending trigger.
pub const WAKE_MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    TaskResult,
    ClaimFailed,
    ClaimPassed,
    TaskWaiting,
    Train,
    ResearchVerdict,
    /// A person added to an order (`order_note`).
    Human,
    /// A slot is free and approved work is runnable (`orders::filler`).
    Runnable,
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
    /// An answered ask only wakes the lead: it gets no event line, since the chat replaces asks.
    Answer(Answer),
    /// A task ended, a claim failed or passed late, a task waits on input, a train event, a research verdict: the area
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

    /// M9: a research workstream's computed verdict, as its event line.
    pub fn research_verdict(line: &str) -> Self {
        Trigger::Line {
            kind: LineKind::ResearchVerdict,
            text: line.to_owned(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Trigger::Intent { .. } => "intent",
            Trigger::Answer(_) => "answer",
            Trigger::Line { kind, .. } => match kind {
                LineKind::TaskResult => "task_result",
                LineKind::ClaimFailed => "claim_failed",
                LineKind::ClaimPassed => "claim_passed",
                LineKind::TaskWaiting => "task_waiting",
                LineKind::Train => "train",
                LineKind::ResearchVerdict => "research_verdict",
                LineKind::Human => "human",
                LineKind::Runnable => "runnable",
            },
        }
    }
}

/// One event line per trigger, in the order they came.
pub fn trigger_lines(triggers: &[Trigger]) -> Vec<String> {
    triggers
        .iter()
        .filter_map(|t| match t {
            Trigger::Intent {
                workstream_id,
                text,
            } => Some(
                Event::Order {
                    workstream: workstream_id.as_str(),
                    text,
                }
                .render(),
            ),
            Trigger::Line { text, .. } => Some(text.clone()),
            Trigger::Answer(_) => None,
        })
        .collect()
}

pub fn render_wake(digest: &str, triggers: &[Trigger]) -> String {
    frame(digest, &trigger_lines(triggers))
}

/// Coalesces items per key: a key flushes once no new item arrived for `debounce`, or `max_wait` after its first
/// pending item. Timers are never cancelled: a superseded one wakes, sees a newer generation and does nothing.
/// Taking the entry out is under the same lock as that check, so an item lands either in this flush or the next.
pub struct Debouncer<K, T> {
    clock: Arc<dyn Clock>,
    debounce_ms: i64,
    max_wait_ms: i64,
    pending: Mutex<HashMap<K, Pending<T>>>,
    next_entry: AtomicU64,
}

struct Pending<T> {
    entry: u64,
    items: Vec<T>,
    generation: u64,
    first_ms: i64,
}

impl<K: Clone + Eq + Hash + Send + 'static, T: Send + 'static> Debouncer<K, T> {
    pub fn new(clock: Arc<dyn Clock>, debounce: Duration, max_wait: Duration) -> Arc<Self> {
        Arc::new(Self {
            clock,
            debounce_ms: debounce.as_millis() as i64,
            max_wait_ms: max_wait.as_millis() as i64,
            pending: Mutex::new(HashMap::new()),
            next_entry: AtomicU64::new(0),
        })
    }

    /// Queues `item`; `flush` runs with every pending item of `key` when its window closes.
    pub fn push<F>(self: &Arc<Self>, key: K, item: T, flush: F)
    where
        F: FnOnce(K, Vec<T>) -> BoxFuture<()> + Send + 'static,
    {
        let now = now_ms(self.clock.as_ref());
        let (entry, generation, delay_ms) = {
            let mut pending = self.pending.lock().unwrap();
            let p = pending.entry(key.clone()).or_insert_with(|| Pending {
                entry: self.next_entry.fetch_add(1, Ordering::Relaxed),
                items: Vec::new(),
                generation: 0,
                first_ms: now,
            });
            p.items.push(item);
            p.generation += 1;
            // The quiet window, cut short so the latest timer never sleeps past the max-wait deadline.
            let delay = self
                .debounce_ms
                .min(p.first_ms + self.max_wait_ms - now)
                .max(0);
            (p.entry, p.generation, delay)
        };
        // The deadline is taken now, not when the task first runs.
        let sleep = self.clock.sleep(Duration::from_millis(delay_ms as u64));
        let this = Arc::clone(self);
        tokio::spawn(async move {
            sleep.await;
            let items = {
                let mut pending = this.pending.lock().unwrap();
                match pending.get(&key) {
                    Some(p) if p.entry == entry && p.generation == generation => {
                        pending.remove(&key).map(|p| p.items)
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
    /// Whether items for `key` wait for their window to close.
    pub fn has_pending(&self, key: &K) -> bool {
        self.pending.lock().unwrap().contains_key(key)
    }

    /// Flushes `item` now, with whatever else is pending for `key`; that key's running timers then find nothing.
    pub fn push_now<F>(self: &Arc<Self>, key: K, item: T, flush: F)
    where
        F: FnOnce(K, Vec<T>) -> BoxFuture<()> + Send + 'static,
    {
        let mut items = self
            .pending
            .lock()
            .unwrap()
            .remove(&key)
            .map(|p| p.items)
            .unwrap_or_default();
        items.push(item);
        tokio::spawn(flush(key, items));
    }
}

/// The orders a wake serves: an intent's, an answered ask's, and any `W<n>` a line names or whose task `T<n>` it
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
            Trigger::Answer(a) => a.ask.workstream_id.iter().map(|w| w.to_string()).collect(),
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

pub struct LeadWakes {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    debouncer: Arc<Debouncer<ProjectRef, Trigger>>,
    flushing: tokio::sync::Mutex<()>,
    /// When the pending wake's first trigger came, per project: `lead.woken.firstTriggerAt`, so the time inspector
    /// sees the debounce. Kept through a usage hold, which re-triggers.
    first: std::sync::Mutex<HashMap<ProjectRef, String>>,
}

impl LeadWakes {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>) -> Arc<Self> {
        let debouncer = Debouncer::new(Arc::clone(&ctx.clock), WAKE_DEBOUNCE, WAKE_MAX_WAIT);
        Arc::new(Self {
            ctx,
            records,
            debouncer,
            flushing: tokio::sync::Mutex::new(()),
            first: std::sync::Mutex::new(HashMap::new()),
        })
    }

    /// Queues a trigger; the lead is woken once no new trigger has arrived for WAKE_DEBOUNCE, or WAKE_MAX_WAIT after
    /// the first.
    pub fn trigger(self: &Arc<Self>, r: &ProjectRef, trigger: Trigger) {
        self.first_trigger(r);
        let this = Arc::clone(self);
        self.debouncer.push(r.clone(), trigger, move |r, triggers| {
            Box::pin(async move { this.flush(r, triggers).await })
        });
    }

    /// Whether a wake for the project's lead is already on its way (triggers waiting out the debounce).
    pub fn pending(&self, r: &ProjectRef) -> bool {
        self.debouncer.has_pending(r)
    }

    /// Wakes the lead now with this trigger and any pending ones, skipping the debounce (a person steering).
    pub fn trigger_now(self: &Arc<Self>, r: &ProjectRef, trigger: Trigger) {
        self.first_trigger(r);
        let this = Arc::clone(self);
        self.debouncer
            .push_now(r.clone(), trigger, move |r, triggers| {
                Box::pin(async move { this.flush(r, triggers).await })
            });
    }

    /// The lead digest as of now: the state block at the top of its first message and of every wake.
    pub async fn digest(&self, r: &ProjectRef) -> Result<String, LeadError> {
        let ctx = &self.ctx;
        let project = ctx.store.project_get(r)?;
        let workstreams = self.records.workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: 50,
            ..Default::default()
        })?;
        let since = self.records.lead_get(r)?.and_then(|l| l.last_wake_at);
        let open_asks = ctx.ports().open_asks(Some(r), None, 50)?;
        // Global, project and every workstream-scoped decision in the project; the digest ranks them.
        let decisions = ctx.ports().decisions_in_project(r, 500)?;
        let tasks = ctx
            .hooks
            .tasks
            .get()
            .map(|t| t.digest_lines(r, since.as_ref(), 50));
        let agents = ctx.hooks.tasks.get().map(|t| t.agents(r));
        let train = ctx
            .hooks
            .train
            .get()
            .and_then(|t| t.lead_lines(r, since.as_ref()));
        let facts = self.workstream_facts(&workstreams);
        let at = now_iso(ctx);
        Ok(render_lead_digest(&DigestInput {
            project_ref: r,
            title: project
                .as_ref()
                .map_or(r.project_id.as_str(), |p| p.title.as_str()),
            at: &at,
            workstreams: &workstreams,
            open_asks: &open_asks,
            decisions: &decisions,
            agents,
            tasks,
            train,
            facts: &facts,
        }))
    }

    /// Per workstream with a brief: the checks its latest finished claim passed, and its ETA.
    pub fn workstream_facts(
        &self,
        workstreams: &[fleetd_contracts::ledger::Workstream],
    ) -> HashMap<WorkstreamId, WorkstreamFacts> {
        let hooks = &self.ctx.hooks;
        let mut facts = HashMap::new();
        for w in workstreams.iter().filter(|w| w.brief.is_some()) {
            let passed = hooks
                .claims
                .get()
                .and_then(|c| c.latest(&w.workstream_id))
                .map(|claim| {
                    claim
                        .results
                        .iter()
                        .filter(|r| r.result == fleetd_contracts::verification::CheckOutcome::Pass)
                        .map(|r| r.check_index.get() as usize)
                        .collect()
                })
                .unwrap_or_default();
            let steers = crate::hub::steer::digest_line(&self.ctx.db, &w.workstream_id);
            let plan = self
                .ctx
                .db
                .with(|c| {
                    Ok(crate::hub::plan::store::items_of_workstream(
                        c,
                        w.workstream_id.as_str(),
                    )?)
                })
                .ok()
                .filter(|items| !items.is_empty())
                .map(|items| {
                    let f = crate::hub::plan::figure_of(&items);
                    format!("plan: {}/{} items, {}%", f.must_done, f.must_total, f.pct())
                });
            facts.insert(
                w.workstream_id.clone(),
                WorkstreamFacts {
                    passed,
                    plan,
                    steers,
                },
            );
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
        if let Err(error) = self.flush_inner(&r, triggers).await {
            tracing::warn!(project = %key_of(&r), %error, "lead wake failed");
        }
    }

    async fn flush_inner(
        self: &Arc<Self>,
        r: &ProjectRef,
        triggers: Vec<Trigger>,
    ) -> Result<(), LeadError> {
        let Some(lead) = self.records.lead_get(r)? else {
            // No lead yet: its first message carries the digest, which shows the same state.
            tracing::info!(project = %key_of(r), triggers = triggers.len(), "lead wake dropped: project has no lead");
            return Ok(());
        };
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
                    .is_none_or(|w| w.workstream.created_at.as_str() >= lead.started_at.as_str()),
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
        if let Some(usage) = self.ctx.hooks.usage.get()
            && usage.hold(&thread).is_some()
        {
            let clear = usage.when_clear(&thread);
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
        let message = render_wake(&self.digest(r).await?, &triggers);
        let at = now_iso(&self.ctx);
        let crid = format!("fleetd-wake:{}:{}:{at}", key_of(r), lead.session_generation);
        // Through the offline write queue, so a wake to an offline machine waits for it instead of being dropped.
        let queued = match self.ctx.ports().send(thread, message, crid).await {
            Ok(queued) => queued,
            Err(reason) => {
                tracing::warn!(project = %key_of(r), %reason, "lead wake not delivered");
                return Ok(());
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

    /// The ledger's AnswerSink (`wiring`) calls this. Each applied answer becomes a trigger for its project's lead. An approved command or a
    /// checklist with a verify check reaches the lead later, from the approvals follow-up, with its outcome.
    pub fn on_answered(self: &Arc<Self>, r: &ProjectRef, answers: &[Answer]) {
        for answer in answers {
            if !followed_up(answer) {
                self.trigger(r, Trigger::Answer(answer.clone()));
            }
        }
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
        let flushes = Arc::clone(flushes);
        let clock = Arc::clone(clock);
        d.push(key, item, move |key, items| {
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
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT);
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
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT);
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
    async fn debounces_each_key_on_its_own() {
        let clock = ManualClock::at(0);
        let d = Debouncer::new(clock.clone(), WAKE_DEBOUNCE, WAKE_MAX_WAIT);
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
