//! Plans: a project's milestones and items. Leads add, edit and drop through `fleetd plan …`; only [`Plans::verify`]
//! marks an item done, from train merges and claim results. Every change to an open milestone's total after its
//! planning window needs a reason and writes a marker, so a figure never jumps silently.
pub mod calls;
pub mod store;
pub mod tools;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{WorkstreamId, WorkstreamState};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::plan::{
    Milestone, MilestoneId, MilestoneState, MilestoneView, PlanAddCall, PlanChange, PlanChangeKind,
    PlanDropCall, PlanEditCall, PlanItem, PlanItemId, PlanItemResult, PlanItemState,
    PlanMilestoneCall, PlanView, Weight,
};
use fleetd_contracts::prim::{AnyInt, Count, Int, Line, List, UniqueList};
use fleetd_contracts::status::{Marker, Progress};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::train::GitHubPrUrl;
use rusqlite::{Connection, OptionalExtension, params};

use crate::clock::Clock;
use crate::hub::status::progress::{self, CheckPass, Figure, LinkedChange};
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};
use store::{ChangeRow, ItemData, ItemRow, MilestoneRow, pkey};

/// A refusal with its fix, or a store failure (logged, answered as `failed`).
#[derive(Debug)]
pub struct PlanError(pub McpToolError);

impl From<rusqlite::Error> for PlanError {
    fn from(e: rusqlite::Error) -> Self {
        failed(e)
    }
}

