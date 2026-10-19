//! Builds a scope's status doc from one read of the hub (the world), within the doc's caps. Everything time-like is
//! an absolute time in the hub's zone, so nothing in a doc ages; clients tick ages from the as-of times.
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono_tz::Tz;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::ledger::{Ask, AskId, Tier, Workstream, WorkstreamId, WorkstreamState};
use fleetd_contracts::live::OrderCard;
use fleetd_contracts::model::{Machine, MachineStatus};
use fleetd_contracts::node_link::NodeLoad;
use fleetd_contracts::plan::{PlanChangeKind, PlanItemId, PlanItemState, Size, Weight};
use fleetd_contracts::prim::{Count, Int, Line, List, NonNegative, Text};
use fleetd_contracts::status::{
    CiState, DoneRow, EtaBasis, EtaSlip, Gate, GateKind, Headline, HeadlineFacts, HeadlineSource,
    Health, HealthCi, HealthMachine, HealthSlots, HealthUsage, InProgressRow, Marker, MoreCounts,
    NeedsYou, NextRow, Progress, ScopePart, SleptAt, StaleMark, StaleSource, StatusDoc, StatusEta,
    StatusScope, StatusSteer,
};
use fleetd_contracts::tasks::{SlotState, TaskId};
use fleetd_contracts::train::{ChangeId, ChangeState, GitHubRepo};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::eta::{self, ChainItem, Rate};
use super::fresh::{self, Fresh};
use super::progress::Figure;
use super::risks::{self, RiskFacts};
use crate::hub::api::Hub;
use crate::hub::plan::store::{ChangeRow, ItemRow, MilestoneRow};
use crate::hub::plan::{self, clip, figure_of, marker_of, parse_ms, progress_of};
use crate::hub::store::iso_ms;

const DAY_MS: i64 = 24 * 3_600_000;

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
    pub asks: Vec<Ask>,
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
                    plan::store::items_live(c, now - eta::WINDOW_MS)?,
                    plan::store::milestones_all(c)?,
                    plan::store::changes_all(c, 200)?,
                    estimate_rows(c, now - eta::WINDOW_MS)?,
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
        let asks = hub
            .leads
            .ctx
            .ports()
            .open_asks(None, None, 500)
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
        let model = hub.db.with(|c| {
            Ok(super::estimate::ModelData::read(
                c,
                &orders,
                &since_iso,
                calibration,
            )?)
        })?;
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
            asks,
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

fn rate_of(w: &World, pkeys: Option<&HashSet<String>>, ws: Option<&str>) -> Rate {
    let from = w.now - eta::WINDOW_MS;
    let in_scope = |pk: &str, iws: Option<&str>| {
        pkeys.is_none_or(|p| p.contains(pk)) && ws.is_none_or(|ws| iws == Some(ws))
    };
    let planned: HashSet<&str> = w
        .items
        .iter()
        .filter_map(|i| i.workstream_id.as_deref())
        .collect();
    let mut r = Rate::default();
    for i in w
        .items
        .iter()
        .filter(|i| i.state == PlanItemState::Done && i.done_ms.is_some_and(|d| d >= from))
    {
        if in_scope(&i.pkey, i.workstream_id.as_deref()) {
            r.points += i.size.points();
            r.samples += 1;
        }
    }
    let mut busy = Vec::new();
    for e in w
        .estimates
        .iter()
        .filter(|e| in_scope(&e.pkey, Some(&e.ws)))
    {
        busy.push((e.started_ms, e.done_ms));
        if !planned.contains(e.ws.as_str()) && e.done_ms.is_some_and(|d| d >= from) {
            r.points += e.tier.points();
            r.samples += 1;
        }
    }
    r.busy_ms = eta::busy_ms(&busy, w.now);
    r
}

