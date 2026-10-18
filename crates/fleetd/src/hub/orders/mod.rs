//! The orders board: open workstreams joined with their agents (tasks and the project's lead), PRs, open asks and the
//! trains of their repos, for the app's board and order view. Reads the existing stores; owns no table.
pub mod notes;
pub mod phase;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap};

use fleetd_contracts::auth::Role;
use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{
    Lead, LeadState, PlaybookName, Workstream, WorkstreamId, WorkstreamState,
};
use fleetd_contracts::live::{
    AgentLane, AgentRole, LaneStatus, LiveLane, OrderCard, PrChip, PrRef, TrainLive, lead_lane_id,
};
use fleetd_contracts::prim::{Count, List, Text};
use fleetd_contracts::tasks::{Task, TaskResultStatus};
use fleetd_contracts::train::{Change, ChangeState, GitHubRepo};

use crate::hub::api::{Caller, Hub, allows};
use crate::hub::executor::LiveParts;
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::reviews::rules::ReviewRole;
use crate::hub::store::{iso_ms, now_ms};
use crate::hub::tasks::TaskFilter;
use crate::hub::train::records::ListFilter;
use phase::{PhaseInput, PrState};

pub const BOARD_ORDERS: usize = 60;
pub const CARD_LANES: usize = 12;
pub const CARD_PRS: usize = 6;
pub const DONE_LANES: usize = 30;
pub const BOARD_TRAINS: usize = 10;
/// Tasks read per order: far above what one order spawns.
const ORDER_TASKS: usize = 200;
/// Changes read per project to find its orders' PRs.
const PROJECT_CHANGES: i64 = 200;

/// What the join asks of the rest of the hub, so the join itself stays testable.
pub trait Lookups {
    fn review_role(&self, task_id: &str) -> Option<ReviewRole>;
    fn reviews_needed(&self, change: &Change) -> i64;
    /// The thread's status, model and effort as the hub last saw them.
    fn thread(&self, r: &ThreadRef) -> Option<ThreadSeen>;
    fn live(&self, r: &ThreadRef) -> Option<LiveParts>;
}

#[derive(Clone, Debug, Default)]
pub struct ThreadSeen {
    pub status: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Lookups for Hub {
    fn review_role(&self, task_id: &str) -> Option<ReviewRole> {
        self.reviews.role_of(task_id)
    }
    fn reviews_needed(&self, change: &Change) -> i64 {
        self.reviews.reviews_needed(change)
    }
    fn thread(&self, r: &ThreadRef) -> Option<ThreadSeen> {
        self.executors.thread_summary(r).map(|s| ThreadSeen {
            status: s.status,
            model: s.model,
            effort: s.effort,
        })
    }
    fn live(&self, r: &ThreadRef) -> Option<LiveParts> {
        self.executors.live(r)
    }
}

fn text<const MAX: usize>(s: &str) -> Text<0, MAX> {
    Text::unchecked(js_take(s, MAX))
}

fn model(s: &str) -> Option<Text<1, 80>> {
    Text::new(js_take(s, 80)).ok()
}

fn count(n: usize) -> Count {
    Count::unchecked(n as i64)
}

fn effort_of(s: &str) -> Option<Effort> {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).ok()
}

fn template_of(w: &Workstream) -> Option<PlaybookName> {
    let pinned = w.playbook.as_ref()?;
    let name = pinned.as_str().split('@').next()?;
    PlaybookName::ALL.into_iter().find(|p| p.as_str() == name)
}

/// One PR for the app, with its clean reviews of the current patch against what its tier asks for.
pub fn pr_ref(change: &Change, reviews_needed: i64) -> PrRef {
    let done = change
        .reviews
        .iter()
        .filter(|r| r.blocking.get() == 0)
        .filter(|r| match &change.patch_id {
            Some(patch) => &r.patch_id == patch,
            None => r.pr_head_sha == change.head_sha,
        })
        .count();
    PrRef {
        change_id: change.change_id.clone(),
        repo: change.repo.clone(),
        number: change.pr_number,
        url: change.pr_url.clone(),
        state: change.state,
        position: change.position,
        reviews_done: count(done),
        reviews_needed: Count::unchecked(reviews_needed.max(0)),
    }
}

/// A lane's live values. An activity only while it can be true: a lane that is not working says no more than its
/// status.
pub fn live_lane(lane_id: &str, status: LaneStatus, parts: Option<&LiveParts>) -> LiveLane {
    let working = matches!(status, LaneStatus::Working | LaneStatus::Starting);
    LiveLane {
        lane_id: Text::unchecked(lane_id),
        status,
        activity: parts.filter(|_| working).and_then(|p| p.activity.clone()),
        tokens: parts.and_then(|p| p.tokens.clone()),
        spark: parts.map(|p| p.spark.clone()),
    }
}

