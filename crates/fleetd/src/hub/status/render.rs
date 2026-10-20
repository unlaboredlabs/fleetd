//! Builds a scope's status doc from one read of the hub (the world), within the doc's caps. Everything time-like is
//! an absolute time in the hub's zone, so nothing in a doc ages; clients tick ages from the as-of times.
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono_tz::Tz;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::ledger::{HumanRequest, Tier, Workstream, WorkstreamId, WorkstreamState};
use fleetd_contracts::live::OrderCard;
use fleetd_contracts::model::{Machine, MachineStatus};
use fleetd_contracts::node_link::NodeLoad;
use fleetd_contracts::plan::{PlanItemId, PlanItemState, Size, Weight};
use fleetd_contracts::prim::{Count, Int, Line, List, Text};
use fleetd_contracts::status::{
    CiState, DoneRow, EtaBasis, Gate, GateKind, Headline, HeadlineFacts, HeadlineSource, Health,
    HealthCi, HealthMachine, HealthSlots, HealthUsage, InProgressRow, Marker, MoreCounts, NeedsYou,
    NextRow, Progress, ScopePart, SleptAt, SlotUtilization, StaleMark, StaleSource, StatusDoc,
    StatusEta, StatusScope, StatusSteer,
};
use fleetd_contracts::tasks::{SlotState, TaskId};
use fleetd_contracts::train::{ChangeId, ChangeState, GitHubRepo};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::fresh::{self, Fresh};
use super::progress::Figure;
use super::risks::{self, RiskFacts};
use crate::hub::api::Hub;
use crate::hub::plan::store::{ChangeRow, ItemRow, MilestoneRow};
use crate::hub::plan::{self, clip, figure_of, marker_of, parse_ms, progress_of};
use crate::hub::store::iso_ms;

const DAY_MS: i64 = 24 * 3_600_000;
/// Done plan items and estimate rows are read this far back.
const WINDOW_MS: i64 = 7 * DAY_MS;

/// An order the view counts: open, or done in the last day.
#[derive(Clone, Debug)]
pub struct Order {
    pub w: Workstream,
    pub pkey: String,
}

impl Order {
    fn id(&self) -> &str {
        self.w.workstream_id.as_str()
    }
    fn tier(&self) -> Tier {
        self.w.brief.as_ref().map_or(Tier::M, |b| b.tier)
    }
}

#[derive(Clone, Debug)]
pub struct EstRow {
    pub ws: String,
    pub pkey: String,
    pub tier: Size,
    pub started_ms: i64,
    pub done_ms: Option<i64>,
}

/// One read of everything a doc needs, shared by the scopes rendered in one pass.
pub struct World {
    pub now: i64,
    pub tz: Tz,
    pub orders: Vec<Order>,
    pub items: Vec<ItemRow>,
    pub milestones: Vec<MilestoneRow>,
    pub markers: Vec<ChangeRow>,
    pub cards: HashMap<String, OrderCard>,
    pub machines: Vec<Machine>,
    pub loads: HashMap<String, NodeLoad>,
    pub slots: SlotState,
    /// The board's last hour.
    pub slot_use: crate::hub::slots::usage::Utilization,
    /// Open secret and approval requests: what waits on the person.
    pub requests: Vec<HumanRequest>,
    pub estimates: Vec<EstRow>,
    /// The last day's events of the types risks and health read: (type, stored JSON).
    pub recent: Vec<(String, Value)>,
    pub titles: HashMap<String, String>,
    /// Train repos (lowercased) and their project key.
    pub repos: Vec<(String, String)>,
    /// Repos of each project's Changes, lowercased.
    pub change_repos: HashMap<String, HashSet<String>>,
    /// Item → failed attempts (linked task failures, CI failures, failed claims of its order when it lists checks).
    pub failures: HashMap<i64, i64>,
    /// When something first queued for a slot and is still queued.
    pub slots_queued_since: Option<i64>,
    /// Placeholders of orders with no plan, in their figure.
    pub placeholders: HashMap<String, Placeholder>,
    /// The last day's steers and any still waiting for a receipt, newest first.
    pub steers: Vec<fleetd_contracts::steer::Steer>,
    /// What the progress model reads beyond this.
    pub model: super::estimate::ModelData,
}

#[derive(Clone, Copy, Debug)]
pub struct Placeholder {
    pub size: i64,
    pub done: bool,
}

fn order_rows(c: &Connection, since_iso: &str) -> rusqlite::Result<Vec<Order>> {
    let mut stmt = c.prepare_cached(
        "SELECT machine_id, project_id, data FROM workstreams
         WHERE state IN ('running', 'converging', 'verifying', 'idle')
            OR (state = 'done' AND (json_extract(data, '$.updatedAt') >= ?
                OR 'W' || n IN (SELECT workstream_id FROM plan_placeholders WHERE state != 'left')))",
    )?;
    let rows = stmt.query_map([since_iso], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (m, p, data) = row?;
        if let Ok(w) = serde_json::from_str::<Workstream>(&data) {
            out.push(Order {
                w,
                pkey: format!("{m}/{p}"),
            });
        }
    }
    Ok(out)
}

fn estimate_rows(c: &Connection, from_ms: i64) -> rusqlite::Result<Vec<EstRow>> {
    let mut stmt = c.prepare_cached(
        "SELECT e.workstream_id, e.tier, e.started_ms, e.done_ms, w.machine_id || '/' || w.project_id
         FROM estimates e JOIN workstreams w ON w.n = CAST(substr(e.workstream_id, 2) AS INTEGER)
         WHERE e.done_ms IS NULL OR e.done_ms >= ?",
    )?;
    stmt.query_map([from_ms], |r| {
        let tier: String = r.get(1)?;
        Ok(EstRow {
            ws: r.get(0)?,
            tier: match tier.as_str() {
                "S" => Size::S,
                "L" => Size::L,
                _ => Size::M,
            },
            started_ms: r.get(2)?,
            done_ms: r.get(3)?,
            pkey: r.get(4)?,
        })
    })?
    .collect()
}

const RECENT_TYPES: [&str; 9] = [
    "machine.offline",
    "machine.slept",
    "change.ci_failed",
    "task.failed",
    "claim.failed",
    "github.drift",
    // The progress model: stage moves and the causes that may lower a figure.
    "change.state",
    "plan.changed",
    "review.verdict",
];

fn recent_events(c: &Connection, from_ms: i64) -> rusqlite::Result<Vec<(String, Value)>> {
    let mut stmt = c.prepare_cached(
        "SELECT type, data FROM events WHERE type IN (SELECT value FROM json_each(?)) AND created_ms >= ? ORDER BY seq",
    )?;
    let types = serde_json::to_string(&RECENT_TYPES).unwrap_or_default();
    let rows = stmt.query_map(params![types, from_ms], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (t, data) = row?;
        if let Ok(v) = serde_json::from_str(&data) {
            out.push((t, v));
        }
    }
    Ok(out)
}

type ChangeLinks = HashMap<String, (String, Option<String>)>;

