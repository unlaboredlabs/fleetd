//! The human digest at 09:00 and 18:00 in `policy.tz`, announced by `digest.ready`, and on demand for digest_get
//! (TS `digests/HumanDigests.ts`). The event carries no project content: one hub-wide event can't be filtered per
//! key, so each reader fetches its own view with digest_get, which keeps to the key's machines.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, Timestamp};
use fleetd_contracts::ledger::{
    AskState, DecisionScope, DecisionSource, Workstream, WorkstreamState,
};
use serde_json::json;

use crate::clock::Clock;
use crate::hub::attention::{POLICY_TZ_KEY, hub_zone, zone};
use crate::hub::ledger::digest_text::{DigestInput, WorkstreamFacts, render_human_digest};
use crate::hub::ledger::{
    AskFilter, Asks, DecisionFilter, Decisions, LedgerError, iso_at, project_key,
};
use crate::hub::store::{EventLog, HubStore, NewEvent, now_ms};

const SLOT_HOURS: [u32; 2] = [9, 18];
const LIST_LIMIT: i64 = 200;
const HOUR_MS: i64 = 3_600_000;

/// `nextCron("0 9,18 * * *", after, tz)`: the first 09:00 or 18:00 local strictly after `after_ms`.
pub fn next_slot(after_ms: i64, tz: Tz) -> i64 {
    let start = tz
        .timestamp_millis_opt(after_ms)
        .single()
        .expect("utc instant")
        .date_naive();
    let mut best: Option<i64> = None;
    for offset in -1..=3 {
        let Some(day) = start.checked_add_signed(chrono::Duration::days(offset)) else {
            continue;
        };
        for hour in SLOT_HOURS {
            if let Some(t) = slot_on(day, hour, tz)
                && t > after_ms
                && best.is_none_or(|b| t < b)
            {
                best = Some(t);
            }
        }
    }
    best.unwrap_or(after_ms + 12 * HOUR_MS)
}

/// Local `hour:00` on `day`; a time skipped by a DST change moves forward by the gap, as the TS cron does.
fn slot_on(day: NaiveDate, hour: u32, tz: Tz) -> Option<i64> {
    let local = day.and_hms_opt(hour, 0, 0)?;
    match tz.from_local_datetime(&local) {
        chrono::LocalResult::Single(t) => Some(t.timestamp_millis()),
        chrono::LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        chrono::LocalResult::None => {
            let later = local + chrono::Duration::hours(1);
            tz.from_local_datetime(&later)
                .earliest()
                .map(|t| t.timestamp_millis())
        }
    }
}

/// The latest 09:00 or 18:00 at or before `now_ms`: what "since the last digest" means.
pub fn previous_slot(now_ms: i64, tz: Tz) -> i64 {
    let mut last = now_ms - 12 * HOUR_MS;
    let mut t = now_ms - 36 * HOUR_MS;
    loop {
        let next = next_slot(t, tz);
        if next > now_ms {
            return last;
        }
        last = next;
        t = next;
    }
}

