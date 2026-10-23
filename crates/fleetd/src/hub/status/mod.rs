//! The status view: a verified progress figure, gates, headline, since-you-looked, risks and health for the
//! fleet, a project or an order. One task follows the event log and the freshness deadlines; it re-renders only the
//! scopes someone viewed in the last 10 minutes, at most every 250 ms, and bumps a doc's version only when its
//! content changes. `status_wait` blocks on that version. Nothing polls.
pub mod calib;
pub mod estimate;
pub mod fresh;
pub mod headline;
pub mod model;
pub mod progress;
pub mod render;
pub mod risks;
pub mod rows;
pub mod seen;
pub mod timeline;
pub mod tools;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{WorkstreamId, WorkstreamState};
use fleetd_contracts::plan::PlanView;
use fleetd_contracts::prim::{Count, Line};
use fleetd_contracts::status::{Headline, HeadlineSource, StatusDoc, StatusScope};
use serde_json::Value;
use tokio::sync::{Notify, watch};

use crate::hub::api::{Caller, Hub, is_human, readable};
use crate::hub::store::{NewEvent, iso_ms, now_ms};

/// Renders of one scope are at least this far apart.
const COALESCE_MS: i64 = 250;
/// A scope is viewed for this long after its last status_get or status_wait.
const VIEWED_MS: i64 = 10 * 60_000;

/// Event types that can change a status doc. Others (thread chatter, prompts, keys) are skipped.
const FOLLOWED: &[HubEventType] = &[
    HubEventType::MachineOnline,
    HubEventType::MachineOffline,
    HubEventType::MachineDegraded,
    HubEventType::MachineGuard,
    HubEventType::ProjectRemoved,
    HubEventType::WorkstreamCreated,
    HubEventType::WorkstreamRunning,
    HubEventType::WorkstreamState,
    HubEventType::WorkstreamDone,
    // An open request is "needs you" until it settles.
    HubEventType::RequestOpened,
    HubEventType::RequestUpdated,
    HubEventType::DecisionRecorded,
    HubEventType::TaskQueued,
    HubEventType::TaskStarted,
    HubEventType::TaskCompleted,
    HubEventType::TaskFailed,
    HubEventType::TaskCancelled,
    HubEventType::ClaimFailed,
    HubEventType::ClaimPassed,
    HubEventType::ChangeQueued,
    HubEventType::ChangeReady,
    HubEventType::ChangeNeedsRebase,
    HubEventType::ChangeCiFailed,
    HubEventType::ChangeRefused,
    HubEventType::ChangeState,
    HubEventType::PrMerged,
    HubEventType::UsageBreaker,
    HubEventType::UsageResumed,
    // A task's thread waiting on an answer, parked on a usage limit or running again pauses or resumes its item's
    // in-stage credit.
    HubEventType::ThreadWaiting,
    HubEventType::ThreadUsageLimited,
    HubEventType::ThreadStarted,
    HubEventType::PlanChanged,
    HubEventType::PlanVerified,
    HubEventType::CiMain,
    HubEventType::SourceStale,
    HubEventType::SourceFresh,
    HubEventType::SteerQueued,
    HubEventType::SteerDelivered,
    HubEventType::SteerAcknowledged,
    HubEventType::SteerUnacknowledged,
    HubEventType::SteerWithdrawn,
    HubEventType::SteerFailed,
];

/// Events after which an order's plan items are checked against the done rule again.
const VERIFY_ON: &[HubEventType] = &[
    HubEventType::WorkstreamRunning,
    HubEventType::PrMerged,
    HubEventType::ChangeState,
    HubEventType::ClaimPassed,
    HubEventType::ClaimFailed,
    HubEventType::TaskStarted,
    HubEventType::WorkstreamDone,
    HubEventType::WorkstreamState,
];

struct Cached {
    doc: StatusDoc,
    /// The doc's content without its times, to tell a real change from a re-render.
    content: String,
    rendered_ms: i64,
    wake_at: Option<i64>,
}

#[derive(Default)]
struct State {
    viewed: HashMap<String, (StatusScope, i64)>,
    docs: HashMap<String, Cached>,
    dirty: HashSet<String>,
    slots_queued_since: Option<i64>,
    next_version: i64,
}

