//! Plan rows: `plan_milestones`, `plan_items` and `plan_changes`. A project is keyed `<machineId>/<projectId>`.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::plan::{PlanChangeKind, PlanItemState, PlanLinks, Size, Weight};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

pub fn pkey(r: &ProjectRef) -> String {
    format!("{}/{}", r.machine_id, r.project_id)
}

pub fn project_ref(key: &str) -> ProjectRef {
    let (m, p) = key.split_once('/').unwrap_or((key, ""));
    ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneRow {
    pub n: i64,
    pub pkey: String,
    pub title: String,
    pub position: i64,
    pub created_ms: i64,
    pub first_item_ms: Option<i64>,
    pub done_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemData {
    pub title: String,
    #[serde(default)]
    pub links: PlanLinks,
    #[serde(default)]
    pub after: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drop_reason: Option<String>,
    /// When it was added (absent on items older than the progress model).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemRow {
    pub n: i64,
    pub pkey: String,
    pub milestone: i64,
    pub workstream_id: Option<String>,
    pub state: PlanItemState,
    pub weight: Weight,
    pub size: Size,
    pub position: i64,
    pub started_ms: Option<i64>,
    pub done_ms: Option<i64>,
    pub data: ItemData,
}

impl ItemRow {
    pub fn has_work_links(&self) -> bool {
        !self.data.links.tasks.is_empty() || !self.data.links.prs.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChangeRow {
    pub n: i64,
    pub pkey: String,
    pub milestone: i64,
    pub workstream_id: Option<String>,
    pub at_ms: i64,
    pub by: String,
    pub kind: PlanChangeKind,
    pub delta_items: i64,
    pub delta_size: i64,
    pub pct_before: Option<i64>,
    pub pct_after: Option<i64>,
    pub note: String,
}

fn enum_str<T: Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn enum_of<T: for<'de> Deserialize<'de>>(s: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn size_of(points: i64) -> Size {
    match points {
        1 => Size::S,
        8 => Size::L,
        _ => Size::M,
    }
}

const MILESTONE_COLS: &str = "n, project_ref, title, position, created_ms, first_item_ms, done_ms";

fn milestone_of(r: &Row) -> rusqlite::Result<MilestoneRow> {
    Ok(MilestoneRow {
        n: r.get(0)?,
        pkey: r.get(1)?,
        title: r.get(2)?,
        position: r.get(3)?,
        created_ms: r.get(4)?,
        first_item_ms: r.get(5)?,
        done_ms: r.get(6)?,
    })
}

const ITEM_COLS: &str = "n, project_ref, milestone, workstream_id, state, weight, size, position, started_ms, done_ms, data";

fn item_of(r: &Row) -> rusqlite::Result<ItemRow> {
    let data: String = r.get(10)?;
    Ok(ItemRow {
        n: r.get(0)?,
        pkey: r.get(1)?,
        milestone: r.get(2)?,
        workstream_id: r.get(3)?,
        state: enum_of(&r.get::<_, String>(4)?)?,
        weight: enum_of(&r.get::<_, String>(5)?)?,
        size: size_of(r.get(6)?),
        position: r.get(7)?,
        started_ms: r.get(8)?,
        done_ms: r.get(9)?,
        data: serde_json::from_str(&data).unwrap_or_default(),
    })
}

const CHANGE_COLS: &str = "n, project_ref, milestone, workstream_id, at_ms, by, kind, delta_items, delta_size, \
     pct_before, pct_after, note";

fn change_of(r: &Row) -> rusqlite::Result<ChangeRow> {
    Ok(ChangeRow {
        n: r.get(0)?,
        pkey: r.get(1)?,
        milestone: r.get(2)?,
        workstream_id: r.get(3)?,
        at_ms: r.get(4)?,
        by: r.get(5)?,
        kind: enum_of(&r.get::<_, String>(6)?)?,
        delta_items: r.get(7)?,
        delta_size: r.get(8)?,
        pct_before: r.get(9)?,
        pct_after: r.get(10)?,
        note: r.get(11)?,
    })
}

pub fn milestone_insert(
    c: &Connection,
    pkey: &str,
    title: &str,
    position: Option<i64>,
    now_ms: i64,
) -> rusqlite::Result<i64> {
    let position = match position {
        Some(p) => p,
        None => c.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM plan_milestones WHERE project_ref = ?",
            [pkey],
            |r| r.get(0),
        )?,
    };
    c.query_row(
        "INSERT INTO plan_milestones (project_ref, title, position, created_ms) VALUES (?, ?, ?, ?) RETURNING n",
        params![pkey, title, position, now_ms],
        |r| r.get(0),
    )
}

pub fn milestone_get(c: &Connection, n: i64) -> rusqlite::Result<Option<MilestoneRow>> {
    c.prepare_cached(&format!(
        "SELECT {MILESTONE_COLS} FROM plan_milestones WHERE n = ?"
    ))?
    .query_row([n], milestone_of)
    .optional()
}

pub fn milestones_of(c: &Connection, pkey: &str) -> rusqlite::Result<Vec<MilestoneRow>> {
    c.prepare_cached(&format!(
        "SELECT {MILESTONE_COLS} FROM plan_milestones WHERE project_ref = ? ORDER BY position, n"
    ))?
    .query_map([pkey], milestone_of)?
    .collect()
}

pub fn milestones_all(c: &Connection) -> rusqlite::Result<Vec<MilestoneRow>> {
    c.prepare_cached(&format!(
        "SELECT {MILESTONE_COLS} FROM plan_milestones ORDER BY project_ref, position, n"
    ))?
    .query_map([], milestone_of)?
    .collect()
}

pub fn milestone_set(c: &Connection, m: &MilestoneRow) -> rusqlite::Result<()> {
    c.prepare_cached(
        "UPDATE plan_milestones SET title = ?, position = ?, first_item_ms = ?, done_ms = ? WHERE n = ?",
    )?
    .execute(params![m.title, m.position, m.first_item_ms, m.done_ms, m.n])?;
    Ok(())
}

pub fn item_insert(c: &Connection, item: &ItemRow) -> rusqlite::Result<i64> {
    c.query_row(
        "INSERT INTO plan_items (project_ref, milestone, workstream_id, state, weight, size, position, started_ms,
           done_ms, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n",
        params![
            item.pkey,
            item.milestone,
            item.workstream_id,
            enum_str(item.state),
            enum_str(item.weight),
            item.size.points(),
            item.position,
            item.started_ms,
            item.done_ms,
            serde_json::to_string(&item.data).unwrap_or_default()
        ],
        |r| r.get(0),
    )
}

pub fn item_set(c: &Connection, item: &ItemRow) -> rusqlite::Result<()> {
    c.prepare_cached(
        "UPDATE plan_items SET milestone = ?, workstream_id = ?, state = ?, weight = ?, size = ?, position = ?,
           started_ms = ?, done_ms = ?, data = ? WHERE n = ?",
    )?
    .execute(params![
        item.milestone,
        item.workstream_id,
        enum_str(item.state),
        enum_str(item.weight),
        item.size.points(),
        item.position,
        item.started_ms,
        item.done_ms,
        serde_json::to_string(&item.data).unwrap_or_default(),
        item.n
    ])?;
    Ok(())
}

pub fn item_get(c: &Connection, n: i64) -> rusqlite::Result<Option<ItemRow>> {
    c.prepare_cached(&format!("SELECT {ITEM_COLS} FROM plan_items WHERE n = ?"))?
        .query_row([n], item_of)
        .optional()
}

pub fn items_of_project(c: &Connection, pkey: &str) -> rusqlite::Result<Vec<ItemRow>> {
    c.prepare_cached(&format!(
        "SELECT {ITEM_COLS} FROM plan_items WHERE project_ref = ? ORDER BY milestone, position, n"
    ))?
    .query_map([pkey], item_of)?
    .collect()
}

pub fn items_of_workstream(c: &Connection, ws: &str) -> rusqlite::Result<Vec<ItemRow>> {
    c.prepare_cached(&format!(
        "SELECT {ITEM_COLS} FROM plan_items WHERE workstream_id = ? ORDER BY milestone, position, n"
    ))?
    .query_map([ws], item_of)?
    .collect()
}

pub fn items_of_milestone(c: &Connection, milestone: i64) -> rusqlite::Result<Vec<ItemRow>> {
    c.prepare_cached(&format!(
        "SELECT {ITEM_COLS} FROM plan_items WHERE milestone = ? ORDER BY position, n"
    ))?
    .query_map([milestone], item_of)?
    .collect()
}

pub fn items_all(c: &Connection) -> rusqlite::Result<Vec<ItemRow>> {
    c.prepare_cached(&format!(
        "SELECT {ITEM_COLS} FROM plan_items ORDER BY project_ref, milestone, position, n"
    ))?
    .query_map([], item_of)?
    .collect()
}

/// Items a render needs: open ones, those in open milestones, and those done since `since_ms`.
pub fn items_live(c: &Connection, since_ms: i64) -> rusqlite::Result<Vec<ItemRow>> {
    c.prepare_cached(&format!(
        "SELECT {ITEM_COLS} FROM plan_items
         WHERE state = 'open' OR done_ms >= ?
            OR milestone IN (SELECT n FROM plan_milestones WHERE done_ms IS NULL)
         ORDER BY project_ref, milestone, position, n"
    ))?
    .query_map([since_ms], item_of)?
    .collect()
}

pub fn next_item_position(c: &Connection, milestone: i64) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM plan_items WHERE milestone = ?",
        [milestone],
        |r| r.get(0),
    )
}

pub fn change_insert(c: &Connection, ch: &ChangeRow) -> rusqlite::Result<i64> {
    c.query_row(
        "INSERT INTO plan_changes (project_ref, milestone, workstream_id, at_ms, by, kind, delta_items, delta_size,
           pct_before, pct_after, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n",
        params![
            ch.pkey,
            ch.milestone,
            ch.workstream_id,
            ch.at_ms,
            ch.by,
            enum_str(ch.kind),
            ch.delta_items,
            ch.delta_size,
            ch.pct_before,
            ch.pct_after,
            ch.note
        ],
        |r| r.get(0),
    )
}

/// Newest first.
pub fn changes_of(c: &Connection, pkey: &str, limit: i64) -> rusqlite::Result<Vec<ChangeRow>> {
    c.prepare_cached(&format!(
        "SELECT {CHANGE_COLS} FROM plan_changes WHERE project_ref = ? ORDER BY n DESC LIMIT ?"
    ))?
    .query_map(params![pkey, limit], change_of)?
    .collect()
}

/// Newest first, across every project.
pub fn changes_all(c: &Connection, limit: i64) -> rusqlite::Result<Vec<ChangeRow>> {
    c.prepare_cached(&format!(
        "SELECT {CHANGE_COLS} FROM plan_changes ORDER BY n DESC LIMIT ?"
    ))?
    .query_map([limit], change_of)?
    .collect()
}
