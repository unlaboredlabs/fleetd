//! navi_asks: the app's read of what a Navi asked other projects for (`project_message`), with each order opened for it
//! and its state. Read-only; the app calls it on a hub that names the `navi_asks` feature.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::mcp::{NaviAsksInput, NaviAsksOutput};
use fleetd_contracts::navi::{NAVI_ASKS_MAX, NaviAsk, NaviAskOrder};
use fleetd_contracts::prim::List;

use super::bridge::{asks_from, project_title};
use crate::hub::api::{Caller, Hub, Registry, ToolError, require, unknown_project};
use crate::hub::store::iso_ms;

pub fn register(tools: &mut Registry) {
    tools.add("navi_asks", navi_asks);
}

async fn navi_asks(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviAsksInput,
) -> Result<NaviAsksOutput, ToolError> {
    let r = input.navi;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let all = asks_from(&hub.db, &r)?;
    let truncated = (all.len() > NAVI_ASKS_MAX).then_some(true);
    let mut asks = Vec::new();
    for a in all.into_iter().take(NAVI_ASKS_MAX) {
        let mut orders = Vec::new();
        for id in &a.orders {
            if let Some(w) = hub.leads.records.workstream_get(id)? {
                orders.push(NaviAskOrder {
                    workstream_id: w.workstream_id,
                    title: w.title.to_string(),
                    state: w.state,
                    headline: w.headline.map(|h| h.to_string()).filter(|h| !h.is_empty()),
                });
            }
        }
        asks.push(NaviAsk {
            to_title: project_title(&hub, &a.to),
            handle: a.handle,
            to: a.to,
            text: a.text,
            at: Timestamp(iso_ms(a.at_ms)),
            orders,
        });
    }
    let next = asks
        .is_empty()
        .then(|| "This Navi has asked no other project for anything yet.".to_owned());
    Ok(NaviAsksOutput {
        navi: r,
        asks: List::unchecked(asks),
        next,
        truncated,
    })
}