/// Median start-to-done of the last 20 done items of each size.
fn durations(items: &[&ItemRow]) -> HashMap<Size, i64> {
    let mut by: HashMap<Size, Vec<(i64, i64)>> = HashMap::new();
    for i in items {
        if let (Some(s), Some(d)) = (i.started_ms, i.done_ms) {
            by.entry(i.size).or_default().push((d, d - s));
        }
    }
    by.into_iter()
        .filter_map(|(size, mut v)| {
            v.sort_by_key(|(d, _)| std::cmp::Reverse(*d));
            Some((
                size,
                eta::median(v.into_iter().take(20).map(|(_, d)| d).collect())?,
            ))
        })
        .collect()
}

struct EtaOut {
    eta: StatusEta,
    slipped: Option<(String, String, String)>,
    drift: Option<(String, String)>,
}

fn eta_of(hub: &Hub, w: &World, scope: &StatusScope, s: &Scope<'_>, f: &Figure) -> EtaOut {
    let fleet = rate_of(w, None, None);
    let project = rate_of(w, Some(&s.pkeys), None);
    let running_in = |pkeys: Option<&HashSet<String>>| {
        w.orders
            .iter()
            .filter(|o| {
                o.w.state != WorkstreamState::Done && pkeys.is_none_or(|p| p.contains(&o.pkey))
            })
            .count()
            .max(1) as f64
    };
    let (rate, samples, basis) = match scope {
        StatusScope::Order { workstream_id } => {
            let own = rate_of(w, Some(&s.pkeys), Some(workstream_id.as_str()));
            let done_items = s
                .history
                .iter()
                .filter(|i| i.state == PlanItemState::Done)
                .count();
            match (own.per_hour(), project.per_hour(), fleet.per_hour()) {
                (Some(r), _, _) if done_items >= 3 => (Some(r), own.samples, EtaBasis::Order),
                (_, Some(r), _) => (
                    Some(r / running_in(Some(&s.pkeys))),
                    project.samples,
                    EtaBasis::Project,
                ),
                (_, _, Some(r)) => (Some(r / running_in(None)), fleet.samples, EtaBasis::Fleet),
                _ => (
                    None,
                    own.samples.max(project.samples).max(fleet.samples),
                    EtaBasis::None,
                ),
            }
        }
        StatusScope::Project { .. } => match (project.per_hour(), fleet.per_hour()) {
            (Some(r), _) => (Some(r), project.samples, EtaBasis::Project),
            (_, Some(r)) => (
                Some(r * running_in(Some(&s.pkeys)) / running_in(None)),
                fleet.samples,
                EtaBasis::Fleet,
            ),
            _ => (None, project.samples.max(fleet.samples), EtaBasis::None),
        },
        StatusScope::Fleet => match fleet.per_hour() {
            Some(r) => (Some(r), fleet.samples, EtaBasis::Fleet),
            None => (None, fleet.samples, EtaBasis::None),
        },
    };
    let throughput = rate.map(|r| eta::throughput_eta(w.now, f.remaining_must_pts(), r));
    let open_must: Vec<ChainItem> = s
        .items
        .iter()
        .filter(|i| i.state == PlanItemState::Open && i.weight == Weight::Must)
        .map(|i| ChainItem {
            n: i.n,
            size: i.size,
            started_ms: i.started_ms,
            after: i.data.after.clone(),
        })
        .collect();
    let d = durations(&s.history);
    let chain = if open_must.is_empty() {
        None
    } else {
        eta::chain(&open_must, &d, w.now)
    };
    let chain_eta = chain.as_ref().map(|(len, _)| w.now + len);
    let current = match (throughput, chain_eta) {
        (Some(t), Some(c)) => Some(t.max(c)),
        (t, _) => t,
    };
    let chain_label = match (&chain, throughput, chain_eta) {
        (Some((_, path)), Some(t), Some(c)) if c > t => path.first().and_then(|n| {
            let i = w.items.iter().find(|i| i.n == *n)?;
            Some(line::<160>(&format!("P{} {}", i.n, i.data.title)))
        }),
        _ => None,
    };
    let key = scope.key();
    let mut original = None;
    if let (Some(cur), StatusScope::Order { .. }) = (current, scope)
        && samples >= eta::MIN_SAMPLES
    {
        let basis_text = serde_json::to_value(basis)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        original = hub
            .db
            .with(|c| {
                c.prepare_cached(
                    "INSERT OR IGNORE INTO status_eta (scope, original_ms, set_ms, basis) VALUES (?, ?, ?, ?)",
                )?
                .execute(params![key, cur, w.now, basis_text])?;
                Ok(c.query_row("SELECT original_ms, set_ms FROM status_eta WHERE scope = ?", [&key], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
                .optional()?)
            })
            .ok()
            .flatten();
    }
    let mut slip = None;
    let mut slipped = None;
    if let (Some(cur), Some((orig, set_ms))) = (current, original) {
        let scope_pts: i64 = w
            .markers
            .iter()
            .filter(|m| {
                m.at_ms >= set_ms && m.kind == PlanChangeKind::Scope && s.pkeys.contains(&m.pkey)
            })
            .filter(|m| match scope {
                StatusScope::Order { workstream_id } => {
                    m.workstream_id.as_deref() == Some(workstream_id.as_str())
                }
                _ => true,
            })
            .map(|m| m.delta_size)
            .sum();
        let (sc, sp) = eta::slip(cur, orig, scope_pts, rate);
        if cur != orig {
            slip = Some(EtaSlip {
                scope_minutes: Int::unchecked(sc),
                speed_minutes: Int::unchecked(sp),
            });
        }
        let started = s
            .orders
            .first()
            .and_then(|o| parse_ms(o.w.created_at.as_str()))
            .unwrap_or(set_ms);
        if eta::slipping(cur, orig, started) {
            slipped = Some((
                duration(cur - orig),
                duration(sc * 60_000),
                duration(sp * 60_000),
            ));
        }
    }
    let mut lead = None;
    let mut drift = None;
    if let StatusScope::Order { workstream_id } = scope
        && let Some(o) = s.orders.first()
        && let Ok(Some(est)) = hub.estimates.eta(&o.w)
        && let Some(e) = w.estimates.iter().find(|e| e.ws == workstream_id.as_str())
        && let Some(cur) = current
    {
        let lead_done = e.started_ms + (est.calibrated_minutes.get() * 60_000.0) as i64;
        if eta::lead_differs(lead_done, cur, e.started_ms) {
            lead = Some(ts(lead_done));
            drift = Some((
                format!(
                    "{} (×{} calibrated)",
                    hours(lead_done - e.started_ms),
                    est.ratio.get()
                ),
                hours(cur - e.started_ms),
            ));
        }
    }
    EtaOut {
        eta: StatusEta {
            current: current.map(ts),
            original: original.map(|(o, _)| ts(o)),
            slip,
            lead,
            rate: rate.and_then(|r| NonNegative::new((r * 10.0).round() / 10.0).ok()),
            samples: Count::unchecked(samples),
            basis,
            chain: chain_label,
            p50: None,
            p90: None,
            accuracy: None,
        },
        slipped,
        drift,
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
    let unit_fields = |key: super::model::UnitKey| {
        let p = mo.units.get(&key);
        (
            p.map(|p| p.stage),
            p.map(|p| Int::unchecked(((p.credit * 100.0).floor() as i64).clamp(0, 100))),
            p.map(|p| p.slower).filter(|s| *s),
        )
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
    let d = durations(&s.history);
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
                    let eta_ms = i.started_ms.and_then(|s0| d.get(&i.size).map(|d| s0 + d));
                    if let Some(e) = eta_ms {
                        wake.at(e);
                    }
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
                        eta: eta_ms.map(ts),
                        overdue_minutes: eta_ms
                            .filter(|e| *e < now)
                            .map(|e| Count::unchecked((now - e) / 60_000)),
                        stale: ws.and_then(order_stale),
                        steers: None,
                        stage: unit_fields(super::model::UnitKey::Item(i.n)).0,
                        credit_pct: unit_fields(super::model::UnitKey::Item(i.n)).1,
                        slower_than_usual: unit_fields(super::model::UnitKey::Item(i.n)).2,
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
                stage: unit_fields(super::model::UnitKey::Order(o.id().to_owned())).0,
                credit_pct: unit_fields(super::model::UnitKey::Order(o.id().to_owned())).1,
                slower_than_usual: unit_fields(super::model::UnitKey::Order(o.id().to_owned())).2,
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

    // Needs you: open asks in scope, blocking first.
    let mut asks: Vec<&Ask> = w
        .asks
        .iter()
        .filter(|a| match scope {
            StatusScope::Fleet => true,
            StatusScope::Project { project_ref } => a.project_ref.as_ref() == Some(project_ref),
            StatusScope::Order { workstream_id } => a.workstream_id.as_ref() == Some(workstream_id),
        })
        .collect();
    asks.sort_by_key(|a| a.blocks.as_str() == "nothing");
    let needs_you = NeedsYou {
        count: Count::unchecked(asks.len() as i64),
        ask_ids: capped::<AskId, 10>(asks.iter().map(|a| a.ask_id.clone()).collect()).0,
    };

    let mut eta_out = eta_of(hub, w, scope, &s, &f);
    eta_out.eta.p50 = mo.p50.map(ts);
    eta_out.eta.p90 = mo.p90.map(ts);
    eta_out.eta.accuracy = super::estimate::accuracy(&w.model.calibration);

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
    for a in &asks {
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
        blocked_asks: asks
            .iter()
            .filter(|a| a.blocks.as_str() != "nothing" && !a.proceeded_on_rec)
            .map(|a| {
                let ws = a
                    .workstream_id
                    .as_ref()
                    .map_or_else(|| "the project".to_owned(), |w| w.to_string());
                (
                    a.key.to_string(),
                    ws,
                    now - parse_ms(a.created_at.as_str()).unwrap_or(now),
                )
            })
            .collect(),
        slip: eta_out.slipped.clone(),
        estimate_drift: eta_out.drift.clone(),
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
        slower: mo
            .slower
            .iter()
            .map(|(label, stage, elapsed, usual)| {
                (
                    clip(label, 80),
                    super::estimate::stage_phrase(*stage).to_owned(),
                    risks::age(*elapsed),
                    risks::age(*usual),
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
                let ce = eta_of(hub, w, &child, &cs, &cf);
                let mut progress = progress_of(&cf, now, marker);
                progress.estimate = Some(super::estimate::estimate_of(
                    &super::estimate::compute(w, &child, &cs),
                    None,
                ));
                parts.push(ScopePart {
                    title: line(&cs.title),
                    scope: Some(child),
                    milestone_id: None,
                    progress,
                    eta: ce.eta.current,
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
        needs_you: asks.len() as i64,
        first_ask: asks.first().map(|a| a.key.to_string()),
        eta: eta_out
            .eta
            .current
            .as_ref()
            .and_then(|t| parse_ms(t.as_str()))
            .map(|t| clock(t, now, tz)),
        planned: eta_out
            .eta
            .original
            .as_ref()
            .and_then(|t| parse_ms(t.as_str()))
            .map(|t| clock(t, now, tz)),
        slipped: eta_out.slipped.is_some(),
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
        eta: eta_out.eta,
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
            "since": { "merged": 0, "verified": 0, "started": 0, "failed": 0, "asked": 0, "scopeItems": 0 },
            "parts": vec![json!({ "title": long(120), "progress": progress }); 20],
            "done": vec![json!({ "title": long(120), "doneAt": "2026-10-18T10:00:00.000Z", "evidence": long(200) }); 10],
            "inProgress": vec![row; 20],
            "next": vec![json!({ "itemId": "P2", "title": long(120), "after": [] }); 10],
            "needsYou": { "count": 0, "askIds": [] },
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