impl World {
    pub fn read(
        hub: &Hub,
        now: i64,
        slots_queued_since: Option<i64>,
        calibration: std::sync::Arc<super::model::Calibration>,
    ) -> anyhow::Result<World> {
        let since_iso = iso_ms(now - DAY_MS);
        // Bounded reads: open and recent plan items, Changes only as repos (plus the few the last day's CI failures
        // name), so a render costs the same after months of history.
        let (orders, items, milestones, markers, estimates, recent, change_repos, placeholders) =
            hub.db.with(|c| {
                let mut change_repos: HashMap<String, HashSet<String>> = HashMap::new();
                for row in c
                    .prepare_cached("SELECT DISTINCT machine_id || '/' || project_id, lower(repo) FROM changes")?
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                {
                    let (pk, repo) = row?;
                    change_repos.entry(pk).or_default().insert(repo);
                }
                let placeholders: HashMap<String, Placeholder> = c
                    .prepare_cached(
                        "SELECT workstream_id, size, state FROM plan_placeholders WHERE state != 'left'",
                    )?
                    .query_map([], |r| {
                        Ok((r.get::<_, String>(0)?, Placeholder { size: r.get(1)?, done: r.get::<_, String>(2)? == "done" }))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                Ok((
                    order_rows(c, &since_iso)?,
                    plan::store::items_live(c, now - WINDOW_MS)?,
                    plan::store::milestones_all(c)?,
                    plan::store::changes_all(c, 200)?,
                    estimate_rows(c, now - WINDOW_MS)?,
                    recent_events(c, now - DAY_MS)?,
                    change_repos,
                    placeholders,
                ))
            })?;
        let failed_changes: HashSet<i64> = recent
            .iter()
            .filter(|(t, _)| t == "change.ci_failed")
            .filter_map(|(_, e)| e.pointer("/data/changeId")?.as_str().map(plan::number))
            .collect();
        let mut links: ChangeLinks = HashMap::new();
        hub.db.with(|c| {
            for n in &failed_changes {
                let data: Option<String> = c
                    .prepare_cached("SELECT data FROM changes WHERE n = ?")?
                    .query_row([n], |r| r.get(0))
                    .optional()?;
                if let Some(ch) = data
                    .and_then(|d| serde_json::from_str::<fleetd_contracts::train::Change>(&d).ok())
                {
                    links.insert(
                        ch.change_id.to_string(),
                        (ch.pr_url.to_string(), ch.task_id.map(|t| t.to_string())),
                    );
                }
            }
            Ok(())
        })?;
        let workstreams: Vec<Workstream> = orders.iter().map(|o| o.w.clone()).collect();
        let (cards, _, _) = crate::hub::orders::board(hub, &workstreams);
        let cards = cards
            .into_iter()
            .map(|c| (c.workstream_id.to_string(), c))
            .collect();
        let machines = hub.store.machines_list()?;
        let loads = machines
            .iter()
            .filter_map(|m| Some((m.machine_id.to_string(), hub.link.load(&m.machine_id)?)))
            .collect();
        let requests = hub
            .leads
            .ctx
            .ports()
            .open_requests(None, 500)
            .unwrap_or_default();
        let titles = hub
            .store
            .projects_list(None, None)?
            .into_iter()
            .map(|p| (format!("{}/{}", p.machine_id, p.project_id), p.title))
            .collect();
        let repos = hub
            .train
            .repos()
            .into_iter()
            .map(|(r, p)| (r.to_lowercase(), plan::store::pkey(&p)))
            .collect();
        let failures = item_failures(&items, &recent, &links);
        let steers = crate::hub::steer::store::recent(&hub.db, now - DAY_MS)?;
        let mut model = hub.db.with(|c| {
            Ok(super::estimate::ModelData::read(
                c,
                &orders,
                &since_iso,
                calibration,
            )?)
        })?;
        // Only Changes before review need the rule, and reading it reads the order: few, not every Change in view.
        model.reviewless = model
            .changes
            .iter()
            .filter(|c| {
                super::model::change_stage(c.state)
                    == Some(fleetd_contracts::plan::ItemStage::PrOpen)
            })
            .filter(|c| hub.reviews.reviews_needed(c) == 0)
            .map(|c| c.change_id.to_string())
            .collect();
        Ok(World {
            now,
            tz: crate::hub::attention::hub_zone(),
            orders,
            items,
            milestones,
            markers,
            cards,
            machines,
            loads,
            slots: hub.slots.state(),
            slot_use: hub.slots.utilization(),
            requests,
            estimates,
            recent,
            titles,
            repos,
            change_repos,
            failures,
            slots_queued_since,
            placeholders,
            steers,
            model,
        })
    }
}

fn item_failures(
    items: &[ItemRow],
    recent: &[(String, Value)],
    links: &ChangeLinks,
) -> HashMap<i64, i64> {
    let mut out = HashMap::new();
    for i in items.iter().filter(|i| i.state == PlanItemState::Open) {
        let tasks: HashSet<&str> = i.data.links.tasks.iter().map(|t| t.as_str()).collect();
        let prs: HashSet<&str> = i.data.links.prs.iter().map(|p| p.as_str()).collect();
        let mut n = 0;
        for (t, e) in recent {
            match t.as_str() {
                "task.failed" => {
                    if e.pointer("/data/taskId")
                        .and_then(Value::as_str)
                        .is_some_and(|t| tasks.contains(t))
                    {
                        n += 1;
                    }
                }
                "change.ci_failed" => {
                    let Some(id) = e.pointer("/data/changeId").and_then(Value::as_str) else {
                        continue;
                    };
                    if let Some((pr, task)) = links.get(id)
                        && (prs.contains(pr.as_str())
                            || task.as_deref().is_some_and(|t| tasks.contains(t)))
                    {
                        n += 1;
                    }
                }
                "claim.failed"
                    if !i.data.links.checks.is_empty()
                        && e.pointer("/data/workstreamId").and_then(Value::as_str)
                            == i.workstream_id.as_deref() =>
                {
                    n += 1;
                }
                _ => {}
            }
        }
        if n > 0 {
            out.insert(i.n, n);
        }
    }
    out
}

/// "14:02" today, "Thu 14:00" within a week, else "Oct 21 14:00", in the hub's zone.
pub fn clock(ms: i64, now: i64, tz: Tz) -> String {
    let Some(t) = chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&tz)) else {
        return iso_ms(ms);
    };
    let n = chrono::DateTime::from_timestamp_millis(now).map(|d| d.with_timezone(&tz));
    if n.is_some_and(|n| n.date_naive() == t.date_naive()) {
        t.format("%H:%M").to_string()
    } else if (ms - now).abs() < 6 * DAY_MS {
        t.format("%a %H:%M").to_string()
    } else {
        t.format("%b %-d %H:%M").to_string()
    }
}

/// "+6h", "−40m".
pub fn duration(ms: i64) -> String {
    let m = ms.unsigned_abs() / 60_000;
    let sign = if ms < 0 { "−" } else { "+" };
    match m {
        0..60 => format!("{sign}{m}m"),
        _ => format!("{sign}{}h", (m + 30) / 60),
    }
}

fn hours(ms: i64) -> String {
    let m = ms.max(0) / 60_000;
    if m < 60 {
        format!("{m}m")
    } else {
        format!("{}h", (m + 30) / 60)
    }
}

fn ts(ms: i64) -> Timestamp {
    Timestamp(iso_ms(ms))
}

fn line<const N: usize>(s: &str) -> Line<1, N> {
    let s = clip(s, N);
    Line::unchecked(if s.is_empty() { "—".to_owned() } else { s })
}

/// Keeps the first `MAX` and counts the rest.
fn capped<T: PartialEq, const MAX: usize>(mut v: Vec<T>) -> (List<T, 0, MAX>, i64) {
    let more = v.len().saturating_sub(MAX) as i64;
    v.truncate(MAX);
    (List::try_from(v).unwrap_or_default(), more)
}