pub struct Status {
    pub fresh: Arc<fresh::Fresh>,
    state: Mutex<State>,
    /// Bumped whenever any doc's version moves; waiters re-check their scope.
    versions: watch::Sender<i64>,
    wake: Notify,
    /// Since-you-looked counts per key, scope and mark, with the seq they run to.
    since_cache: Mutex<HashMap<String, (i64, i64, fleetd_contracts::status::Since)>>,
    /// Stage weights and durations the progress model measures against; built-in until the nightly recompute.
    calibration: Mutex<Arc<model::Calibration>>,
    /// The Status screen's rows as last read: the event head and time they were read at.
    rows: Mutex<Option<(i64, i64, Vec<fleetd_contracts::status::ProjectStatusRow>)>>,
}

fn content_of(doc: &StatusDoc) -> String {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(m) => {
                for k in ["now", "version", "asOf", "at", "seq"] {
                    m.remove(k);
                }
                m.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut v = serde_json::to_value(doc).unwrap_or_default();
    strip(&mut v);
    v.to_string()
}

impl Status {
    pub fn new(fresh: Arc<fresh::Fresh>) -> Arc<Self> {
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        Arc::new(Self {
            fresh,
            // Versions start at the hub's start time, so a client's `after` from before a restart is never ahead.
            state: Mutex::new(State {
                next_version: start,
                ..Default::default()
            }),
            versions: watch::Sender::new(0),
            wake: Notify::new(),
            since_cache: Mutex::default(),
            calibration: Mutex::default(),
            rows: Mutex::default(),
        })
    }

    /// The progress model's new calibration (at hub start and nightly); every doc re-renders against it.
    pub fn set_calibration(&self, calibration: Arc<model::Calibration>) {
        *self.calibration.lock().unwrap_or_else(|e| e.into_inner()) = calibration;
        {
            let mut st = self.state.lock().unwrap();
            let viewed: Vec<String> = st.viewed.keys().cloned().collect();
            st.dirty.extend(viewed);
        }
        self.wake.notify_one();
    }

    pub fn calibration(&self) -> Arc<model::Calibration> {
        self.calibration
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn view(&self, scope: &StatusScope, now: i64) {
        let mut st = self.state.lock().unwrap();
        let fresh = st
            .viewed
            .insert(scope.key(), (scope.clone(), now))
            .is_none();
        if fresh {
            st.dirty.insert(scope.key());
        }
    }

    /// Renders the scopes in `keys` from one read of the hub; returns whether any version moved.
    fn render_scopes(&self, hub: &Hub, scopes: &[StatusScope]) -> bool {
        if scopes.is_empty() {
            return false;
        }
        let now = now_ms(hub.clock.as_ref());
        let queued = hub.slots.state().queued.get() > 0;
        let since = {
            let mut st = self.state.lock().unwrap();
            st.slots_queued_since = if queued {
                Some(st.slots_queued_since.unwrap_or(now))
            } else {
                None
            };
            st.slots_queued_since
        };
        let world = match render::World::read(hub, now, since, self.calibration()) {
            Ok(w) => w,
            Err(error) => {
                tracing::error!(%error, "status: reading the hub failed");
                return false;
            }
        };
        let seq = hub.events.head();
        let mut moved = false;
        for scope in scopes {
            let Some(r) = render::render(hub, &world, &self.fresh, scope, seq) else {
                continue;
            };
            let key = scope.key();
            let mut doc = r.doc;
            attach_headline(&mut doc, &r.facts, world.tz, now);
            render::fit(&mut doc);
            let content = content_of(&doc);
            let mut st = self.state.lock().unwrap();
            let same = st.docs.get(&key).is_some_and(|c| c.content == content);
            let version = if same {
                st.docs[&key].doc.version.get()
            } else {
                st.next_version += 1;
                moved = true;
                st.next_version
            };
            doc.version = Count::unchecked(version);
            st.dirty.remove(&key);
            st.docs.insert(
                key,
                Cached {
                    doc,
                    content,
                    rendered_ms: now,
                    wake_at: r.wake_at,
                },
            );
        }
        if moved {
            self.versions.send_modify(|v| *v += 1);
        }
        moved
    }

    /// The doc for `scope` now, rendered fresh, with the caller's since-you-looked and filtered to what it reads.
    pub fn get(
        &self,
        hub: &Hub,
        caller: &Caller,
        scope: &StatusScope,
        since_seq: Option<i64>,
    ) -> Option<StatusDoc> {
        let now = now_ms(hub.clock.as_ref());
        self.view(scope, now);
        // A doc rendered in the last 250 ms with no event since is current: serve it instead of rebuilding.
        let fresh = {
            let st = self.state.lock().unwrap();
            let key = scope.key();
            let head = hub.events.head();
            st.docs
                .get(&key)
                .is_some_and(|c| now - c.rendered_ms < COALESCE_MS && c.doc.seq.get() == head)
                && !st.dirty.contains(&key)
        };
        if !fresh {
            self.render_scopes(hub, std::slice::from_ref(scope));
        }
        self.wake.notify_one();
        let doc = self
            .state
            .lock()
            .unwrap()
            .docs
            .get(&scope.key())
            .map(|c| c.doc.clone())?;
        Some(self.for_caller(hub, caller, doc, since_seq))
    }

    /// The doc once its version passes `after`, or None at the timeout.
    pub async fn wait(
        &self,
        hub: &Hub,
        caller: &Caller,
        scope: &StatusScope,
        since_seq: Option<i64>,
        after: Option<i64>,
        timeout_sec: u64,
    ) -> (Option<StatusDoc>, i64) {
        let key = scope.key();
        let now = now_ms(hub.clock.as_ref());
        self.view(scope, now);
        let mut rx = self.versions.subscribe();
        if !self.state.lock().unwrap().docs.contains_key(&key) {
            self.render_scopes(hub, std::slice::from_ref(scope));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_sec);
        loop {
            rx.borrow_and_update();
            let current = self
                .state
                .lock()
                .unwrap()
                .docs
                .get(&key)
                .map(|c| c.doc.clone());
            let version = current.as_ref().map_or(0, |d| d.version.get());
            if let Some(doc) = current
                && after.is_none_or(|a| version > a)
            {
                return (Some(self.for_caller(hub, caller, doc, since_seq)), version);
            }
            // Keep the scope viewed while someone waits on it.
            self.view(scope, now_ms(hub.clock.as_ref()));
            tokio::select! {
                changed = rx.changed() => if changed.is_err() { return (None, version) },
                () = tokio::time::sleep_until(deadline) => return (None, version),
            }
        }
    }

    /// The current version of a scope's doc, if one was rendered.
    pub fn version_of(&self, key: &str) -> Option<i64> {
        self.state
            .lock()
            .unwrap()
            .docs
            .get(key)
            .map(|c| c.doc.version.get())
    }

    pub fn seen(&self, hub: &Hub, caller: &Caller, scope: &StatusScope, seq: i64) -> bool {
        if !is_human(caller) {
            return false;
        }
        let now = now_ms(hub.clock.as_ref());
        let seq = seq.min(hub.events.head());
        hub.db
            .with(|c| Ok(seen::mark(c, &caller.key_id, &scope.key(), seq, now)?))
            .is_ok()
    }

    /// Adds since-you-looked (from `since_seq` when the client keeps its own mark, else the human key's mark) and
    /// drops machines the key can't read.
    fn for_caller(
        &self,
        hub: &Hub,
        caller: &Caller,
        mut doc: StatusDoc,
        since_seq: Option<i64>,
    ) -> StatusDoc {
        if since_seq.is_some() || is_human(caller) {
            let scope_key = doc.scope.key();
            let cache_key = format!(
                "{}|{}|{}",
                caller.key_id,
                scope_key,
                since_seq.map_or(String::new(), |s| s.to_string())
            );
            let cached = self.since_cache.lock().unwrap().get(&cache_key).cloned();
            let since = hub.db.with(|c| {
                let mark = match since_seq {
                    Some(seq) => Some((seq, now_ms(hub.clock.as_ref()))),
                    None => seen::get(c, &caller.key_id, &scope_key)?,
                };
                // Reuse counts only for the same mark.
                let base = cached
                    .as_ref()
                    .filter(|(m, _, _)| Some(*m) == mark.map(|m| m.0))
                    .map(|(_, to, s)| (*to, s));
                let (counted, to) = seen::since_from(c, &doc.scope, mark, base)?;
                Ok((mark.map(|m| m.0), to, counted))
            });
            if let Ok((Some(mark), to, counted)) = &since {
                let mut cache = self.since_cache.lock().unwrap();
                if cache.len() > 256 {
                    cache.clear();
                }
                cache.insert(cache_key, (*mark, *to, counted.clone()));
            }
            doc.since = since.map(|(_, _, s)| s).unwrap_or_default();
            if since_seq.is_some() {
                doc.since.seen_at = None;
            }
        }
        let reads = |m: &str| readable(caller, &fleetd_contracts::ids::MachineId::unchecked(m));
        let health = &mut doc.health;
        health.machines = list_filter(&health.machines, |m| reads(m.machine_id.as_str()));
        health.usage = list_filter(&health.usage, |u| reads(u.machine_id.as_str()));
        doc.stale = list_filter(&doc.stale, |s| match s.source.split_once(':') {
            Some(("machine" | "usage", m)) => reads(m),
            _ => true,
        });
        doc.parts = list_filter(&doc.parts, |p| match &p.scope {
            Some(StatusScope::Project { project_ref }) => reads(project_ref.machine_id.as_str()),
            _ => true,
        });
        doc
    }

    /// One row per project the caller reads, by title. Read again only after an event, at most every 250 ms, as
    /// docs are.
    pub fn project_rows(
        &self,
        hub: &Hub,
        caller: &Caller,
    ) -> anyhow::Result<Vec<fleetd_contracts::status::ProjectStatusRow>> {
        let now = now_ms(hub.clock.as_ref());
        let head = hub.events.head();
        let cached = self
            .rows
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(h, at, _)| rows::reusable(*h, *at, head, now))
            .map(|(_, _, r)| r.clone());
        let all = match cached {
            Some(r) => r,
            None => {
                let queued = self.state.lock().unwrap().slots_queued_since;
                let world = render::World::read(hub, now, queued, self.calibration())?;
                let (merges, in_flight) = hub.db.with(|c| Ok(rows::read_changes(c)?))?;
                let r = rows::rows(hub, &world, &rows::Changes { merges, in_flight });
                *self.rows.lock().unwrap() = Some((head, now, r.clone()));
                r
            }
        };
        Ok(all
            .into_iter()
            .filter(|r| readable(caller, &r.project_ref.machine_id))
            .collect())
    }

    /// A plan view with its progress estimate (the project's, or the order's).
    pub fn plan_view(
        &self,
        hub: &Hub,
        r: &ProjectRef,
        ws: Option<&WorkstreamId>,
    ) -> Result<PlanView, crate::hub::plan::PlanError> {
        let mut view = hub.plans.view(r, ws)?;
        let scope = match ws {
            Some(w) => StatusScope::Order {
                workstream_id: w.clone(),
            },
            None => StatusScope::Project {
                project_ref: r.clone(),
            },
        };
        let now = now_ms(hub.clock.as_ref());
        if let Ok(world) = render::World::read(hub, now, None, self.calibration())
            && let Some(rendered) =
                render::render(hub, &world, &self.fresh, &scope, hub.events.head())
        {
            view.progress.estimate = rendered.doc.progress.estimate;
        }
        Ok(view)
    }

    fn emit_flip(&self, hub: &Hub, flip: fresh::Flip) {
        let (t, summary, data) = match flip {
            fresh::Flip::Stale {
                source,
                since_ms,
                reason,
            } => (
                HubEventType::SourceStale,
                format!("{source} stale: {reason}"),
                serde_json::json!({ "source": source, "sinceMs": since_ms, "reason": reason }),
            ),
            fresh::Flip::Fresh { source, stale_ms } => (
                HubEventType::SourceFresh,
                format!("{source} live again"),
                serde_json::json!({ "source": source, "staleMs": stale_ms }),
            ),
        };
        let event = NewEvent {
            at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))),
            r#type: t,
            machine_id: None,
            project_id: None,
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        };
        if let Err(error) = hub.events.append(event) {
            tracing::error!(%error, "status: source event");
        }
    }

    /// Re-runs the done rule where an event may have changed it.
    fn verify_for(&self, hub: &Hub, event: &fleetd_contracts::events::HubEvent) {
        if !VERIFY_ON.contains(&event.r#type) {
            return;
        }
        let data = event.data.as_ref();
        let ws = data
            .and_then(|d| d.get("workstreamId")?.as_str().map(str::to_owned))
            .or_else(|| {
                let change = data?.get("changeId")?.as_str()?.to_owned();
                hub.db
                    .with(|c| {
                        Ok(rusqlite::OptionalExtension::optional(c.query_row(
                            "SELECT json_extract(data, '$.workstreamId') FROM changes WHERE n = ?",
                            [crate::hub::plan::number(&change)],
                            |r| r.get::<_, String>(0),
                        ))?)
                    })
                    .ok()
                    .flatten()
            });
        let Some(ws) = ws else { return };
        if event.r#type == HubEventType::WorkstreamRunning {
            hub.plans.placeholder_enter(&ws, false);
            return;
        }
        hub.plans.verify(&ws);
        let state = match event.r#type {
            HubEventType::WorkstreamDone => Some(WorkstreamState::Done),
            HubEventType::WorkstreamState => match data.and_then(|d| d.get("state")?.as_str()) {
                Some("stopped") => Some(WorkstreamState::Stopped),
                Some("failed") => Some(WorkstreamState::Failed),
                Some("done") => Some(WorkstreamState::Done),
                _ => None,
            },
            _ => None,
        };
        if let Some(state) = state {
            hub.plans.close_order(&ws, state);
            hub.plans.placeholder_order_ended(&ws, state);
        }
    }

    /// The follower: event log head, freshness flips and deadlines, headline completions. Runs until shutdown.
    pub async fn run(self: Arc<Self>, hub: Arc<Hub>) {
        let mut head = hub.events.subscribe();
        let mut cursor = *head.borrow_and_update();
        // Full rebuild: the done rule for every order with open plan items.
        let orders: Vec<String> = hub
            .db
            .with(|c| {
                let mut stmt = c.prepare(
                    "SELECT DISTINCT workstream_id FROM plan_items WHERE workstream_id IS NOT NULL AND state = 'open'",
                )?;
                Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .unwrap_or_default();
        for ws in orders {
            hub.plans.verify(&ws);
        }
        hub.plans.placeholder_backfill();
        let mut last_render = 0i64;
        loop {
            let now = now_ms(hub.clock.as_ref());
            for flip in self.fresh.check(now) {
                self.emit_flip(&hub, flip);
            }
            // New events: verify plans, mark viewed scopes dirty.
            let mut touched = false;
            loop {
                let page = match hub.events.page(cursor, Some(FOLLOWED), None) {
                    Ok(p) => p,
                    Err(error) => {
                        tracing::error!(%error, "status: reading events");
                        break;
                    }
                };
                for event in &page.events {
                    self.verify_for(&hub, event);
                    touched = true;
                }
                cursor = page.cursor;
                if !page.more {
                    break;
                }
            }
            let now = now_ms(hub.clock.as_ref());
            let (due, next_wake) = {
                let mut guard = self.state.lock().unwrap();
                let State {
                    viewed,
                    docs,
                    dirty,
                    ..
                } = &mut *guard;
                viewed.retain(|_, (_, at)| now - *at <= VIEWED_MS);
                if touched {
                    dirty.extend(viewed.keys().cloned());
                }
                docs.retain(|k, _| viewed.contains_key(k));
                for (k, c) in docs.iter() {
                    if c.wake_at.is_some_and(|w| w <= now) {
                        dirty.insert(k.clone());
                    }
                }
                let due: Vec<StatusScope> = viewed
                    .iter()
                    .filter(|(k, _)| dirty.contains(*k))
                    .map(|(_, (s, _))| s.clone())
                    .collect();
                let wakes = docs
                    .values()
                    .filter_map(|c| c.wake_at)
                    .filter(|w| *w > now)
                    .min();
                (due, wakes)
            };
            let roll_off = hub.plans.placeholder_roll_off();
            let mut deadline = [self.fresh.next_deadline(), next_wake, roll_off]
                .into_iter()
                .flatten()
                .min();
            if !due.is_empty() {
                if now - last_render >= COALESCE_MS {
                    self.render_scopes(&hub, &due);
                    last_render = now;
                } else {
                    let t = last_render + COALESCE_MS;
                    deadline = Some(deadline.map_or(t, |d| d.min(t)));
                }
            }
            let sleep_ms = deadline.map_or(3_600_000, |d| {
                (d - now_ms(hub.clock.as_ref())).clamp(0, 3_600_000)
            });
            tokio::select! {
                changed = head.changed() => if changed.is_err() { return },
                () = self.fresh.notify.notified() => {}
                () = self.wake.notified() => {}
                () = hub.clock.sleep(Duration::from_millis(sleep_ms as u64)) => {}
                () = hub.shutdown.wait() => return,
            }
            head.borrow_and_update();
        }
    }
}

/// The headline is the code template over the facts, after any "Not live" clause; no model phrases it.
fn attach_headline(
    doc: &mut StatusDoc,
    facts: &fleetd_contracts::status::HeadlineFacts,
    tz: chrono_tz::Tz,
    now: i64,
) {
    let clause = render::stale_clause(doc, tz);
    doc.headline = Headline {
        text: Line::unchecked(plan_clip(&format!("{clause}{}", headline::template(facts)))),
        source: HeadlineSource::Template,
        reason: None,
        prompt_ref: None,
        at: Timestamp(iso_ms(now)),
    };
}

fn plan_clip(s: &str) -> String {
    let s = crate::hub::plan::clip(s, 400);
    if s.is_empty() { "—".into() } else { s }
}

fn list_filter<T: Clone + PartialEq, const MAX: usize>(
    list: &fleetd_contracts::prim::List<T, 0, MAX>,
    keep: impl Fn(&T) -> bool,
) -> fleetd_contracts::prim::List<T, 0, MAX> {
    fleetd_contracts::prim::List::try_from(
        list.iter().filter(|x| keep(x)).cloned().collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}

#[cfg(test)]
mod tests;