fn reason_of(task: &Task, status: LaneStatus) -> Option<String> {
    match status {
        LaneStatus::Queued => task.queued_reason.as_ref().map(|r| r.to_string()),
        LaneStatus::Parked => Some(
            match task.parked.as_ref().and_then(|p| p.resume_at.as_ref()) {
                Some(at) => format!("usage limit: resumes {}", hhmm(at.as_str())),
                None => "usage limit: resumes on usage_resume".to_owned(),
            },
        ),
        LaneStatus::Failed => task
            .result
            .as_ref()
            .filter(|r| r.status == TaskResultStatus::Failed)
            .and_then(|r| r.tail.lines().rev().find(|l| !l.trim().is_empty()))
            .map(|l| l.trim().to_owned()),
        _ => None,
    }
}

/// "14:05" from an ISO timestamp (UTC, as the hub stores it).
fn hhmm(iso: &str) -> &str {
    iso.get(11..16).unwrap_or(iso)
}

/// A task as one agent lane.
pub fn task_lane(task: &Task, prs: &[(&Change, PrRef)], look: &dyn Lookups) -> AgentLane {
    let thread = task.thread_ref.as_ref().and_then(|r| look.thread(r));
    let status = phase::task_lane_status(task, thread.as_ref().map(|t| t.status.as_str()));
    let role = phase::role(
        task.kind,
        task.qa == Some(true),
        look.review_role(task.task_id.as_str()),
    );
    let pr_url = task
        .result
        .as_ref()
        .and_then(|r| r.pr_url.as_ref())
        .or(task.pr.as_ref())
        .map(|u| u.as_str());
    let pr = prs
        .iter()
        .find(|(c, _)| c.task_id.as_ref() == Some(&task.task_id))
        .or_else(|| prs.iter().find(|(c, _)| Some(c.pr_url.as_str()) == pr_url))
        .map(|(_, p)| p.clone());
    let parts = task.thread_ref.as_ref().and_then(|r| look.live(r));
    AgentLane {
        lane_id: Text::unchecked(task.task_id.as_str()),
        role,
        task_id: Some(task.task_id.clone()),
        thread_ref: task.thread_ref.clone(),
        title: text(&task.title),
        model: model(&task.model),
        effort: Some(task.effort),
        status,
        status_reason: reason_of(task, status).map(|r| text(&r)),
        started_at: task.started_at.clone(),
        ended_at: task.ended_at.clone(),
        branch: task.branch.clone(),
        pr,
        receipts: task.result.as_ref().and_then(|r| r.receipts.clone()),
        live: parts
            .as_ref()
            .map(|p| live_lane(task.task_id.as_str(), status, Some(p))),
    }
}

/// The project's lead as a lane.
pub fn lead_lane(lead: &Lead, project_title: &str, look: &dyn Lookups) -> AgentLane {
    let r = ThreadRef {
        machine_id: lead.project_ref.machine_id.clone(),
        thread_id: lead.thread_id.clone(),
    };
    let thread = look.thread(&r);
    let status = phase::lead_lane_status(
        lead.state,
        lead.parked.is_some(),
        thread.as_ref().map(|t| t.status.as_str()),
    );
    let id = lead_lane_id(&lead.project_ref);
    let parts = look.live(&r);
    AgentLane {
        live: parts.as_ref().map(|p| live_lane(&id, status, Some(p))),
        lane_id: id,
        role: AgentRole::Lead,
        task_id: None,
        thread_ref: Some(r),
        title: text(&format!("{project_title} lead")),
        model: thread
            .as_ref()
            .and_then(|t| t.model.as_deref())
            .and_then(model),
        effort: thread
            .as_ref()
            .and_then(|t| t.effort.as_deref())
            .and_then(effort_of),
        status,
        status_reason: None,
        started_at: Some(lead.started_at.clone()),
        ended_at: None,
        branch: None,
        pr: None,
        receipts: None,
    }
}

/// Everything one card is built from.
pub struct OrderParts<'a> {
    pub workstream: &'a Workstream,
    /// All of the order's tasks.
    pub tasks: &'a [Task],
    /// Its PRs, newest first.
    pub changes: &'a [Change],
    pub open_asks: usize,
    pub lead_working: bool,
}

pub struct Joined {
    pub card: OrderCard,
    /// Finished lanes, most recently ended first.
    pub done: Vec<AgentLane>,
    pub truncated: bool,
}