/// Which orders, items and machines a scope covers.
pub struct Scope<'a> {
    pub title: String,
    pub orders: Vec<&'a Order>,
    /// Items in the figure: open milestones (an order: all its items).
    pub items: Vec<&'a ItemRow>,
    /// Items for rates and durations, done milestones included.
    pub history: Vec<&'a ItemRow>,
    pub pkeys: HashSet<String>,
    pub machines: HashSet<String>,
}

fn status_steer(x: &fleetd_contracts::steer::Steer) -> StatusSteer {
    StatusSteer {
        id: x.id.clone(),
        text: line(&x.text),
        stage: x.stage,
        at: x.queued_at.clone(),
        plan_change: x
            .plan_change
            .as_ref()
            .filter(|p| !p.is_empty())
            .map(|p| line(p)),
    }
}

fn scope_of<'a>(w: &'a World, scope: &StatusScope) -> Option<Scope<'a>> {
    let open_milestone: HashSet<i64> = w
        .milestones
        .iter()
        .filter(|m| m.done_ms.is_none())
        .map(|m| m.n)
        .collect();
    let (title, pkeys, ws): (String, HashSet<String>, Option<&str>) = match scope {
        StatusScope::Fleet => (
            "Fleet".into(),
            w.orders
                .iter()
                .map(|o| o.pkey.clone())
                .chain(w.items.iter().map(|i| i.pkey.clone()))
                .collect(),
            None,
        ),
        StatusScope::Project { project_ref } => {
            let pk = plan::store::pkey(project_ref);
            let title = w
                .titles
                .get(&pk)
                .cloned()
                .unwrap_or_else(|| project_ref.project_id.to_string());
            (title, [pk].into(), None)
        }
        StatusScope::Order { workstream_id } => {
            let o = w
                .orders
                .iter()
                .find(|o| o.w.workstream_id == *workstream_id);
            let pk = match o {
                Some(o) => o.pkey.clone(),
                None => w
                    .items
                    .iter()
                    .find(|i| i.workstream_id.as_deref() == Some(workstream_id.as_str()))?
                    .pkey
                    .clone(),
            };
            let title = o.map_or_else(
                || workstream_id.to_string(),
                |o| format!("{workstream_id} {}", crate::hub::orders::short_title(&o.w)),
            );
            (title, [pk].into(), Some(workstream_id.as_str()))
        }
    };
    let orders: Vec<&Order> = w
        .orders
        .iter()
        .filter(|o| pkeys.contains(&o.pkey) && ws.is_none_or(|ws| o.id() == ws))
        .collect();
    let history: Vec<&ItemRow> = w
        .items
        .iter()
        .filter(|i| {
            pkeys.contains(&i.pkey) && ws.is_none_or(|ws| i.workstream_id.as_deref() == Some(ws))
        })
        .collect();
    let items = history
        .iter()
        .copied()
        .filter(|i| ws.is_some() || open_milestone.contains(&i.milestone))
        .collect();
    let machines = if matches!(scope, StatusScope::Fleet) {
        w.machines
            .iter()
            .map(|m| m.machine_id.to_string())
            .collect()
    } else {
        pkeys
            .iter()
            .map(|p| p.split_once('/').map_or(p.clone(), |(m, _)| m.to_owned()))
            .collect()
    };
    Some(Scope {
        title,
        orders,
        items,
        history,
        pkeys,
        machines,
    })
}

/// Orders with no plan items count as one must item of their tier from when they start running (a placeholder, with
/// a marker on the way in and out), done when the order is done.
fn virtual_orders<'a>(w: &World, s: &Scope<'a>) -> Vec<&'a Order> {
    s.orders
        .iter()
        .copied()
        .filter(|o| w.placeholders.contains_key(o.id()))
        .collect()
}

fn figure(w: &World, s: &Scope<'_>, virtuals: &[&Order]) -> Figure {
    let mut f = Figure::default();
    for i in &s.items {
        f.add(i.weight, i.size, i.state);
    }
    for o in virtuals {
        let Some(p) = w.placeholders.get(o.id()) else {
            continue;
        };
        let size = match p.size {
            1 => Size::S,
            8 => Size::L,
            _ => Size::M,
        };
        f.add(
            Weight::Must,
            size,
            if p.done {
                PlanItemState::Done
            } else {
                PlanItemState::Open
            },
        );
    }
    f
}

/// What a doc sends for the retired ETA: enough for apps from before the change to decode it, nothing else.
fn retired_eta() -> StatusEta {
    StatusEta {
        current: None,
        original: None,
        slip: None,
        lead: None,
        rate: None,
        samples: Count::unchecked(0),
        basis: EtaBasis::None,
        chain: None,
    }
}

fn machine_stale(m: &Machine, now: i64, tz: Tz) -> Option<StaleMark> {
    if m.status != MachineStatus::Offline {
        return None;
    }
    let seen = parse_ms(m.last_seen_at.as_str()).unwrap_or(now);
    Some(StaleMark {
        since: ts(seen),
        reason: line(&format!(
            "no heartbeat from {} since {}",
            m.machine_id,
            clock(seen, now, tz)
        )),
    })
}

fn usage_label(limit_type: &str) -> String {
    match limit_type {
        "five_hour" => "5h".into(),
        "seven_day" => "wk".into(),
        other => other.replace('_', " "),
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) if c.clone().next().is_some_and(char::is_lowercase) => {
            f.to_lowercase().collect::<String>() + c.as_str()
        }
        _ => s.to_owned(),
    }
}