type Visible<'a> = &'a dyn Fn(&MachineId) -> bool;
type WorkstreamsFeed = Box<dyn Fn(i64) -> Vec<Workstream> + Send + Sync>;
type FactsFeed = Box<dyn Fn(&[Workstream]) -> HashMap<String, WorkstreamFacts> + Send + Sync>;
type TrainFeed = Box<dyn Fn(&dyn Fn(&ProjectRef) -> bool, i64) -> Vec<String> + Send + Sync>;
type SuggestedFeed = Box<dyn Fn(Visible<'_>) -> Vec<String> + Send + Sync>;

/// What the digest reads from areas that merge after this one. The owning area sets each feed when it is built;
/// a feed not set yet renders as nothing.
#[derive(Default)]
pub struct DigestFeeds {
    /// Leads: the newest workstreams, up to the limit.
    pub workstreams: Option<WorkstreamsFeed>,
    /// Leads (claims and estimates): checks passed and the ETA, by workstream id.
    pub facts: Option<FactsFeed>,
    /// Train: `humanTrainLines(trainFacts(visible project), since_ms)`.
    pub train_lines: Option<TrainFeed>,
    /// Retro: `suggestedLines` of suggested proposals whose machines are all visible.
    pub suggested_lines: Option<SuggestedFeed>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Digest {
    pub text: String,
    pub at: String,
}

pub struct HumanDigests {
    asks: Arc<Asks>,
    decisions: Arc<Decisions>,
    store: Arc<HubStore>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    feeds: RwLock<DigestFeeds>,
}

impl HumanDigests {
    pub fn new(
        asks: Arc<Asks>,
        decisions: Arc<Decisions>,
        store: Arc<HubStore>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            asks,
            decisions,
            store,
            events,
            clock,
            feeds: RwLock::new(DigestFeeds::default()),
        }
    }

    /// Lets an area plug its feed in, e.g. `digests.feed(|f| f.workstreams = Some(Box::new(...)))`.
    pub fn feed(&self, set: impl FnOnce(&mut DigestFeeds)) {
        set(&mut self.feeds.write().unwrap_or_else(|p| p.into_inner()));
    }

    /// `policy.tz` when it names a zone, else the hub's.
    pub fn zone(&self) -> Result<Tz, LedgerError> {
        Ok(self
            .decisions
            .global_value(POLICY_TZ_KEY)?
            .as_deref()
            .and_then(zone)
            .unwrap_or_else(hub_zone))
    }

    /// The digest as of now, over the projects on machines `visible` allows (all when absent).
    pub fn render(&self, visible: Option<Visible<'_>>) -> Result<Digest, LedgerError> {
        let all_visible = |_: &MachineId| true;
        let visible: Visible<'_> = visible.unwrap_or(&all_visible);
        self.render_at(now_ms(self.clock.as_ref()), self.zone()?, visible)
    }

    fn render_at(&self, now: i64, tz: Tz, visible: Visible<'_>) -> Result<Digest, LedgerError> {
        let since = previous_slot(now, tz);
        let shown = |r: &ProjectRef| visible(&r.machine_id);
        let feeds = self.feeds.read().unwrap_or_else(|p| p.into_inner());
        let all: Vec<Workstream> = feeds
            .workstreams
            .as_ref()
            .map(|f| f(LIST_LIMIT))
            .unwrap_or_default()
            .into_iter()
            .filter(|w| shown(&w.project_ref))
            .collect();
        let project_of: HashMap<String, ProjectRef> = all
            .iter()
            .map(|w| (w.workstream_id.to_string(), w.project_ref.clone()))
            .collect();
        let recent = |w: &Workstream| {
            chrono::DateTime::parse_from_rfc3339(w.updated_at.as_str())
                .is_ok_and(|t| t.timestamp_millis() >= since)
        };
        let decided_without_you = self
            .decisions
            .list(&DecisionFilter {
                source: Some(DecisionSource::Lead),
                since_ms: Some(since),
                limit: Some(50),
                ..Default::default()
            })?
            .into_iter()
            .filter(|d| {
                let r = match &d.scope {
                    DecisionScope::Project { project_ref } => Some(project_ref.clone()),
                    DecisionScope::Workstream { workstream_id } => {
                        project_of.get(workstream_id.as_str()).cloned()
                    }
                    DecisionScope::Global => None,
                };
                r.is_some_and(|r| shown(&r))
            })
            .collect();
        let listed: Vec<Workstream> = all
            .into_iter()
            .filter(|w| {
                let closed = matches!(
                    w.state,
                    WorkstreamState::Done | WorkstreamState::Failed | WorkstreamState::Stopped
                );
                !closed || recent(w)
            })
            .collect();
        let asks = self
            .asks
            .list(&AskFilter {
                state: Some(AskState::Open),
                limit: Some(LIST_LIMIT),
                ..Default::default()
            })?
            .into_iter()
            .filter(|a| a.project_ref.as_ref().is_none_or(shown))
            .collect();
        let project_names = self
            .store
            .projects_list(None, None)?
            .into_iter()
            .map(|p| {
                (
                    project_key(&ProjectRef {
                        machine_id: p.machine_id.clone(),
                        project_id: p.project_id.clone(),
                    }),
                    p.title.to_string(),
                )
            })
            .collect();
        let text = render_human_digest(&DigestInput {
            now_ms: now,
            tz: Some(tz),
            asks,
            facts: feeds.facts.as_ref().map(|f| f(&listed)).unwrap_or_default(),
            workstreams: listed,
            decided_without_you,
            project_names,
            train: feeds
                .train_lines
                .as_ref()
                .map(|f| f(&shown, since))
                .unwrap_or_default(),
            suggested: feeds
                .suggested_lines
                .as_ref()
                .map(|f| f(visible))
                .unwrap_or_default(),
        });
        Ok(Digest {
            text,
            at: iso_at(now),
        })
    }

    /// Emits digest.ready at each slot in the current policy.tz. Sleeps at most an hour at a time, so a changed zone
    /// takes effect within the hour; after a long pause (host asleep) it fires once, not once per missed slot. Runs
    /// until `stop` resolves.
    pub async fn run(self: Arc<Self>, stop: impl std::future::Future<Output = ()>) {
        tokio::pin!(stop);
        let mut after = now_ms(self.clock.as_ref());
        loop {
            let tz = self.zone().unwrap_or_else(|_| hub_zone());
            let due = next_slot(after, tz);
            let now = now_ms(self.clock.as_ref());
            if now < due {
                let sleep = self
                    .clock
                    .sleep(Duration::from_millis((due - now).min(HOUR_MS) as u64));
                tokio::select! {
                    () = &mut stop => return,
                    () = sleep => continue,
                }
            }
            let at = iso_at(due);
            let event = NewEvent {
                at: Timestamp(at.clone()),
                r#type: HubEventType::DigestReady,
                machine_id: None,
                project_id: None,
                thread_id: None,
                summary: "The fleetd digest is ready; read it with digest_get".into(),
                data: Some(json!({ "at": at, "fullText": "digest_get" })),
                attention: None,
            };
            if let Err(error) = self.events.append(event) {
                tracing::error!(%error, "digest.ready append failed");
            }
            after = due.max(now);
        }
    }
}