/// The card: active lanes (newest first), PRs, the phase and the agent counts.
pub fn card(p: &OrderParts<'_>, look: &dyn Lookups) -> Joined {
    let prs: Vec<(&Change, PrRef)> = p
        .changes
        .iter()
        .map(|c| (c, pr_ref(c, look.reviews_needed(c))))
        .collect();
    let mut lanes: Vec<AgentLane> = p.tasks.iter().map(|t| task_lane(t, &prs, look)).collect();
    lanes.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.lane_id.cmp(&a.lane_id))
    });
    let phase_lanes: Vec<_> = lanes
        .iter()
        .map(|l| (l.role, l.status, l.status_reason.as_deref()))
        .collect();
    let pr_states: Vec<PrState> = prs
        .iter()
        .map(|(c, _)| PrState {
            state: c.state,
            number: c.pr_number.get(),
        })
        .collect();
    let w = p.workstream;
    let (phase, detail) = phase::phase(&PhaseInput {
        state: w.state,
        headline: w.headline.as_deref(),
        open_asks: p.open_asks,
        lanes: &phase_lanes,
        prs: &pr_states,
        lead_working: p.lead_working,
    });
    let total = lanes.len();
    let (mut done, mut active): (Vec<_>, Vec<_>) =
        lanes.into_iter().partition(|l| phase::settled(l.status));
    let settled = done.len();
    let truncated = active.len() > CARD_LANES || prs.len() > CARD_PRS || done.len() > DONE_LANES;
    active.truncate(CARD_LANES);
    done.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    done.truncate(DONE_LANES);
    let card = OrderCard {
        workstream_id: w.workstream_id.clone(),
        project_ref: w.project_ref.clone(),
        title: w.title.clone(),
        state: w.state,
        template: template_of(w),
        phase,
        phase_detail: detail.map(|d| text(&d)),
        next: w.headline.clone(),
        needs_you: count(p.open_asks),
        settled: count(settled),
        total: count(total),
        lanes: List::unchecked(active),
        prs: List::unchecked(prs.into_iter().take(CARD_PRS).map(|(_, p)| p).collect()),
        created_at: w.created_at.clone(),
        updated_at: w.updated_at.clone(),
    };
    Joined {
        card,
        done,
        truncated,
    }
}

/// The repo's train for the strip: the head (rebasing, in CI or merging), then the queue in order, then today's
/// merges, newest first.
pub fn train_live(
    repo: &GitHubRepo,
    frozen: bool,
    frozen_reason: Option<String>,
    changes: &[Change],
    today: &str,
) -> TrainLive {
    let chip = |c: &Change, position| PrChip {
        change_id: c.change_id.clone(),
        number: c.pr_number,
        url: c.pr_url.clone(),
        workstream_id: c.workstream_id.clone(),
        state: c.state,
        position,
    };
    let mut head: Vec<&Change> = changes
        .iter()
        .filter(|c| {
            matches!(
                c.state,
                ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging
            )
        })
        .collect();
    head.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
    let mut queue: Vec<&Change> = changes
        .iter()
        .filter(|c| {
            matches!(
                c.state,
                ChangeState::Queued | ChangeState::Reviewing | ChangeState::Ready
            )
        })
        .collect();
    queue.sort_by_key(|c| {
        (
            c.position.map_or(i64::MAX, |p| p.get()),
            c.created_at.0.clone(),
        )
    });
    let mut merged: Vec<&Change> = changes
        .iter()
        .filter(|c| c.state == ChangeState::Merged && c.updated_at.0.as_str() >= today)
        .collect();
    merged.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let merged_today = merged.len();
    let chips: Vec<PrChip> = head
        .into_iter()
        .map(|c| chip(c, None))
        .chain(queue.into_iter().map(|c| chip(c, c.position)))
        .chain(merged.into_iter().map(|c| chip(c, None)))
        .take(12)
        .collect();
    TrainLive {
        repo: repo.clone(),
        frozen,
        frozen_reason: frozen_reason.map(|r| text(&r)),
        chips: List::unchecked(chips),
        merged_today: count(merged_today),
    }
}

/// The open orders the caller may read (and those done since `done_since`), newest first.
pub fn orders_in_scope(
    hub: &Hub,
    caller: &Caller,
    project: Option<&ProjectRef>,
    done_since: Option<&Timestamp>,
) -> Vec<Workstream> {
    let read = |filter: WorkstreamFilter| {
        hub.leads
            .records
            .workstreams_list(&filter)
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "orders: workstreams not read");
                Vec::new()
            })
    };
    let mut out = read(WorkstreamFilter {
        project_ref: project.cloned(),
        open: true,
        limit: 500,
        ..Default::default()
    });
    if let Some(since) = done_since {
        out.extend(
            read(WorkstreamFilter {
                project_ref: project.cloned(),
                state: Some(WorkstreamState::Done),
                limit: 100,
                ..Default::default()
            })
            .into_iter()
            .filter(|w| w.updated_at.0.as_str() >= since.0.as_str()),
        );
    }
    out.retain(|w| allows(caller, Role::Read, Some(&w.project_ref.machine_id)));
    out
}