/// One check name failing on two or more Changes of the scope in the last day.
fn ci_repeat(w: &World, s: &Scope<'_>) -> Vec<(String, i64)> {
    let mut by: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for (t, e) in &w.recent {
        if t != "change.ci_failed" {
            continue;
        }
        let pk = format!(
            "{}/{}",
            e.get("machineId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            e.get("projectId")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        if !s.pkeys.contains(&pk) {
            continue;
        }
        let change = e
            .pointer("/data/changeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        for name in e
            .pointer("/data/checks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            by.entry(name.to_owned())
                .or_default()
                .insert(change.clone());
        }
    }
    by.into_iter()
        .map(|(n, c)| (n, c.len() as i64))
        .filter(|(_, n)| *n >= 2)
        .collect()
}

/// "Not live: devbox silent since 14:02 · GitHub unchecked since 14:05. " for the doc's stale sources.
pub fn stale_clause(doc: &StatusDoc, tz: Tz) -> String {
    let now = parse_ms(doc.now.as_str()).unwrap_or(0);
    let mut parts: Vec<String> = Vec::new();
    for s in doc.stale.iter() {
        let since = parse_ms(s.since.as_str())
            .map_or_else(String::new, |t| format!(" since {}", clock(t, now, tz)));
        let (kind, name) = s.source.split_once(':').unwrap_or((s.source.as_str(), ""));
        let part = match kind {
            "machine" => format!("{name} silent{since}"),
            "github" => format!("GitHub unchecked{since}"),
            "train" => format!("the {name} train stopped{since}"),
            "webhook" => format!("{name} webhooks missed{since}"),
            "ci" => format!("main CI of {name} unread{since}"),
            "usage" => format!("{name}'s usage reading is old"),
            _ => continue,
        };
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("Not live: {}. ", parts.join(" · "))
    }
}

/// A scope's doc (headline left for the caller) and the facts its headline is phrased from.
pub struct Rendered {
    pub doc: StatusDoc,
    pub facts: HeadlineFacts,
    /// The earliest time this doc changes without an event (a usage reset, an item ETA, a risk threshold).
    pub wake_at: Option<i64>,
}

struct Wake(Option<i64>, i64);

impl Wake {
    fn at(&mut self, t: i64) {
        if t > self.1 {
            self.0 = Some(self.0.map_or(t, |w| w.min(t)));
        }
    }
}

pub fn render(
    hub: &Hub,
    w: &World,
    fresh: &Fresh,
    scope: &StatusScope,
    seq: i64,
) -> Option<Rendered> {
    let s = scope_of(w, scope)?;
    let (now, tz) = (w.now, w.tz);
    let mut wake = Wake(None, now);
    let virtuals = virtual_orders(w, &s);
    let f = figure(w, &s, &virtuals);
    let mo = super::estimate::compute(w, scope, &s);
    if let Some(t) = mo.wake_at {
        wake.at(t);
    }
    // The model's part of an in-progress row: stage, credit, slowness, what it waits on and what waits on it.
    let blocked_by: HashMap<i64, Vec<i64>> = s.items.iter().fold(HashMap::new(), |mut m, i| {
        if i.state == PlanItemState::Open {
            for a in &i.data.after {
                m.entry(*a).or_default().push(i.n);
            }
        }
        m
    });
    let after_titles = |i: &ItemRow| -> Vec<String> {
        i.data
            .after
            .iter()
            .filter_map(|a| {
                w.items
                    .iter()
                    .find(|x| x.n == *a && x.state == PlanItemState::Open)
            })
            .map(|x| clip(&format!("P{} {}", x.n, x.data.title), 80))
            .collect()
    };
    let unit_fields = |key: super::model::UnitKey, after: &[String]| -> InProgressRow {
        let p = mo.units.get(&key);
        let blocking: Vec<PlanItemId> = match &key {
            super::model::UnitKey::Item(n) => blocked_by
                .get(n)
                .into_iter()
                .flatten()
                .map(|x| PlanItemId::unchecked(format!("P{x}")))
                .collect(),
            super::model::UnitKey::Order(_) => vec![],
        };
        let steps: Vec<Line<1, 80>> = p
            .filter(|p| !p.verified)
            .map(|p| {
                super::estimate::steps(
                    p.stage,
                    mo.prs.get(&key).copied(),
                    !mo.no_review.contains(&key),
                    after,
                )
            })
            .unwrap_or_default()
            .iter()
            .map(|x| line::<80>(x))
            .collect();
        InProgressRow {
            item_id: None,
            workstream_id: WorkstreamId::unchecked("W0"),
            title: line("—"),
            task_ids: List::default(),
            change_ids: List::default(),
            gate: None,
            eta: None,
            overdue_minutes: None,
            stale: None,
            steers: None,
            stage: p.map(|p| p.stage),
            credit_pct: p
                .map(|p| Int::unchecked(((p.credit * 100.0).floor() as i64).clamp(0, 100))),
            slower_than_usual: p.map(|p| p.slower).filter(|s| *s),
            waiting_on: (!steps.is_empty()).then(|| capped::<_, 8>(steps).0),
            blocking: (!blocking.is_empty()).then(|| capped::<_, 10>(blocking).0),
            critical: (mo.critical.as_ref() == Some(&key)).then_some(true),
        }
    };
    let markers: Vec<Marker> = w
        .markers
        .iter()
        .filter(|m| s.pkeys.contains(&m.pkey))
        .filter(|m| match scope {
            StatusScope::Order { workstream_id } => {
                m.workstream_id.as_deref() == Some(workstream_id.as_str())
            }
            _ => true,
        })
        .take(3)
        .map(marker_of)
        .collect();

    // Health and staleness first: the figure and the rows are marked from them.
    let repos: Vec<String> = w
        .repos
        .iter()
        .filter(|(_, p)| matches!(scope, StatusScope::Fleet) || s.pkeys.contains(p))
        .map(|(r, _)| r.clone())
        .collect();
    let mut stale: Vec<StaleSource> = Vec::new();
    let mut github_stale: HashMap<String, StaleMark> = HashMap::new();
    let mut ci = Vec::new();
    for repo in &repos {
        let mut mark: Option<StaleMark> = None;
        for source in [
            fresh::github(repo),
            fresh::train(repo),
            fresh::webhook(repo),
        ] {
            if let Some(st) = fresh.view(&source, now).and_then(|v| v.stale) {
                let m = StaleMark {
                    since: ts(st.since_ms),
                    reason: line(&st.reason),
                };
                stale.push(StaleSource {
                    source: line(&source),
                    since: m.since.clone(),
                    reason: m.reason.clone(),
                });
                mark.get_or_insert(m);
            }
        }
        if let Some(m) = &mark {
            github_stale.insert(repo.clone(), m.clone());
        }
        let main = hub.train.main_ci(repo);
        // The CI entry is as old as its own read, not as any GitHub answer for the repo.
        let as_of = main.as_ref().map(|m| m.as_of_ms);
        let due = hub.train.main_ci_every_ms(repo, now) + fresh::github_stale_ms();
        match as_of {
            Some(a) if now - a > due => {
                let m = StaleMark {
                    since: ts(a),
                    reason: line(&format!(
                        "main CI of {repo} last read {}",
                        clock(a, now, tz)
                    )),
                };
                stale.push(StaleSource {
                    source: line(&format!("ci:{repo}")),
                    since: m.since.clone(),
                    reason: m.reason.clone(),
                });
                mark.get_or_insert(m);
            }
            Some(a) => wake.at(a + due + 1),
            None => {
                // A stable time, so an unread repo doesn't bump the doc's version on every render.
                static FIRST: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
                let since = *FIRST.get_or_init(|| now);
                mark.get_or_insert(StaleMark {
                    since: ts(since),
                    reason: line("main CI not read since the hub started"),
                });
            }
        }
        let failing: Vec<Text<1, 120>> = main
            .as_ref()
            .map(|m| {
                m.failing
                    .iter()
                    .take(10)
                    .map(|n| Text::unchecked(clip(n, 120)))
                    .collect()
            })
            .unwrap_or_default();
        ci.push(HealthCi {
            repo: GitHubRepo::unchecked(repo.clone()),
            state: main.as_ref().map_or(CiState::Unknown, |m| m.state),
            sha: main.as_ref().map(|m| line::<64>(&m.sha)),
            failing: List::try_from(failing).unwrap_or_default(),
            since: main.as_ref().map(|m| ts(m.since_ms)),
            as_of: as_of.map(ts),
            stale: mark,
        });
    }
    let mut machine_stale_by: HashMap<String, StaleMark> = HashMap::new();
    let mut machines = Vec::new();
    let of_machine = |e: &Value, m: &str| e.get("machineId").and_then(Value::as_str) == Some(m);
    for m in w
        .machines
        .iter()
        .filter(|m| s.machines.contains(m.machine_id.as_str()))
    {
        let mid = m.machine_id.as_str();
        let mark = machine_stale(m, now, tz);
        if let Some(mk) = &mark {
            stale.push(StaleSource {
                source: line(&format!("machine:{mid}")),
                since: mk.since.clone(),
                reason: mk.reason.clone(),
            });
            machine_stale_by.insert(mid.to_owned(), mk.clone());
        }
        let drops = w
            .recent
            .iter()
            .filter(|(t, e)| (t == "machine.offline" || t == "machine.slept") && of_machine(e, mid))
            .count();
        let slept = w
            .recent
            .iter()
            .rev()
            .find(|(t, e)| t == "machine.slept" && of_machine(e, mid))
            .and_then(|(_, e)| {
                let from = e.pointer("/data/fromMs")?.as_i64()?;
                let to = e.pointer("/data/toMs")?.as_i64()?;
                Some(SleptAt {
                    from_ms: Count::unchecked(from),
                    to_ms: Count::unchecked(to),
                })
            });
        machines.push(HealthMachine {
            machine_id: m.machine_id.clone(),
            status: m.status,
            last_seen_at: Some(m.last_seen_at.clone()),
            slept,
            drops_today: Count::unchecked(drops as i64),
            stale: mark,
        });
    }
    let mut usage: BTreeMap<String, HealthUsage> = BTreeMap::new();
    for (mid, load) in w.loads.iter().filter(|(m, _)| s.machines.contains(*m)) {
        for l in load.limits.iter() {
            let resets = l.resets_at.as_ref().and_then(|r| parse_ms(r.as_str()));
            if let Some(r) = resets {
                wake.at(r + 1);
            }
            let stale_mark = match (resets, machine_stale_by.get(mid)) {
                (_, Some(m)) => Some(m.clone()),
                (Some(r), _) if now > r => {
                    let read = l.observed_at.as_ref().and_then(|o| parse_ms(o.as_str()));
                    Some(StaleMark {
                        since: ts(read.unwrap_or(r)),
                        reason: line(&format!(
                            "{} reading from {}, before the {} reset",
                            usage_label(&l.limit_type),
                            read.map_or_else(
                                || "an unknown time".to_owned(),
                                |o| clock(o, now, tz)
                            ),
                            clock(r, now, tz)
                        )),
                    })
                }
                _ => None,
            };
            if let Some(m) = &stale_mark
                && !machine_stale_by.contains_key(mid)
            {
                stale.push(StaleSource {
                    source: line(&format!("usage:{mid}")),
                    since: m.since.clone(),
                    reason: m.reason.clone(),
                });
            }
            let u = l.utilization.as_ref().map_or(0.0, |u| u.get());
            if usage
                .get(l.limit_type.as_str())
                .is_none_or(|e| e.utilization.as_ref().map_or(0.0, |x| x.get()) < u)
            {
                usage.insert(
                    l.limit_type.to_string(),
                    HealthUsage {
                        limit_type: l.limit_type.clone(),
                        machine_id: MachineId::unchecked(mid.clone()),
                        utilization: l.utilization,
                        resets_at: l.resets_at.clone(),
                        status: l.status.clone(),
                        observed_at: l.observed_at.clone(),
                        stale: stale_mark,
                    },
                );
            }
        }
    }
    stale.sort_by(|a, b| a.since.cmp(&b.since));
    let (stale_list, stale_more) = capped::<_, 10>(stale);

    // Rows.
    let item_by_n: HashMap<i64, &ItemRow> = w.items.iter().map(|i| (i.n, i)).collect();
    let order_stale = |ws: &str| -> Option<StaleMark> {
        let card = w.cards.get(ws)?;
        if let Some(m) = machine_stale_by.get(card.project_ref.machine_id.as_str()) {
            return Some(m.clone());
        }
        card.prs.iter().find_map(|pr| {
            let url = pr.url.as_str().to_lowercase();
            github_stale
                .iter()
                .find(|(r, _)| url.contains(&format!("/{r}/")))
                .map(|(_, m)| m.clone())
        })
    };
    let live_work = |ws: &str| -> (Vec<String>, Vec<String>) {
        let Some(card) = w.cards.get(ws) else {
            return (vec![], vec![]);
        };
        let tasks = card
            .lanes
            .iter()
            .filter(|l| !crate::hub::orders::phase::settled(l.status))
            .filter_map(|l| l.task_id.as_ref().map(|t| t.to_string()))
            .collect();
        let prs = card
            .prs
            .iter()
            .filter(|p| {
                !matches!(
                    p.state,
                    ChangeState::Merged | ChangeState::Abandoned | ChangeState::Refused
                )
            })
            .map(|p| p.change_id.to_string())
            .collect();
        (tasks, prs)
    };
    let gate_of = |ws: &str| -> Option<String> {
        w.cards
            .get(ws)?
            .phase_detail
            .as_ref()
            .map(|d| d.to_string())
    };
    let mut in_progress = Vec::new();
    let mut next = Vec::new();
    let mut done: Vec<(i64, DoneRow)> = Vec::new();
    let mut open_must = Vec::new();
    for i in &s.items {
        let id = PlanItemId::unchecked(format!("P{}", i.n));
        let ws = i.workstream_id.as_deref();
        match i.state {
            PlanItemState::Dropped => {}
            PlanItemState::Done => done.push((
                i.done_ms.unwrap_or(0),
                DoneRow {
                    item_id: Some(id),
                    workstream_id: ws.map(WorkstreamId::unchecked),
                    title: line(&i.data.title),
                    done_at: ts(i.done_ms.unwrap_or(now)),
                    evidence: line(i.data.evidence.as_deref().unwrap_or("verified")),
                },
            )),
            PlanItemState::Open => {
                if i.weight == Weight::Must {
                    let size = match i.size {
                        Size::S => 's',
                        Size::M => 'm',
                        Size::L => 'l',
                    };
                    open_must.push((
                        format!("P{}", i.n),
                        clip(&i.data.title, 60),
                        size,
                        *w.failures.get(&i.n).unwrap_or(&0),
                    ));
                }
                let (tasks, changes) = ws.map(live_work).unwrap_or_default();
                let mine: Vec<String> = tasks
                    .into_iter()
                    .filter(|t| i.data.links.tasks.iter().any(|l| l.as_str() == t))
                    .collect();
                if i.started_ms.is_some() || !mine.is_empty() {
                    in_progress.push(InProgressRow {
                        item_id: Some(id),
                        workstream_id: WorkstreamId::unchecked(ws.unwrap_or("W0")),
                        title: line(&i.data.title),
                        task_ids: capped::<_, 10>(
                            mine.into_iter().map(TaskId::unchecked).collect(),
                        )
                        .0,
                        change_ids: capped::<_, 10>(
                            changes.into_iter().map(ChangeId::unchecked).collect(),
                        )
                        .0,
                        gate: ws.and_then(gate_of).map(|g| line(&g)),
                        eta: None,
                        overdue_minutes: None,
                        stale: ws.and_then(order_stale),
                        steers: None,
                        ..unit_fields(super::model::UnitKey::Item(i.n), &after_titles(i))
                    });
                } else {
                    let after: Vec<PlanItemId> = i
                        .data
                        .after
                        .iter()
                        .filter(|a| {
                            item_by_n
                                .get(a)
                                .is_some_and(|x| x.state == PlanItemState::Open)
                        })
                        .map(|a| PlanItemId::unchecked(format!("P{a}")))
                        .collect();
                    next.push(NextRow {
                        item_id: id,
                        workstream_id: ws.map(WorkstreamId::unchecked),
                        title: line(&i.data.title),
                        after: capped::<_, 5>(after).0,
                    });
                }
            }
        }
    }
    for o in &virtuals {
        let title = crate::hub::orders::short_title(&o.w);
        if w.placeholders.get(o.id()).is_some_and(|p| p.done) {
            let at = parse_ms(o.w.updated_at.as_str()).unwrap_or(now);
            done.push((
                at,
                DoneRow {
                    item_id: None,
                    workstream_id: Some(o.w.workstream_id.clone()),
                    title: line(&title),
                    done_at: ts(at),
                    evidence: line("every done-when check passed"),
                },
            ));
        } else {
            let (tasks, changes) = live_work(o.id());
            in_progress.push(InProgressRow {
                item_id: None,
                workstream_id: o.w.workstream_id.clone(),
                title: line(&title),
                task_ids: capped::<_, 10>(tasks.into_iter().map(TaskId::unchecked).collect()).0,
                change_ids: capped::<_, 10>(changes.into_iter().map(ChangeId::unchecked).collect())
                    .0,
                gate: gate_of(o.id()).map(|g| line(&g)),
                eta: None,
                overdue_minutes: None,
                stale: order_stale(o.id()),
                steers: None,
                ..unit_fields(super::model::UnitKey::Order(o.id().to_owned()), &[])
            });
        }
    }
    done.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    // Each order's latest steers, on its first in-progress row.
    let mut steered: HashSet<String> = HashSet::new();
    for row in &mut in_progress {
        if !steered.insert(row.workstream_id.to_string()) {
            continue;
        }
        let list: Vec<StatusSteer> = w
            .steers
            .iter()
            .filter(|x| x.workstream_id == row.workstream_id)
            .take(3)
            .map(status_steer)
            .collect();
        if !list.is_empty() {
            row.steers = Some(List::unchecked(list));
        }
    }

    // Gates: plan gates (an in-progress item others wait on), then each open order's phase.
    let mut gates: Vec<Gate> = Vec::new();
    for i in s
        .items
        .iter()
        .filter(|i| i.state == PlanItemState::Open && i.started_ms.is_some())
    {
        let waiting = s
            .items
            .iter()
            .filter(|x| x.state == PlanItemState::Open && x.data.after.contains(&i.n))
            .count();
        if waiting == 0 {
            continue;
        }
        let others = s
            .items
            .iter()
            .filter(|x| {
                x.state == PlanItemState::Open && x.n != i.n && x.workstream_id == i.workstream_id
            })
            .count();
        gates.push(Gate {
            kind: GateKind::Plan,
            label: line(&format!("P{} {}", i.n, i.data.title)),
            serial: waiting >= others,
            since: i.started_ms.map(ts),
            item_id: Some(PlanItemId::unchecked(format!("P{}", i.n))),
            workstream_id: i.workstream_id.as_deref().map(WorkstreamId::unchecked),
        });
    }
    for o in s
        .orders
        .iter()
        .filter(|o| o.w.state != WorkstreamState::Done)
    {
        if let Some(g) = gate_of(o.id()) {
            gates.push(Gate {
                kind: GateKind::Phase,
                label: line(&format!("{}: {g}", o.id())),
                serial: false,
                since: None,
                item_id: None,
                workstream_id: Some(o.w.workstream_id.clone()),
            });
        }
    }
    gates.sort_by_key(|g| (!g.serial, g.kind != GateKind::Plan));
    gates.truncate(3);

    // Needs you: open requests in scope, oldest first.
    let mut requests: Vec<&HumanRequest> = w
        .requests
        .iter()
        .filter(|a| match scope {
            StatusScope::Fleet => true,
            StatusScope::Project { project_ref } => &a.project_ref == project_ref,
            StatusScope::Order { workstream_id } => a.workstream_id.as_ref() == Some(workstream_id),
        })
        .collect();
    requests.sort_by_key(|a| a.created_at.as_str().to_owned());
    let needs_you = NeedsYou {
        count: Count::unchecked(requests.len() as i64),
        request_ids: capped::<ChatRequestId, 10>(requests.iter().map(|a| a.request_id.clone()).collect()).0,
    };

    // Risks.
    let tasks_waiting = |m: &str| -> i64 {
        s.orders
            .iter()
            .filter(|o| o.pkey.split_once('/').is_some_and(|(om, _)| om == m))
            .filter_map(|o| w.cards.get(o.id()))
            .map(|c| {
                c.lanes
                    .iter()
                    .filter(|l| !crate::hub::orders::phase::settled(l.status))
                    .count() as i64
            })
            .sum()
    };
    if let Some(t) = w.slots_queued_since {
        wake.at(t + risks::SLOTS_FULL_MS);
    }
    for o in &virtuals {
        if let Some(e) = w.estimates.iter().find(|e| e.ws == o.id()) {
            wake.at(e.started_ms + risks::NO_PLAN_MS);
        }
    }
    for a in &requests {
        if let Some(c) = parse_ms(a.created_at.as_str()) {
            wake.at(c + risks::BLOCKED_MS);
        }
    }
    let at_clock = |t: &Option<Timestamp>| {
        t.as_ref()
            .and_then(|t| parse_ms(t.as_str()))
            .map_or_else(|| "now".to_owned(), |t| clock(t, now, tz))
    };
    let mut steers_unacked = Vec::new();
    for x in w
        .steers
        .iter()
        .filter(|x| s.orders.iter().any(|o| o.id() == x.workstream_id.as_str()))
    {
        let sent = parse_ms(x.queued_at.as_str()).unwrap_or(now);
        let late = match x.stage {
            fleetd_contracts::steer::SteerStage::Unacknowledged => true,
            fleetd_contracts::steer::SteerStage::Delivered => {
                let at = x
                    .delivered_at
                    .as_ref()
                    .and_then(|t| parse_ms(t.as_str()))
                    .unwrap_or(sent);
                wake.at(at + risks::STEER_ACK_MS);
                now - at >= risks::STEER_ACK_MS
            }
            _ => false,
        };
        if late {
            let to = match &x.target {
                fleetd_contracts::steer::SteerTarget::Lead { .. } => "the lead".to_owned(),
                fleetd_contracts::steer::SteerTarget::Task { task_id } => task_id.to_string(),
            };
            steers_unacked.push((x.id.to_string(), to, clock(sent, now, tz)));
        }
    }
    let rf = RiskFacts {
        ci_red: ci
            .iter()
            .filter(|c| c.state == CiState::Red)
            .map(|c| {
                (
                    c.repo.to_string(),
                    c.failing.iter().map(|f| f.to_string()).collect(),
                    at_clock(&c.since),
                )
            })
            .collect(),
        machines_down: machines
            .iter()
            .filter(|m| m.status != MachineStatus::Online)
            .map(|m| {
                let status = if m.status == MachineStatus::Offline {
                    "offline"
                } else {
                    "degraded"
                };
                (
                    m.machine_id.to_string(),
                    status.to_owned(),
                    format!("since {}", at_clock(&m.last_seen_at)),
                    tasks_waiting(m.machine_id.as_str()),
                )
            })
            .collect(),
        blocked_requests: requests
            .iter()
            .map(|a| {
                let ws = a
                    .workstream_id
                    .as_ref()
                    .map_or_else(|| "the project".to_owned(), |w| w.to_string());
                let what = match (&a.secret, &a.gated) {
                    (Some(secret), _) => format!("the secret `{}`", secret.key),
                    (_, Some(_)) => "a command to approve".to_owned(),
                    _ => "a tool prompt to approve".to_owned(),
                };
                (
                    what,
                    ws,
                    now - parse_ms(a.created_at.as_str()).unwrap_or(now),
                )
            })
            .collect(),
        open_must,
        ci_repeat: ci_repeat(w, &s),
        flaky: machines
            .iter()
            .filter(|m| m.drops_today.get() >= 2)
            .map(|m| {
                let mid = m.machine_id.as_str();
                let last = w.recent.iter().rev().find(|(t, e)| {
                    (t == "machine.offline" || t == "machine.slept") && of_machine(e, mid)
                });
                let at = last
                    .and_then(|(_, e)| e.get("at")?.as_str().and_then(parse_ms))
                    .unwrap_or(now);
                let dur = m.slept.map_or_else(
                    || "—".to_owned(),
                    |s| hours(s.to_ms.get() - s.from_ms.get()),
                );
                (mid.to_owned(), m.drops_today.get(), clock(at, now, tz), dur)
            })
            .collect(),
        usage: usage
            .values()
            .map(|u| {
                let flagged = matches!(u.status.as_str(), "allowed_warning" | "rejected");
                let resets = u
                    .resets_at
                    .as_ref()
                    .and_then(|r| parse_ms(r.as_str()))
                    .map_or_else(|| "later".to_owned(), |r| clock(r, now, tz));
                (
                    usage_label(&u.limit_type),
                    u.utilization.as_ref().map_or(0.0, |x| x.get()),
                    flagged,
                    resets,
                )
            })
            .collect(),
        slots_queued: w
            .slots_queued_since
            .map(|t| (now - t, w.slots.queued.get(), w.slots.cap.get())),
        missed_webhooks_today: repos
            .iter()
            .map(|r| i64::from(hub.train.drift_counts(r, now - DAY_MS).missed_webhook))
            .sum(),
        no_plan: virtuals
            .iter()
            .filter(|o| o.w.state != WorkstreamState::Done)
            .filter_map(|o| {
                let started = w
                    .estimates
                    .iter()
                    .find(|e| e.ws == o.id())
                    .map(|e| e.started_ms)
                    .or_else(|| parse_ms(o.w.created_at.as_str()))?;
                Some((o.id().to_owned(), format!("{:?}", o.tier()), now - started))
            })
            .collect(),
        steers_unacked,
        train_stuck: w
            .model
            .changes
            .iter()
            .filter(|c| matches!(c.state, ChangeState::Queued | ChangeState::Ready))
            .filter(|c| {
                s.orders
                    .iter()
                    .any(|o| o.w.workstream_id == c.workstream_id)
            })
            .filter_map(|c| {
                let error = c.last_error.as_ref()?.as_str();
                (!error.is_empty()).then(|| {
                    (
                        c.pr_number.get(),
                        c.project_ref.machine_id.to_string(),
                        error.to_owned(),
                    )
                })
            })
            .collect(),
        slower: mo
            .slower
            .iter()
            .map(|(label, stage, elapsed)| {
                (
                    clip(label, 80),
                    super::estimate::stage_phrase(*stage).to_owned(),
                    risks::age(*elapsed),
                )
            })
            .collect(),
    };
    let (risk_list, risks_more) = capped::<_, 5>(risks::risks(&rf));

    // Parts: the fleet's projects; a project's open milestones; an order's milestones.
    let mut parts = Vec::new();
    match scope {
        StatusScope::Fleet => {
            let mut pks: Vec<&String> = s.pkeys.iter().collect();
            pks.sort();
            for pk in pks {
                let child = StatusScope::Project {
                    project_ref: plan::store::project_ref(pk),
                };
                let Some(cs) = scope_of(w, &child) else {
                    continue;
                };
                let cf = figure(w, &cs, &virtual_orders(w, &cs));
                if cf.must_total + cf.polish_total == 0 {
                    continue;
                }
                let marker = w.markers.iter().find(|m| &m.pkey == pk).map(marker_of);
                let mut progress = progress_of(&cf, now, marker);
                // The project's bar under the same drop rule as its own doc (the same stored series), so it never
                // falls without a marker; a part carries no sparkline of its own.
                let cmo = super::estimate::compute(w, &child, &cs);
                let ccauses = super::estimate::causes(w, &child, &cs);
                let ckey = child.key();
                let cseries = hub
                    .db
                    .with(|c| {
                        Ok(super::estimate::series(
                            c,
                            &ckey,
                            cmo.estimate,
                            &ccauses,
                            now,
                        )?)
                    })
                    .ok();
                let mut estimate = super::estimate::estimate_of(&cmo, cseries.as_deref());
                estimate.series = None;
                progress.estimate = Some(estimate);
                parts.push(ScopePart {
                    title: line(&cs.title),
                    scope: Some(child),
                    milestone_id: None,
                    progress,
                    eta: None,
                });
            }
        }
        _ => {
            let order_scope = matches!(scope, StatusScope::Order { .. });
            for m in w
                .milestones
                .iter()
                .filter(|m| s.pkeys.contains(&m.pkey) && (order_scope || m.done_ms.is_none()))
            {
                let mine: Vec<ItemRow> = s
                    .history
                    .iter()
                    .filter(|i| i.milestone == m.n)
                    .map(|i| (*i).clone())
                    .collect();
                if mine.is_empty() && order_scope {
                    continue;
                }
                let marker = w.markers.iter().find(|c| c.milestone == m.n).map(marker_of);
                parts.push(ScopePart {
                    title: line(&format!("M{} {}", m.n, m.title)),
                    scope: None,
                    milestone_id: Some(fleetd_contracts::plan::MilestoneId::unchecked(format!(
                        "M{}",
                        m.n
                    ))),
                    progress: progress_of(&figure_of(&mine), now, marker),
                    eta: None,
                });
            }
        }
    }
    let (parts, parts_more) = capped::<_, 20>(parts);

    // The figure goes stale with the GitHub sources of the scope's Changes.
    let mut progress: Progress = progress_of(&f, now, markers.first().cloned());
    progress.stale = s
        .pkeys
        .iter()
        .filter_map(|pk| w.change_repos.get(pk))
        .flatten()
        .find_map(|r| github_stale.get(r).cloned());
    // The estimate's series, with the drop rule applied: it falls only with an observed cause, which it shows.
    let causes = super::estimate::causes(w, scope, &s);
    let key = scope.key();
    let series = hub
        .db
        .with(|c| {
            super::estimate::store_planning(c, &mo.fix_planning)?;
            Ok(super::estimate::series(c, &key, mo.estimate, &causes, now)?)
        })
        .ok();
    progress.estimate = Some(super::estimate::estimate_of(&mo, series.as_deref()));

    let doing: Vec<String> = in_progress
        .iter()
        .take(3)
        .map(|r| lower_first(r.title.as_str()))
        .collect();
    let (in_progress, ip_more) = capped::<_, 20>(in_progress);
    let (next, next_more) = capped::<_, 10>(next);
    let (done, done_more) = capped::<_, 10>(done.into_iter().map(|(_, d)| d).collect());

    let facts = HeadlineFacts {
        scope: match scope {
            StatusScope::Fleet => "fleet".into(),
            StatusScope::Project { .. } => format!("project {}", s.title),
            StatusScope::Order { .. } => format!("order {}", s.title),
        },
        pct: f.pct(),
        was: markers
            .first()
            .and_then(|m| m.pct_before.as_ref().map(|p| p.get())),
        scope_change: markers.first().map(|m| m.text.to_string()),
        doing,
        waiting_on: gates.iter().take(2).map(|g| g.label.to_string()).collect(),
        needs_you: requests.len() as i64,
        risks: risk_list
            .iter()
            .take(2)
            .map(|r| r.message.to_string())
            .collect(),
    };

    let doc = StatusDoc {
        scope: scope.clone(),
        title: line(&s.title),
        version: Count::unchecked(0),
        seq: fleetd_contracts::ids::EventSeq(Count::unchecked(seq)),
        now: ts(now),
        progress,
        markers: capped::<_, 3>(markers).0,
        eta: retired_eta(),
        gates: List::try_from(gates).unwrap_or_default(),
        headline: Headline {
            text: line("…"),
            source: HeadlineSource::Template,
            reason: None,
            prompt_ref: None,
            at: ts(now),
        },
        since: Default::default(),
        parts,
        done,
        in_progress,
        next,
        needs_you,
        risks: risk_list,
        health: Health {
            ci: capped::<_, 10>(ci).0,
            machines: capped::<_, 20>(machines).0,
            usage: capped::<_, 4>(usage.into_values().collect()).0,
            slots: HealthSlots {
                running: w.slots.used,
                used: w.slots.used,
                cap: w.slots.cap,
                queued: w.slots.queued,
                utilization: Some(SlotUtilization {
                    window_ms: Count::unchecked(w.slot_use.window_ms.max(0)),
                    pct: Int::unchecked(w.slot_use.pct.clamp(0, 100)),
                    peak: Count::unchecked(w.slot_use.peak.max(0)),
                }),
            },
        },
        stale: stale_list,
        more: MoreCounts {
            done: Count::unchecked(done_more),
            in_progress: Count::unchecked(ip_more),
            next: Count::unchecked(next_more),
            risks: Count::unchecked(risks_more),
            parts: Count::unchecked(parts_more),
            stale: Count::unchecked(stale_more),
        },
        virtual_tier: match scope {
            StatusScope::Order { .. } => virtuals.first().map(|o| o.tier()),
            _ => None,
        },
    };
    Some(Rendered {
        doc,
        facts,
        wake_at: wake.0,
    })
}

/// What a doc may weigh on the wire, with room for the caller's since-you-looked counts.
pub const MAX_DOC_BYTES: usize = fleetd_contracts::live::LIVE_MAX_FRAME_BYTES - 512;

fn pop<T: Clone, const MAX: usize>(list: &mut List<T, 0, MAX>, more: &mut Count) -> bool {
    let mut v = std::mem::take(list).into_inner();
    let popped = v.pop().is_some();
    if popped {
        *more = Count::unchecked(more.get() + 1);
    }
    *list = List::unchecked(v);
    popped
}

/// Trims list tails, least important first, into `more` until the doc fits [`MAX_DOC_BYTES`].
pub fn fit(doc: &mut StatusDoc) {
    let size = |d: &StatusDoc| serde_json::to_vec(d).map_or(0, |v| v.len());
    while size(doc) > MAX_DOC_BYTES {
        // The sparkline keeps its shape with a dozen points: its oldest go first.
        if let Some(series) = doc
            .progress
            .estimate
            .as_mut()
            .and_then(|e| e.series.as_mut())
            && series.len() > 12
        {
            let mut v = std::mem::take(series).into_inner();
            v.remove(0);
            *series = List::unchecked(v);
            continue;
        }
        let more = &mut doc.more;
        let trimmed = pop(&mut doc.done, &mut more.done)
            || pop(&mut doc.next, &mut more.next)
            || (doc.in_progress.len() > 5 && pop(&mut doc.in_progress, &mut more.in_progress))
            || pop(&mut doc.parts, &mut more.parts)
            || (doc.stale.len() > 3 && pop(&mut doc.stale, &mut more.stale))
            || {
                let mut ci = std::mem::take(&mut doc.health.ci).into_inner();
                let cut = ci
                    .iter_mut()
                    .rev()
                    .find(|c| !c.failing.is_empty())
                    .map(|c| {
                        let mut f = std::mem::take(&mut c.failing).into_inner();
                        f.pop();
                        c.failing = List::unchecked(f);
                    });
                doc.health.ci = List::unchecked(ci);
                cut.is_some()
            }
            || pop(&mut doc.in_progress, &mut more.in_progress)
            || pop(&mut doc.risks, &mut more.risks)
            || pop(&mut doc.stale, &mut more.stale)
            || {
                let mut m = std::mem::take(&mut doc.health.machines).into_inner();
                let cut = m.pop().is_some();
                doc.health.machines = List::unchecked(m);
                cut
            };
        if !trimmed {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clock_text_is_absolute_in_the_hub_zone() {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        let now = parse_ms("2026-10-18T12:02:07.000Z").unwrap();
        assert_eq!(clock(now, now, tz), "14:02");
        assert_eq!(clock(now + 4 * DAY_MS, now, tz), "Thu 14:02");
        assert_eq!(clock(now + 30 * DAY_MS, now, tz), "Nov 17 13:02");
        assert_eq!(duration(6 * 3_600_000), "+6h");
        assert_eq!(duration(-40 * 60_000), "−40m");
    }

    #[test]
    fn a_doc_filled_to_the_contract_maxima_is_trimmed_to_the_frame_cap() {
        let long = |n: usize| "x".repeat(n);
        let stale = json!({ "since": "2026-10-18T10:00:00.000Z", "reason": long(200) });
        let row = json!({ "itemId": "P1", "workstreamId": "W1", "title": long(120), "taskIds": ["T1", "T2"],
            "changeIds": ["X1"], "gate": long(160), "eta": "2026-10-18T10:00:00.000Z", "stale": stale });
        let progress = json!({ "pct": 50, "done": 1, "total": 2, "polishDone": 0, "polishTotal": 0, "asOf": "2026-10-18T10:00:00.000Z", "stale": stale });
        let doc = json!({
            "scope": { "kind": "fleet" }, "title": "Fleet", "version": 1, "seq": 1, "now": "2026-10-18T10:00:00.000Z",
            "progress": progress, "markers": [], "eta": { "samples": 0, "basis": "none" }, "gates": [],
            "headline": { "text": long(400), "source": "template", "at": "2026-10-18T10:00:00.000Z" },
            "since": { "merged": 0, "verified": 0, "started": 0, "failed": 0, "scopeItems": 0 },
            "parts": vec![json!({ "title": long(120), "progress": progress }); 20],
            "done": vec![json!({ "title": long(120), "doneAt": "2026-10-18T10:00:00.000Z", "evidence": long(200) }); 10],
            "inProgress": vec![row; 20],
            "next": vec![json!({ "itemId": "P2", "title": long(120), "after": [] }); 10],
            "needsYou": { "count": 0, "requestIds": [] },
            "risks": vec![json!({ "rule": "no_plan", "level": "warning", "message": long(200) }); 5],
            "health": {
                "ci": vec![json!({ "repo": "acme/storefront", "state": "red", "failing": vec![long(120); 10], "stale": stale }); 10],
                "machines": vec![json!({ "machineId": "devbox", "status": "offline", "dropsToday": 2, "stale": stale }); 20],
                "usage": [], "slots": { "running": 0, "used": 0, "cap": 40, "queued": 0 },
            },
            "stale": vec![json!({ "source": "machine:devbox", "since": "2026-10-18T10:00:00.000Z", "reason": long(200) }); 10],
            "more": { "done": 0, "inProgress": 0, "next": 0, "risks": 0, "parts": 0, "stale": 0 },
        });
        let mut doc: StatusDoc = serde_json::from_value(doc).unwrap();
        let point = json!({ "at": "2026-10-18T10:00:00.000Z", "pct": 50, "verifiedPct": 20,
            "drop": { "reason": "scope_change", "fromPct": 60, "text": long(200) } });
        doc.progress.estimate = Some(
            serde_json::from_value(
                json!({ "pct": 50, "verifiedPct": 20, "inFlightPct": 30, "weights": "default",
                "series": vec![point; super::super::estimate::DOC_SERIES] }),
            )
            .unwrap(),
        );
        assert!(serde_json::to_vec(&doc).unwrap().len() > 40 * 1024);
        fit(&mut doc);
        assert!(serde_json::to_vec(&doc).unwrap().len() <= MAX_DOC_BYTES);
        let series = doc
            .progress
            .estimate
            .as_ref()
            .and_then(|e| e.series.as_ref())
            .unwrap();
        assert_eq!(series.len(), 12, "the sparkline keeps a dozen points");
        assert_eq!(
            (doc.more.done.get(), doc.more.next.get()),
            (10, 10),
            "least important first"
        );
        assert_eq!(
            doc.in_progress.len() as i64 + doc.more.in_progress.get(),
            20,
            "every trimmed row is counted"
        );
    }
}