impl From<McpToolError> for PlanError {
    fn from(e: McpToolError) -> Self {
        Self(e)
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

fn failed(e: impl std::fmt::Display) -> PlanError {
    tracing::error!(error = %e, "plan store");
    PlanError(McpToolError::new(
        ErrorCode::Failed,
        "The hub failed to answer that request.",
    ))
}

fn invalid(message: impl Into<String>, fix: impl Into<String>) -> PlanError {
    PlanError(McpToolError::new(ErrorCode::Invalid, message).with_fix(fix))
}

fn not_found(message: impl Into<String>, fix: impl Into<String>) -> PlanError {
    PlanError(McpToolError::new(ErrorCode::NotFound, message).with_fix(fix))
}

fn forbidden(message: impl Into<String>, fix: impl Into<String>) -> PlanError {
    PlanError(McpToolError::new(ErrorCode::Forbidden, message).with_fix(fix))
}

pub fn number(id: &str) -> i64 {
    id.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// What the status view needs to know about an order.
#[derive(Clone, Debug)]
pub struct OrderInfo {
    pub workstream_id: String,
    pub pkey: String,
    pub state: WorkstreamState,
    pub title: String,
    pub tier: Option<fleetd_contracts::ledger::Tier>,
    pub created_ms: i64,
}

pub fn order_info(c: &Connection, ws: &str) -> rusqlite::Result<Option<OrderInfo>> {
    let row: Option<(String, String, String)> = c
        .prepare_cached("SELECT machine_id, project_id, data FROM workstreams WHERE n = ?")?
        .query_row([number(ws)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    Ok(row.and_then(|(m, p, data)| order_of(&format!("{m}/{p}"), &data)))
}

pub(crate) fn order_of(pkey: &str, data: &str) -> Option<OrderInfo> {
    let w: fleetd_contracts::ledger::Workstream = serde_json::from_str(data).ok()?;
    Some(OrderInfo {
        workstream_id: w.workstream_id.to_string(),
        pkey: pkey.to_owned(),
        state: w.state,
        title: w.title.to_string(),
        tier: w.brief.as_ref().map(|b| b.tier),
        created_ms: parse_ms(w.created_at.as_str()).unwrap_or(0),
    })
}

/// ISO 8601 UTC (as the hub writes it) to epoch ms.
pub fn parse_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// The latest result of each check index across an order's claims (newest claim that ran it wins).
pub fn latest_checks(c: &Connection, ws: &str) -> rusqlite::Result<HashMap<i64, CheckPass>> {
    let mut stmt = c.prepare_cached(
        "SELECT data FROM claims WHERE workstream_id = ? AND data IS NOT NULL ORDER BY n DESC LIMIT 20",
    )?;
    let mut out = HashMap::new();
    for data in stmt.query_map([ws], |r| r.get::<_, String>(0))? {
        let Ok(claim) = serde_json::from_str::<fleetd_contracts::verification::Claim>(&data?)
        else {
            continue;
        };
        for r in claim.results.iter() {
            out.entry(r.check_index.get()).or_insert_with(|| CheckPass {
                pass: r.result == fleetd_contracts::verification::CheckOutcome::Pass,
                claim_id: claim.claim_id.to_string(),
            });
        }
    }
    Ok(out)
}

/// Changes linked to an item: by its tasks (`Change.task_id`, the `changes_by_task` index) or its PR URLs
/// (`changes_by_pr`). Indexed lookups per link, so the cost doesn't grow with the project's history.
pub fn linked_changes(c: &Connection, item: &ItemRow) -> rusqlite::Result<Vec<LinkedChange>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |data: String, out: &mut Vec<LinkedChange>| {
        if let Ok(ch) = serde_json::from_str::<fleetd_contracts::train::Change>(&data)
            && seen.insert(ch.change_id.to_string())
            && plan_key_of(&ch.project_ref) == item.pkey
        {
            out.push(LinkedChange {
                change_id: ch.change_id.to_string(),
                pr_number: ch.pr_number.get(),
                state: ch.state,
            });
        }
    };
    for t in item.data.links.tasks.iter() {
        let mut stmt =
            c.prepare_cached("SELECT data FROM changes WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.taskId') END) = ?")?;
        for data in stmt.query_map([t.as_str()], |r| r.get::<_, String>(0))? {
            push(data?, &mut out);
        }
    }
    for pr in item.data.links.prs.iter() {
        let Some((repo, number)) = pr_parts(pr.as_str()) else {
            continue;
        };
        let mut stmt =
            c.prepare_cached("SELECT data FROM changes WHERE repo = ? AND pr_number = ?")?;
        for data in stmt.query_map(params![repo, number], |r| r.get::<_, String>(0))? {
            push(data?, &mut out);
        }
    }
    Ok(out)
}

fn plan_key_of(r: &ProjectRef) -> String {
    pkey(r)
}

/// `https://github.com/Owner/Repo/pull/12` → ("owner/repo", 12); the train stores repos lowercased.
fn pr_parts(url: &str) -> Option<(String, i64)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (owner, repo, pull, n) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    (pull == "pull").then(|| Some((format!("{owner}/{repo}").to_lowercase(), n.parse().ok()?)))?
}

pub fn figure_of(items: &[ItemRow]) -> Figure {
    let mut f = Figure::default();
    for i in items {
        f.add(i.weight, i.size, i.state);
    }
    f
}

pub fn progress_of(f: &Figure, as_of_ms: i64, marker: Option<Marker>) -> Progress {
    Progress {
        pct: Int::unchecked(f.pct()),
        polish_pct: f.polish_pct().map(Int::unchecked),
        done: Count::unchecked(f.must_done),
        total: Count::unchecked(f.must_total),
        polish_done: Count::unchecked(f.polish_done),
        polish_total: Count::unchecked(f.polish_total),
        as_of: Timestamp(iso_ms(as_of_ms)),
        marker,
        stale: None,
        estimate: None,
    }
}

pub fn marker_of(ch: &ChangeRow) -> Marker {
    Marker {
        at: Timestamp(iso_ms(ch.at_ms)),
        text: Line::unchecked(clip(&ch.note, 200)),
        pct_before: ch.pct_before.map(Int::unchecked),
        pct_after: ch.pct_after.map(Int::unchecked),
        delta_items: Int::unchecked(ch.delta_items),
    }
}

pub fn clip(s: &str, max: usize) -> String {
    let one_line: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if one_line.encode_utf16().count() <= max {
        return one_line;
    }
    let mut out = String::new();
    for ch in one_line.chars() {
        if out.encode_utf16().count() + ch.len_utf16() + 1 > max {
            break;
        }
        out.push(ch);
    }
    out + "…"
}

pub fn milestone_contract(m: &MilestoneRow, items: &[ItemRow]) -> Milestone {
    Milestone {
        milestone_id: MilestoneId::unchecked(format!("M{}", m.n)),
        project_ref: store::project_ref(&m.pkey),
        title: Line::unchecked(clip(&m.title, 120)),
        position: Count::unchecked(m.position.max(0)),
        state: if milestone_done(items) {
            MilestoneState::Done
        } else {
            MilestoneState::Open
        },
        created_at: Timestamp(iso_ms(m.created_ms)),
        first_item_at: m.first_item_ms.map(|t| Timestamp(iso_ms(t))),
        done_at: m.done_ms.map(|t| Timestamp(iso_ms(t))),
    }
}

/// Done when at least one item is done and every item is done or dropped.
pub fn milestone_done(items: &[ItemRow]) -> bool {
    items.iter().any(|i| i.state == PlanItemState::Done)
        && items.iter().all(|i| i.state != PlanItemState::Open)
}

pub fn item_contract(i: &ItemRow) -> PlanItem {
    PlanItem {
        item_id: PlanItemId::unchecked(format!("P{}", i.n)),
        project_ref: store::project_ref(&i.pkey),
        milestone_id: MilestoneId::unchecked(format!("M{}", i.milestone)),
        workstream_id: i.workstream_id.as_deref().map(WorkstreamId::unchecked),
        title: Line::unchecked(clip(&i.data.title, 120)),
        weight: i.weight,
        size: i.size,
        position: Count::unchecked(i.position.max(0)),
        links: i.data.links.clone(),
        after: UniqueList::try_from(
            i.data
                .after
                .iter()
                .map(|n| PlanItemId::unchecked(format!("P{n}")))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default(),
        state: i.state,
        started_at: i.started_ms.map(|t| Timestamp(iso_ms(t))),
        done_at: i.done_ms.map(|t| Timestamp(iso_ms(t))),
        evidence: i
            .data
            .evidence
            .as_deref()
            .map(|e| Line::unchecked(clip(e, 200))),
        drop_reason: i
            .data
            .drop_reason
            .as_deref()
            .map(|e| Line::unchecked(clip(e, 200))),
    }
}

pub fn change_contract(ch: &ChangeRow) -> PlanChange {
    PlanChange {
        kind: ch.kind,
        milestone_id: MilestoneId::unchecked(format!("M{}", ch.milestone)),
        workstream_id: ch.workstream_id.as_deref().map(WorkstreamId::unchecked),
        at: Timestamp(iso_ms(ch.at_ms)),
        by: Line::unchecked(clip(&ch.by, 120)),
        delta_items: AnyInt::unchecked(ch.delta_items),
        delta_size: AnyInt::unchecked(ch.delta_size),
        pct_before: ch.pct_before.map(Int::unchecked),
        pct_after: ch.pct_after.map(Int::unchecked),
        note: Line::unchecked(clip(&ch.note, 200)),
    }
}

/// A plan item a free slot could start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Runnable {
    pub item_id: String,
    pub title: String,
    pub workstream_id: String,
    pub size: fleetd_contracts::plan::Size,
}

/// The items a free slot could start, in plan order: open, in an order of `approved` (one running on a frozen brief:
/// work the human asked for), no task or PR linked yet, and none of its `after` items still open. Anything else
/// waits on something, or isn't fleetd's to offer.
pub fn runnable_items(
    milestones: &[MilestoneRow],
    items: &[ItemRow],
    approved: &HashSet<String>,
) -> Vec<Runnable> {
    let open: HashSet<i64> = items
        .iter()
        .filter(|i| i.state == PlanItemState::Open)
        .map(|i| i.n)
        .collect();
    let rank = |m: i64| {
        milestones
            .iter()
            .find(|row| row.n == m)
            .map_or((i64::MAX, m), |row| (row.position, m))
    };
    let mut ready: Vec<&ItemRow> = items
        .iter()
        .filter(|i| i.state == PlanItemState::Open && !i.has_work_links())
        .filter(|i| {
            i.workstream_id
                .as_ref()
                .is_some_and(|w| approved.contains(w))
        })
        .filter(|i| !i.data.after.iter().any(|a| open.contains(a)))
        .collect();
    ready.sort_by_key(|i| (rank(i.milestone), i.position, i.n));
    ready
        .into_iter()
        .map(|i| Runnable {
            item_id: format!("P{}", i.n),
            title: clip(&i.data.title, 80),
            workstream_id: i.workstream_id.clone().unwrap_or_default(),
            size: i.size,
        })
        .collect()
}

pub struct Plans {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
}

/// A marker to write and announce; built inside the write, emitted after it.
struct Pending {
    changes: Vec<ChangeRow>,
    verified: Vec<(ItemRow, String)>,
}

impl Plans {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self { db, events, clock })
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    fn tx<T>(&self, f: impl FnOnce(&Connection) -> Result<T, PlanError>) -> Result<T, PlanError> {
        let mut out = None;
        self.db
            .with(|c| {
                let tx = c.unchecked_transaction()?;
                let r = f(&tx);
                if r.is_ok() {
                    tx.commit()?;
                }
                out = Some(r);
                Ok(())
            })
            .map_err(|e: StoreError| failed(e))?;
        out.unwrap_or_else(|| Err(failed("no result")))
    }

    fn emit(&self, pending: Pending) {
        for ch in pending.changes {
            let (m, p) = ch.pkey.split_once('/').unwrap_or((&ch.pkey, ""));
            // A placeholder's marker belongs to no milestone (`milestone` 0), so it is not a `PlanChange`.
            let data = if ch.milestone == 0 {
                Some(serde_json::json!({
                    "kind": ch.kind, "workstreamId": ch.workstream_id, "at": iso_ms(ch.at_ms), "by": ch.by,
                    "deltaItems": ch.delta_items, "deltaSize": ch.delta_size, "note": ch.note,
                }))
            } else {
                serde_json::to_value(change_contract(&ch)).ok()
            };
            let mut summary = if ch.milestone == 0 {
                ch.note.clone()
            } else {
                format!("M{}: {}", ch.milestone, ch.note)
            };
            if let (Some(b), Some(a)) = (ch.pct_before, ch.pct_after) {
                summary = format!("{summary} ({b}% → {a}%)");
            }
            self.append(HubEventType::PlanChanged, m, p, summary, data);
        }
        for (item, evidence) in pending.verified {
            let (m, p) = item.pkey.split_once('/').unwrap_or((&item.pkey, ""));
            let data = serde_json::json!({
                "itemId": format!("P{}", item.n),
                "milestoneId": format!("M{}", item.milestone),
                "workstreamId": item.workstream_id,
                "evidence": evidence,
            });
            let summary = format!("P{} {} verified: {evidence}", item.n, item.data.title);
            self.append(HubEventType::PlanVerified, m, p, summary, Some(data));
        }
    }

    fn append(
        &self,
        t: HubEventType,
        m: &str,
        p: &str,
        summary: String,
        data: Option<serde_json::Value>,
    ) {
        let event = NewEvent {
            at: Timestamp(iso_ms(self.now())),
            r#type: t,
            machine_id: Some(fleetd_contracts::ids::MachineId::unchecked(m)),
            project_id: Some(fleetd_contracts::ids::ProjectId::unchecked(p)),
            thread_id: None,
            summary,
            data,
            attention: None,
        };
        if let Err(error) = self.events.append(event) {
            tracing::error!(%error, "plan event");
        }
    }

    fn own_order(c: &Connection, pk: &str, ws: &WorkstreamId) -> Result<OrderInfo, PlanError> {
        let Some(order) = order_info(c, ws.as_str())? else {
            return Err(not_found(
                format!("There is no workstream {ws}."),
                "Use a workstream id from the digest at the top of your last wake.",
            ));
        };
        if order.pkey != pk {
            return Err(forbidden(
                format!("{ws} belongs to another project."),
                "Use a workstream id from your own digest.",
            ));
        }
        Ok(order)
    }

    fn own_item(c: &Connection, pk: &str, id: &PlanItemId) -> Result<ItemRow, PlanError> {
        match store::item_get(c, number(id.as_str()))? {
            Some(i) if i.pkey == pk => Ok(i),
            _ => Err(not_found(
                format!("There is no plan item {id} in your project."),
                "Call `plan_show` for your items.",
            )),
        }
    }

    fn own_milestone(
        c: &Connection,
        pk: &str,
        id: &MilestoneId,
    ) -> Result<MilestoneRow, PlanError> {
        match store::milestone_get(c, number(id.as_str()))? {
            Some(m) if m.pkey == pk => Ok(m),
            _ => Err(not_found(
                format!("There is no milestone {id} in your project."),
                "Call `plan_show`, or add one with `plan_milestone`.",
            )),
        }
    }

    fn own_after(
        c: &Connection,
        pk: &str,
        after: &[PlanItemId],
        me: Option<i64>,
    ) -> Result<Vec<i64>, PlanError> {
        let mut out = Vec::new();
        for id in after {
            let item = Self::own_item(c, pk, id)?;
            if Some(item.n) == me {
                return Err(invalid(
                    format!("{id} can't come after itself."),
                    "Drop it from --after.",
                ));
            }
            out.push(item.n);
        }
        Ok(out)
    }

    pub fn milestone(
        &self,
        r: &ProjectRef,
        call: PlanMilestoneCall,
    ) -> Result<Milestone, PlanError> {
        let now = self.now();
        let pk = pkey(r);
        self.tx(|c| {
            let n = store::milestone_insert(
                c,
                &pk,
                call.title.as_str(),
                call.position.map(|p| p.get()),
                now,
            )?;
            let m = store::milestone_get(c, n)?.ok_or_else(|| failed("milestone vanished"))?;
            Ok(milestone_contract(&m, &[]))
        })
    }

    /// Records a change to `milestone`'s totals from `before` to its current items. Inside the planning window it
    /// writes nothing; after it, it needs `why` and writes a marker with the milestone's figure before and after.
    #[allow(clippy::too_many_arguments)]
    fn scope_change(
        c: &Connection,
        milestone: i64,
        before: Figure,
        why: Option<&str>,
        by: &str,
        ws: Option<&str>,
        now: i64,
        what: &str,
        pending: &mut Pending,
    ) -> Result<Option<ChangeRow>, PlanError> {
        let Some(mut m) = store::milestone_get(c, milestone)? else {
            return Ok(None);
        };
        let items = store::items_of_milestone(c, milestone)?;
        let after = figure_of(&items);
        if m.first_item_ms.is_none() && !items.is_empty() {
            m.first_item_ms = Some(now);
            store::milestone_set(c, &m)?;
        }
        let moved = (
            after.must_total_pts,
            after.polish_total_pts,
            after.must_total + after.polish_total,
        ) != (
            before.must_total_pts,
            before.polish_total_pts,
            before.must_total + before.polish_total,
        );
        if !moved {
            return Ok(None);
        }
        let was_done = m.done_ms.is_some();
        if was_done && !milestone_done(&items) {
            m.done_ms = None;
            store::milestone_set(c, &m)?;
            let row = ChangeRow {
                n: 0,
                pkey: m.pkey.clone(),
                milestone,
                workstream_id: ws.map(str::to_owned),
                at_ms: now,
                by: by.to_owned(),
                kind: PlanChangeKind::MilestoneReopened,
                delta_items: 0,
                delta_size: 0,
                pct_before: Some(100),
                pct_after: Some(after.pct()),
                note: format!("M{milestone} {} reopened: {what}", m.title),
            };
            store::change_insert(c, &row)?;
            pending.changes.push(row);
        }
        if !was_done && progress::in_planning_window(m.first_item_ms, now) {
            return Ok(None);
        }
        let Some(why) = why else {
            return Err(invalid(
                format!(
                    "That changes M{milestone}'s scope after its planning window ({}), so it needs a reason.",
                    progress::delta_text(
                        after.must_total + after.polish_total
                            - before.must_total
                            - before.polish_total,
                        after.must_total_pts + after.polish_total_pts
                            - before.must_total_pts
                            - before.polish_total_pts
                    )
                ),
                "Add why; it shows next to the figure as a marker.",
            ));
        };
        let delta_items =
            after.must_total + after.polish_total - before.must_total - before.polish_total;
        let delta_size = after.must_total_pts + after.polish_total_pts
            - before.must_total_pts
            - before.polish_total_pts;
        let row = ChangeRow {
            n: 0,
            pkey: m.pkey.clone(),
            milestone,
            workstream_id: ws.map(str::to_owned),
            at_ms: now,
            by: by.to_owned(),
            kind: PlanChangeKind::Scope,
            delta_items,
            delta_size,
            pct_before: Some(before.pct()),
            pct_after: Some(after.pct()),
            note: format!("{}: {why}", progress::delta_text(delta_items, delta_size)),
        };
        let n = store::change_insert(c, &row)?;
        let row = ChangeRow { n, ..row };
        pending.changes.push(row.clone());
        Ok(Some(row))
    }

    pub fn add(
        &self,
        r: &ProjectRef,
        by: &str,
        call: PlanAddCall,
    ) -> Result<PlanItemResult, PlanError> {
        let now = self.now();
        let pk = pkey(r);
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let result = self.tx(|c| {
            let m = Self::own_milestone(c, &pk, &call.milestone_id)?;
            if let Some(ws) = &call.workstream_id {
                Self::own_order(c, &pk, ws)?;
            }
            let after = Self::own_after(c, &pk, &call.after, None)?;
            let before = figure_of(&store::items_of_milestone(c, m.n)?);
            let mut links = fleetd_contracts::plan::PlanLinks::default();
            if let Some(pr) = &call.pr {
                links.prs = UniqueList::try_from(vec![pr.clone()]).unwrap_or_default();
            }
            if let Some(check) = call.check {
                links.checks = UniqueList::try_from(vec![check]).unwrap_or_default();
            }
            let mut item = ItemRow {
                n: 0,
                pkey: pk.clone(),
                milestone: m.n,
                workstream_id: call.workstream_id.as_ref().map(|w| w.to_string()),
                state: PlanItemState::Open,
                weight: call.weight,
                size: call.size.unwrap_or_default(),
                position: store::next_item_position(c, m.n)?,
                started_ms: None,
                done_ms: None,
                data: ItemData {
                    title: call.title.to_string(),
                    links,
                    after,
                    evidence: None,
                    drop_reason: None,
                    created_ms: Some(now),
                },
            };
            item.n = store::item_insert(c, &item)?;
            if let Some(ws) = &item.workstream_id {
                Self::placeholder_planned(c, ws, now, &mut pending)?;
            }
            let what = format!("P{} {} added", item.n, item.data.title);
            let change = Self::scope_change(
                c,
                m.n,
                before,
                call.why.as_deref(),
                by,
                item.workstream_id.as_deref(),
                now,
                &what,
                &mut pending,
            )?;
            Ok(PlanItemResult {
                item: item_contract(&item),
                change: change.as_ref().map(change_contract),
                next: Some(format!(
                    "link work with item P{} on `spawn_agent`; fleetd marks it done when its PR merges through the train and its checks pass.",
                    item.n
                )),
                warning: None,
            })
        })?;
        self.emit(pending);
        Ok(result)
    }

    pub fn edit(
        &self,
        r: &ProjectRef,
        by: &str,
        call: PlanEditCall,
    ) -> Result<PlanItemResult, PlanError> {
        let now = self.now();
        let pk = pkey(r);
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let result = self.tx(|c| {
            let mut item = Self::own_item(c, &pk, &call.item_id)?;
            if item.state == PlanItemState::Dropped {
                return Err(invalid(
                    format!("{} is dropped.", call.item_id),
                    "Add a new item instead.",
                ));
            }
            let old_milestone = item.milestone;
            let before_old = figure_of(&store::items_of_milestone(c, old_milestone)?);
            if let Some(t) = &call.title {
                item.data.title = t.to_string();
            }
            if let Some(s) = call.size {
                item.size = s;
            }
            if let Some(w) = call.weight {
                item.weight = w;
            }
            if let Some(ws) = &call.workstream_id {
                Self::own_order(c, &pk, ws)?;
                item.workstream_id = Some(ws.to_string());
            }
            if let Some(after) = &call.after {
                item.data.after = Self::own_after(c, &pk, after, Some(item.n))?;
            }
            let links = &mut item.data.links;
            let mut prs: Vec<GitHubPrUrl> = links
                .prs
                .iter()
                .filter(|p| !call.pr_remove.contains(p))
                .cloned()
                .collect();
            prs.extend(
                call.pr_add
                    .iter()
                    .filter(|p| !links.prs.contains(p))
                    .cloned(),
            );
            let mut checks: Vec<_> = links
                .checks
                .iter()
                .filter(|p| !call.check_remove.contains(p))
                .copied()
                .collect();
            checks.extend(
                call.check_add
                    .iter()
                    .filter(|p| !links.checks.contains(p))
                    .copied(),
            );
            links.prs = UniqueList::try_from(prs)
                .map_err(|e| invalid(format!("Too many PRs: {e}"), "Keep at most 20."))?;
            links.checks = UniqueList::try_from(checks)
                .map_err(|e| invalid(format!("Too many checks: {e}"), "Keep at most 20."))?;
            if let Some(p) = call.position {
                item.position = p.get();
            }
            let mut before_new = None;
            if let Some(mid) = &call.milestone_id {
                let m = Self::own_milestone(c, &pk, mid)?;
                if m.n != old_milestone {
                    before_new = Some(figure_of(&store::items_of_milestone(c, m.n)?));
                    item.milestone = m.n;
                    if call.position.is_none() {
                        item.position = store::next_item_position(c, m.n)?;
                    }
                }
            }
            store::item_set(c, &item)?;
            if let Some(ws) = &item.workstream_id {
                Self::placeholder_planned(c, ws, now, &mut pending)?;
            }
            let what = format!("P{} {} changed", item.n, item.data.title);
            let ws = item.workstream_id.clone();
            let mut change = Self::scope_change(
                c,
                old_milestone,
                before_old,
                call.why.as_deref(),
                by,
                ws.as_deref(),
                now,
                &what,
                &mut pending,
            )?;
            if let Some(before) = before_new {
                let moved = Self::scope_change(
                    c,
                    item.milestone,
                    before,
                    call.why.as_deref(),
                    by,
                    ws.as_deref(),
                    now,
                    &what,
                    &mut pending,
                )?;
                change = change.or(moved);
            }
            Ok(PlanItemResult {
                item: item_contract(&item),
                change: change.as_ref().map(change_contract),
                next: None,
                warning: None,
            })
        })?;
        self.emit(pending);
        Ok(result)
    }

    pub fn drop_item(
        &self,
        r: &ProjectRef,
        by: &str,
        call: PlanDropCall,
    ) -> Result<PlanItemResult, PlanError> {
        let now = self.now();
        let pk = pkey(r);
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let result = self.tx(|c| {
            let mut item = Self::own_item(c, &pk, &call.item_id)?;
            if item.state != PlanItemState::Open {
                return Err(invalid(
                    format!(
                        "{} is already {}.",
                        call.item_id,
                        if item.state == PlanItemState::Done {
                            "done"
                        } else {
                            "dropped"
                        }
                    ),
                    "Only open items can be dropped.",
                ));
            }
            let before = figure_of(&store::items_of_milestone(c, item.milestone)?);
            item.state = PlanItemState::Dropped;
            let why = call.why.as_ref().map_or("", |w| w.as_str());
            item.data.drop_reason = Some(why.to_owned());
            store::item_set(c, &item)?;
            let what = format!("P{} dropped", item.n);
            let change = Self::scope_change(
                c,
                item.milestone,
                before,
                Some(why),
                by,
                item.workstream_id.as_deref(),
                now,
                &what,
                &mut pending,
            )?;
            Self::settle_milestone(c, item.milestone, now, &mut pending)?;
            Ok(PlanItemResult {
                item: item_contract(&item),
                change: change.as_ref().map(change_contract),
                next: None,
                warning: None,
            })
        })?;
        self.emit(pending);
        Ok(result)
    }

    /// A finished milestone leaves its project's figure with a marker.
    fn settle_milestone(
        c: &Connection,
        milestone: i64,
        now: i64,
        pending: &mut Pending,
    ) -> Result<(), PlanError> {
        let Some(mut m) = store::milestone_get(c, milestone)? else {
            return Ok(());
        };
        let items = store::items_of_milestone(c, milestone)?;
        let done = milestone_done(&items);
        if done == m.done_ms.is_some() {
            return Ok(());
        }
        m.done_ms = done.then_some(now);
        store::milestone_set(c, &m)?;
        let n_done = items
            .iter()
            .filter(|i| i.state == PlanItemState::Done)
            .count() as i64;
        let row = ChangeRow {
            n: 0,
            pkey: m.pkey.clone(),
            milestone,
            workstream_id: None,
            at_ms: now,
            by: "hub".into(),
            kind: if done {
                PlanChangeKind::MilestoneDone
            } else {
                PlanChangeKind::MilestoneReopened
            },
            delta_items: if done { -n_done } else { n_done },
            delta_size: 0,
            pct_before: None,
            pct_after: None,
            note: milestone_note(milestone, &m.title, n_done, done),
        };
        store::change_insert(c, &row)?;
        pending.changes.push(row);
        Ok(())
    }

    /// [`runnable_items`] of the project.
    pub fn runnable(
        &self,
        r: &ProjectRef,
        approved: &HashSet<String>,
    ) -> Result<Vec<Runnable>, StoreError> {
        let pk = pkey(r);
        self.db.with(|c| {
            Ok(runnable_items(
                &store::milestones_of(c, &pk)?,
                &store::items_of_project(c, &pk)?,
                approved,
            ))
        })
    }

    /// Links a task spawned with `--item` (refused when the item belongs to another order); an item with no order
    /// takes the task's. Called inside the task's spawn, before the row is written.
    pub fn check_spawn_item(
        c: &Connection,
        r: &ProjectRef,
        item: &PlanItemId,
        ws: &WorkstreamId,
    ) -> Result<(), PlanError> {
        let row = Self::own_item(c, &pkey(r), item)?;
        if row.state != PlanItemState::Open {
            return Err(invalid(
                format!("{item} is not open."),
                "Link work to an open item.",
            ));
        }
        if let Some(own) = &row.workstream_id
            && own != ws.as_str()
        {
            return Err(forbidden(
                format!("{item} belongs to {own}, not {ws}."),
                format!(
                    "Spawn it under {own}, or move the item with `plan_edit` (itemId {item}, workstreamId {ws})."
                ),
            ));
        }
        Ok(())
    }

    pub fn link_task(
        c: &Connection,
        item: &PlanItemId,
        ws: &WorkstreamId,
        task: &TaskId,
    ) -> rusqlite::Result<()> {
        let Some(mut row) = store::item_get(c, number(item.as_str()))? else {
            return Ok(());
        };
        let mut tasks: Vec<TaskId> = row.data.links.tasks.iter().cloned().collect();
        if !tasks.contains(task) {
            tasks.push(task.clone());
            if tasks.len() > 50 {
                tasks.drain(..tasks.len() - 50);
            }
        }
        row.data.links.tasks = UniqueList::try_from(tasks).unwrap_or_default();
        row.workstream_id.get_or_insert_with(|| ws.to_string());
        store::item_set(c, &row)
    }

    /// An open item of the caller's project, before work is linked to it.
    pub fn check_item(&self, r: &ProjectRef, item: &PlanItemId) -> Result<(), PlanError> {
        let pk = pkey(r);
        self.tx(|c| {
            let row = Self::own_item(c, &pk, item)?;
            if row.state != PlanItemState::Open {
                return Err(invalid(
                    format!("{item} is not open."),
                    "Link work to an open item.",
                ));
            }
            Ok(())
        })
    }

    /// `change enqueue --item`: the PR becomes a link of the item.
    pub fn link_pr(
        &self,
        r: &ProjectRef,
        item: &PlanItemId,
        ws: &WorkstreamId,
        pr: &GitHubPrUrl,
    ) -> Result<(), PlanError> {
        let pk = pkey(r);
        self.tx(|c| {
            let mut row = Self::own_item(c, &pk, item)?;
            if let Some(own) = &row.workstream_id
                && own != ws.as_str()
            {
                return Err(forbidden(
                    format!("{item} belongs to {own}, not {ws}."),
                    "Enqueue it under the item's order, or leave out item.",
                ));
            }
            let mut prs: Vec<GitHubPrUrl> = row.data.links.prs.iter().cloned().collect();
            if !prs.contains(pr) {
                prs.push(pr.clone());
            }
            row.data.links.prs = UniqueList::try_from(prs)
                .map_err(|e| invalid(format!("Too many PRs on {item}: {e}"), "Keep at most 20."))?;
            row.workstream_id.get_or_insert_with(|| ws.to_string());
            store::item_set(c, &row)?;
            Ok(())
        })
    }

    /// Re-runs the done rule for an order's items: marks verified items done, reopens done items whose check failed
    /// in a later claim, and stamps `started_ms` from linked tasks. Returns whether anything changed.
    pub fn verify(&self, ws: &str) -> bool {
        let now = self.now();
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let changed = self.tx(|c| {
            let mut items = store::items_of_workstream(c, ws)?;
            // Items that list PRs but no order are checked with any order of their project.
            if let Some(order) = order_info(c, ws)? {
                items.extend(
                    store::items_of_project(c, &order.pkey)?
                        .into_iter()
                        .filter(|i| {
                            i.workstream_id.is_none()
                                && i.has_work_links()
                                && i.state != PlanItemState::Dropped
                        }),
                );
            }
            if items.is_empty() {
                return Ok(false);
            }
            let order_latest = latest_checks(c, ws)?;
            // An item with no order is verified by its own PR links only: an order's done-when checks never mark it
            // done or reopen it, and the checks it lists can't be read until it has an order.
            let no_checks = HashMap::new();
            let mut changed = false;
            let mut touched = HashSet::new();
            for mut item in items {
                let mut dirty = false;
                if item.started_ms.is_none()
                    && let Some(t) = first_task_start(c, &item)?
                {
                    item.started_ms = Some(t);
                    dirty = true;
                }
                let own_order = item.workstream_id.as_deref() == Some(ws);
                let latest = if own_order { &order_latest } else { &no_checks };
                let unreadable = !own_order && !item.data.links.checks.is_empty();
                let checks: Vec<i64> = item.data.links.checks.iter().map(|i| i.get()).collect();
                match if unreadable {
                    PlanItemState::Dropped
                } else {
                    item.state
                } {
                    PlanItemState::Open => {
                        let linked = linked_changes(c, &item)?;
                        if let Some(evidence) =
                            progress::verified(item.has_work_links(), &linked, &checks, latest)
                        {
                            item.state = PlanItemState::Done;
                            item.done_ms = Some(now);
                            item.data.evidence = Some(evidence.clone());
                            pending.verified.push((item.clone(), evidence));
                            touched.insert(item.milestone);
                            dirty = true;
                        }
                    }
                    PlanItemState::Done => {
                        if let Some(i) = progress::reopened(&checks, latest) {
                            let before = figure_of(&store::items_of_milestone(c, item.milestone)?);
                            item.state = PlanItemState::Open;
                            item.done_ms = None;
                            item.data.evidence = None;
                            store::item_set(c, &item)?;
                            let after = figure_of(&store::items_of_milestone(c, item.milestone)?);
                            let row = ChangeRow {
                                n: 0,
                                pkey: item.pkey.clone(),
                                milestone: item.milestone,
                                workstream_id: Some(ws.to_owned()),
                                at_ms: now,
                                by: "hub".into(),
                                kind: PlanChangeKind::Reopened,
                                delta_items: 0,
                                delta_size: 0,
                                pct_before: Some(before.pct()),
                                pct_after: Some(after.pct()),
                                note: format!(
                                    "P{} reopened: check {i} failed in a later claim",
                                    item.n
                                ),
                            };
                            store::change_insert(c, &row)?;
                            pending.changes.push(row);
                            touched.insert(item.milestone);
                            changed = true;
                            continue;
                        }
                    }
                    PlanItemState::Dropped => {}
                }
                if dirty {
                    store::item_set(c, &item)?;
                    changed = true;
                }
            }
            for m in touched {
                Self::settle_milestone(c, m, now, &mut pending)?;
            }
            Ok(changed)
        });
        self.emit(pending);
        changed.unwrap_or_else(|e| {
            tracing::error!(error = %e, ws, "plan verify");
            false
        })
    }

    /// An order ended: at done, its open items with no links are dropped (they closed with it, not separately
    /// verified); stopped or failed, every open item is dropped. Each writes one marker per milestone.
    pub fn close_order(&self, ws: &str, state: WorkstreamState) -> bool {
        let now = self.now();
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let changed = self.tx(|c| {
            let items = store::items_of_workstream(c, ws)?;
            let mut by_milestone: HashMap<i64, (Figure, i64, i64)> = HashMap::new();
            for mut item in items.into_iter().filter(|i| i.state == PlanItemState::Open) {
                let drop = match state {
                    WorkstreamState::Done => !item.has_links(),
                    WorkstreamState::Stopped | WorkstreamState::Failed => true,
                    _ => false,
                };
                if !drop {
                    continue;
                }
                let entry = by_milestone
                    .entry(item.milestone)
                    .or_insert_with(|| (Figure::default(), 0, 0));
                if entry.1 == 0 {
                    entry.0 = figure_of(&store::items_of_milestone(c, item.milestone)?);
                }
                entry.1 += 1;
                entry.2 += item.size.points();
                item.state = PlanItemState::Dropped;
                item.data.drop_reason = Some(match state {
                    WorkstreamState::Done => format!("closed with {ws}, not separately verified"),
                    _ => format!(
                        "{ws} {}",
                        if state == WorkstreamState::Stopped {
                            "stopped"
                        } else {
                            "failed"
                        }
                    ),
                });
                store::item_set(c, &item)?;
            }
            let changed = !by_milestone.is_empty();
            for (m, (before, n, pts)) in by_milestone {
                let after = figure_of(&store::items_of_milestone(c, m)?);
                let note = match state {
                    WorkstreamState::Done => format!(
                        "−{n} item{}: closed with {ws}, not separately verified",
                        if n == 1 { "" } else { "s" }
                    ),
                    WorkstreamState::Stopped => format!("−{n}: {ws} stopped"),
                    _ => format!("−{n}: {ws} failed"),
                };
                let row = ChangeRow {
                    n: 0,
                    pkey: store::milestone_get(c, m)?
                        .map(|r| r.pkey)
                        .unwrap_or_default(),
                    milestone: m,
                    workstream_id: Some(ws.to_owned()),
                    at_ms: now,
                    by: "hub".into(),
                    kind: PlanChangeKind::Closed,
                    delta_items: -n,
                    delta_size: -pts,
                    pct_before: Some(before.pct()),
                    pct_after: Some(after.pct()),
                    note,
                };
                store::change_insert(c, &row)?;
                pending.changes.push(row);
                Self::settle_milestone(c, m, now, &mut pending)?;
            }
            Ok(changed)
        });
        self.emit(pending);
        changed.unwrap_or(false)
    }

    /// The plan with derived state and figures; one order's items when `ws` is given.
    pub fn view(&self, r: &ProjectRef, ws: Option<&WorkstreamId>) -> Result<PlanView, PlanError> {
        let pk = pkey(r);
        let now = self.now();
        self.db
            .with(|c| {
                let milestones = store::milestones_of(c, &pk)?;
                let all = store::items_of_project(c, &pk)?;
                let mut changes = store::changes_of(c, &pk, 60)?;
                changes.retain(|ch| ch.milestone != 0);
                Ok((milestones, all, changes))
            })
            .map_err(failed)
            .map(|(milestones, all, changes)| {
                let items: Vec<&ItemRow> = all
                    .iter()
                    .filter(|i| ws.is_none_or(|w| i.workstream_id.as_deref() == Some(w.as_str())))
                    .collect();
                let mut total = Figure::default();
                let mut views = Vec::new();
                for m in &milestones {
                    let mine: Vec<ItemRow> = items
                        .iter()
                        .filter(|i| i.milestone == m.n)
                        .map(|i| (*i).clone())
                        .collect();
                    if ws.is_some() && mine.is_empty() {
                        continue;
                    }
                    let f = figure_of(&mine);
                    if m.done_ms.is_none() {
                        total.merge(&f);
                    }
                    let marker = changes.iter().find(|ch| ch.milestone == m.n).map(marker_of);
                    views.push(MilestoneView {
                        milestone: milestone_contract(m, &mine),
                        progress: progress_of(&f, now, marker),
                        eta: None,
                    });
                }
                let markers: Vec<PlanChange> = changes
                    .iter()
                    .filter(|ch| ws.is_none_or(|w| ch.workstream_id.as_deref() == Some(w.as_str())))
                    .map(change_contract)
                    .collect();
                PlanView {
                    project_ref: r.clone(),
                    workstream_id: ws.cloned(),
                    progress: progress_of(&total, now, changes.first().map(marker_of)),
                    eta: None,
                    milestones: List::try_from(views.into_iter().take(50).collect::<Vec<_>>())
                        .unwrap_or_default(),
                    items: List::try_from(
                        items
                            .iter()
                            .take(500)
                            .map(|i| item_contract(i))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap_or_default(),
                    markers: List::try_from(markers.into_iter().take(50).collect::<Vec<_>>())
                        .unwrap_or_default(),
                }
            })
    }
}

/// Hours a done order's placeholder stays in the figure before it leaves with a marker.
pub const PLACEHOLDER_DONE_MS: i64 = 24 * 3_600_000;

impl Plans {
    #[allow(clippy::too_many_arguments)]
    fn placeholder_marker(
        c: &Connection,
        ws: &str,
        pkey: &str,
        kind: PlanChangeKind,
        delta: i64,
        size: i64,
        note: String,
        now: i64,
        pending: &mut Pending,
    ) -> rusqlite::Result<()> {
        let row = ChangeRow {
            n: 0,
            pkey: pkey.to_owned(),
            milestone: 0,
            workstream_id: Some(ws.to_owned()),
            at_ms: now,
            by: "hub".into(),
            kind,
            delta_items: delta,
            delta_size: delta * size,
            pct_before: None,
            pct_after: None,
            note,
        };
        store::change_insert(c, &row)?;
        pending.changes.push(row);
        Ok(())
    }

    /// An order started running with no plan items: it enters its project's figure as one item of its tier.
    /// `quiet` (the backfill at start) writes no marker, since no figure was shown before it.
    pub fn placeholder_enter(&self, ws: &str, quiet: bool) -> bool {
        let now = self.now();
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let entered = self.tx(|c| {
            let Some(order) = order_info(c, ws)? else { return Ok(false) };
            let planned: bool =
                c.query_row("SELECT EXISTS (SELECT 1 FROM plan_items WHERE workstream_id = ?)", [ws], |r| r.get(0))?;
            if planned {
                return Ok(false);
            }
            let size = fleetd_contracts::plan::Size::from(order.tier.unwrap_or(fleetd_contracts::ledger::Tier::M)).points();
            let done = order.state == WorkstreamState::Done;
            let n = c.execute(
                "INSERT OR IGNORE INTO plan_placeholders (workstream_id, project_ref, size, title, state, entered_ms, done_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![ws, order.pkey, size, order.title, if done { "done" } else { "open" }, now, done.then_some(now)],
            )?;
            if n == 1 && !quiet {
                let note = format!("+1 item: {ws} {} (no plan yet)", clip(&order.title, 100));
                Self::placeholder_marker(c, ws, &order.pkey, PlanChangeKind::Scope, 1, size, note, now, &mut pending)?;
            }
            Ok(n == 1)
        });
        self.emit(pending);
        entered.unwrap_or(false)
    }

    /// The order behind a placeholder finished: done stays in the figure (verified); stopped or failed leaves it.
    pub fn placeholder_order_ended(&self, ws: &str, state: WorkstreamState) -> bool {
        let now = self.now();
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let changed = self.tx(|c| {
            let row: Option<(String, i64, String)> = c
                .query_row(
                    "SELECT project_ref, size, state FROM plan_placeholders WHERE workstream_id = ?",
                    [ws],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((pkey, size, current)) = row.filter(|r| r.2 == "open") else { return Ok(false) };
            let _ = current;
            if state == WorkstreamState::Done {
                c.execute("UPDATE plan_placeholders SET state = 'done', done_ms = ? WHERE workstream_id = ?", params![now, ws])?;
                return Ok(true);
            }
            c.execute("UPDATE plan_placeholders SET state = 'left', left_ms = ? WHERE workstream_id = ?", params![now, ws])?;
            let word = if state == WorkstreamState::Stopped { "stopped" } else { "failed" };
            Self::placeholder_marker(c, ws, &pkey, PlanChangeKind::Closed, -1, size, format!("−1: {ws} {word}"), now, &mut pending)?;
            Ok(true)
        });
        self.emit(pending);
        changed.unwrap_or(false)
    }

    /// An order got plan items: its placeholder gives way, with a marker. Inside the caller's write.
    fn placeholder_planned(
        c: &Connection,
        ws: &str,
        now: i64,
        pending: &mut Pending,
    ) -> rusqlite::Result<()> {
        let row: Option<(String, i64)> = c
            .query_row(
                "SELECT project_ref, size FROM plan_placeholders WHERE workstream_id = ? AND state != 'left'",
                [ws],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((pkey, size)) = row else {
            return Ok(());
        };
        c.execute(
            "UPDATE plan_placeholders SET state = 'left', left_ms = ? WHERE workstream_id = ?",
            params![now, ws],
        )?;
        let note = format!("−1 item: {ws}'s placeholder gives way to its plan");
        Self::placeholder_marker(
            c,
            ws,
            &pkey,
            PlanChangeKind::Scope,
            -1,
            size,
            note,
            now,
            pending,
        )
    }

    /// Done placeholders leave the figure a day after their order finished, each with a marker. Returns the next
    /// time one is due.
    pub fn placeholder_roll_off(&self) -> Option<i64> {
        let now = self.now();
        let mut pending = Pending {
            changes: vec![],
            verified: vec![],
        };
        let next = self.tx(|c| {
            let due: Vec<(String, String, i64)> = c
                .prepare_cached(
                    "SELECT workstream_id, project_ref, size FROM plan_placeholders WHERE state = 'done' AND done_ms <= ?",
                )?
                .query_map([now - PLACEHOLDER_DONE_MS], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (ws, pkey, size) in due {
                c.execute("UPDATE plan_placeholders SET state = 'left', left_ms = ? WHERE workstream_id = ?", params![now, ws])?;
                let note = format!("{ws} done a day ago, leaves the figure");
                Self::placeholder_marker(c, &ws, &pkey, PlanChangeKind::Closed, -1, size, note, now, &mut pending)?;
            }
            let next: Option<i64> = c.query_row(
                "SELECT MIN(done_ms) FROM plan_placeholders WHERE state = 'done'",
                [],
                |r| r.get(0),
            )?;
            Ok(next.map(|d| d + PLACEHOLDER_DONE_MS))
        });
        self.emit(pending);
        next.unwrap_or(None)
    }

    /// At start: every running order with no plan and no placeholder gets one, quietly.
    pub fn placeholder_backfill(&self) {
        let orders: Vec<String> = self
            .db
            .with(|c| {
                Ok(c.prepare(
                    "SELECT 'W' || n FROM workstreams WHERE state IN ('running', 'converging', 'verifying', 'idle')",
                )?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?)
            })
            .unwrap_or_default();
        for ws in orders {
            self.placeholder_enter(&ws, true);
        }
    }
}

/// The first `task.started` of the item's linked tasks, from their stored rows.
fn first_task_start(c: &Connection, item: &ItemRow) -> rusqlite::Result<Option<i64>> {
    let mut first: Option<i64> = None;
    for t in item.data.links.tasks.iter() {
        let data: Option<String> = c
            .prepare_cached("SELECT data FROM tasks WHERE n = ?")?
            .query_row([number(t.as_str())], |r| r.get(0))
            .optional()?;
        let started = data
            .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
            .and_then(|v| v.get("startedAt")?.as_str().and_then(parse_ms));
        if let Some(s) = started {
            first = Some(first.map_or(s, |f| f.min(s)));
        }
    }
    Ok(first)
}

/// Plain text for `plan show`: one milestone header, then one item per line.
pub fn plan_text(view: &PlanView) -> String {
    let mut out = String::new();
    let p = &view.progress;
    out.push_str(&format!(
        "plan: {}/{} items, {}%",
        p.done.get(),
        p.total.get(),
        p.pct.get()
    ));
    if let Some(pp) = &p.polish_pct {
        out.push_str(&format!(
            ", polish {}/{} ({}%)",
            p.polish_done.get(),
            p.polish_total.get(),
            pp.get()
        ));
    }
    out.push('\n');
    for m in view.milestones.iter() {
        out.push_str(&format!(
            "{} {} [{}] {}% ({}/{})\n",
            m.milestone.milestone_id,
            m.milestone.title,
            if m.milestone.state == MilestoneState::Done {
                "done"
            } else {
                "open"
            },
            m.progress.pct.get(),
            m.progress.done.get(),
            m.progress.total.get()
        ));
        for i in view
            .items
            .iter()
            .filter(|i| i.milestone_id == m.milestone.milestone_id)
        {
            let state = match i.state {
                PlanItemState::Open => "open",
                PlanItemState::Done => "done",
                PlanItemState::Dropped => "dropped",
            };
            let weight = if i.weight == Weight::Must {
                "must"
            } else {
                "polish"
            };
            let size = match i.size {
                fleetd_contracts::plan::Size::S => "s",
                fleetd_contracts::plan::Size::M => "m",
                fleetd_contracts::plan::Size::L => "l",
            };
            out.push_str(&format!(
                "  {} [{weight} {size}] {state:<7} {}",
                i.item_id, i.title
            ));
            if let Some(w) = &i.workstream_id {
                out.push_str(&format!(" ({w})"));
            }
            if !i.after.is_empty() {
                let after: Vec<&str> = i.after.iter().map(|a| a.as_str()).collect();
                out.push_str(&format!(" after {}", after.join(",")));
            }
            if let Some(e) = &i.evidence {
                out.push_str(&format!(" · {e}"));
            }
            if let Some(d) = &i.drop_reason {
                out.push_str(&format!(" · {d}"));
            }
            out.push('\n');
        }
    }
    for ch in view.markers.iter().take(5) {
        out.push_str(&format!(
            "marker {} {}: {}\n",
            ch.at, ch.milestone_id, ch.note
        ));
    }
    out
}

/// A milestone's marker: "M4 FAQ page done (1 item)", or reopened.
fn milestone_note(milestone: i64, title: &str, n_done: i64, done: bool) -> String {
    if done {
        let items = if n_done == 1 { "item" } else { "items" };
        format!("M{milestone} {title} done ({n_done} {items})")
    } else {
        format!("M{milestone} {title} reopened")
    }
}

#[cfg(test)]
mod note_tests {
    #[test]
    fn a_milestone_of_one_item_says_item() {
        assert_eq!(
            super::milestone_note(4, "FAQ page", 1, true),
            "M4 FAQ page done (1 item)"
        );
        assert_eq!(
            super::milestone_note(4, "FAQ page", 3, true),
            "M4 FAQ page done (3 items)"
        );
        assert_eq!(
            super::milestone_note(4, "FAQ page", 1, false),
            "M4 FAQ page reopened"
        );
    }
}