pub fn order_tasks(hub: &Hub, id: &WorkstreamId) -> Vec<Task> {
    hub.tasks
        .list(&TaskFilter {
            project_ref: None,
            state: None,
            workstream_id: Some(id.clone()),
            limit: ORDER_TASKS,
        })
        .unwrap_or_default()
}

/// Every open ask, counted per workstream.
pub fn open_asks_by_order(hub: &Hub) -> HashMap<WorkstreamId, usize> {
    let mut out = HashMap::new();
    let asks = hub
        .leads
        .ctx
        .ports()
        .open_asks(None, None, 500)
        .unwrap_or_default();
    for ask in asks {
        if let Some(w) = ask.workstream_id {
            *out.entry(w).or_insert(0) += 1;
        }
    }
    out
}

pub fn project_changes(hub: &Hub, project: &ProjectRef) -> Vec<Change> {
    hub.train.list(&ListFilter {
        project_ref: Some(project.clone()),
        limit: PROJECT_CHANGES,
        ..Default::default()
    })
}

fn lead_working(hub: &Hub, project: &ProjectRef) -> bool {
    hub.leads
        .leads
        .get(project)
        .ok()
        .flatten()
        .is_some_and(|l| l.state == LeadState::Working)
}

/// One order joined, for the board or order_get.
pub fn join(hub: &Hub, w: &Workstream, changes: &[Change], open_asks: usize) -> Joined {
    let order_changes: Vec<Change> = changes
        .iter()
        .filter(|c| c.workstream_id == w.workstream_id)
        .cloned()
        .collect();
    let tasks = order_tasks(hub, &w.workstream_id);
    card(
        &OrderParts {
            workstream: w,
            tasks: &tasks,
            changes: &order_changes,
            open_asks,
            lead_working: lead_working(hub, &w.project_ref),
        },
        hub,
    )
}

/// Cards for these orders, sorted for the board, and the trains of their repos.
pub fn board(hub: &Hub, orders: &[Workstream]) -> (Vec<OrderCard>, Vec<TrainLive>, bool) {
    let asks = open_asks_by_order(hub);
    let mut changes: HashMap<ProjectRef, Vec<Change>> = HashMap::new();
    let mut cards = Vec::new();
    let mut truncated = orders.len() > BOARD_ORDERS;
    for w in orders.iter().take(BOARD_ORDERS) {
        let project_changes = changes
            .entry(w.project_ref.clone())
            .or_insert_with(|| project_changes(hub, &w.project_ref));
        let joined = join(
            hub,
            w,
            project_changes,
            asks.get(&w.workstream_id).copied().unwrap_or(0),
        );
        truncated |= joined.truncated;
        cards.push(joined.card);
    }
    phase::sort_cards(&mut cards);
    let all: Vec<&Change> = changes.values().flatten().collect();
    (cards, trains(hub, &all), truncated)
}

fn trains(hub: &Hub, changes: &[&Change]) -> Vec<TrainLive> {
    let today = format!(
        "{}T00:00:00.000Z",
        &iso_ms(now_ms(hub.clock.as_ref()))[..10]
    );
    let repos: BTreeSet<String> = changes.iter().map(|c| c.repo.to_lowercase()).collect();
    let mut out = Vec::new();
    for repo in repos {
        let Some(row) = hub.train.records().train(&repo) else {
            continue;
        };
        let of_repo: Vec<Change> = changes
            .iter()
            .filter(|c| c.repo.to_lowercase() == repo)
            .map(|c| (*c).clone())
            .collect();
        let Some(name) = of_repo.first().map(|c| c.repo.clone()) else {
            continue;
        };
        let reason = row.frozen.then(|| freeze_reason(hub, &row)).flatten();
        let train = train_live(&name, row.frozen, reason, &of_repo, &today);
        if !train.chips.is_empty() || train.frozen {
            out.push(train);
        }
        if out.len() == BOARD_TRAINS {
            break;
        }
    }
    out
}

fn freeze_reason(hub: &Hub, row: &crate::hub::train::records::TrainRow) -> Option<String> {
    let key = crate::hub::train::rules::freeze_key(&row.repo);
    hub.decisions
        .active_on_key(&key, &row.project_ref)
        .ok()?
        .into_iter()
        .next_back()
        .and_then(|d| d.why)
        .map(|why| why.to_string())
}
