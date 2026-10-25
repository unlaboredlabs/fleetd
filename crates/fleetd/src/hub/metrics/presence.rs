//! App presence: once a minute, while presence is on, the desktop app says whether a window is focused, which project
//! is on screen and whether there was input in the last minute. Nothing else is sent: never keystrokes or content,
//! and it stays on the hub. A human key's minute with all three becomes one `app.presence` event over the minute
//! before it, on the hub's clock; the projector takes it as an `app.use` touch, and `human.rs` joins neighbouring
//! minutes and the person's other acts into sessions.
use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::auth::{KeyKind, Role};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::metrics::AppPresenceData;
use fleetd_contracts::prim::{Count, Line};

use crate::hub::api::{Caller, Hub};
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms};

/// What one frame covers: the minute before it.
pub const WINDOW_MS: i64 = 60_000;
/// A key's next interval must add at least this much, so a key records at most about one a minute however many
/// windows or reconnects send frames, and a frame a little early on the app's timer still counts.
pub const MIN_MS: i64 = 50_000;

/// Where each key's last interval ended.
#[derive(Default)]
pub struct Presence {
    last: Mutex<HashMap<String, i64>>,
}

impl Presence {
    /// The interval a frame at `now` records for `key`: the minute before it, from where the key's last one ended;
    /// `None` when that adds less than [`MIN_MS`].
    pub fn interval(&self, key: &str, now: i64) -> Option<(i64, i64)> {
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        let from = last
            .get(key)
            .map_or(now - WINDOW_MS, |&end| end.max(now - WINDOW_MS));
        if now - from < MIN_MS {
            return None;
        }
        last.insert(key.to_owned(), now);
        Some((from, now))
    }
}

/// The `app.presence` event for `[from, to]` on `project`, by the key named `by`.
pub fn event(project: &ProjectRef, by: &str, from: i64, to: i64) -> NewEvent {
    let data = AppPresenceData {
        from_ms: Count::unchecked(from),
        to_ms: Count::unchecked(to),
        by: Line::new(by).ok(),
    };
    NewEvent {
        at: iso_ms(to).into(),
        r#type: HubEventType::AppPresence,
        machine_id: Some(project.machine_id.clone()),
        project_id: Some(project.project_id.clone()),
        thread_id: None,
        summary: "app in use".into(),
        data: serde_json::to_value(data).ok(),
        attention: None,
    }
}

/// One `presence` frame from the app. Only a human key's focused minute with input, on a project the hub knows on
/// that machine and the key may read, is recorded; the frame is never answered.
pub fn record(
    hub: &Hub,
    caller: &Caller,
    focused: bool,
    input: bool,
    project: Option<&ProjectRef>,
) -> Result<bool, StoreError> {
    let Some(project) = project.filter(|_| focused && input) else {
        return Ok(false);
    };
    if caller.kind != Some(KeyKind::Human)
        || !crate::hub::api::allows(caller, Role::Read, Some(&project.machine_id))
    {
        return Ok(false);
    }
    if !known(hub, project)? {
        return Ok(false);
    }
    let now = now_ms(hub.clock.as_ref());
    let Some((from, to)) = hub.metrics.presence.interval(caller.key_id.as_str(), now) else {
        return Ok(false);
    };
    hub.events.append(event(project, &caller.name, from, to))?;
    Ok(true)
}

/// Whether the hub has `project` on its machine: a frame naming any other is dropped.
fn known(hub: &Hub, project: &ProjectRef) -> Result<bool, StoreError> {
    hub.db.with(|c| {
        Ok(
            c.prepare_cached("SELECT 1 FROM projects WHERE machine_id = ?1 AND project_id = ?2")?
                .exists([project.machine_id.as_str(), project.project_id.as_str()])?,
        )
    })
}
