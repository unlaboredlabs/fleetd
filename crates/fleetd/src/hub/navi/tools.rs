//! navi_asks: the app's read of what a Navi asked other projects for (`project_message`), with each order opened for it
//! and its state. Read-only; the app calls it on a hub that names the `navi_asks` feature.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::mcp::{ErrorCode, NaviAsksInput, NaviAsksOutput};
use fleetd_contracts::navi::{NAVI_ASKS_MAX, NaviAsk, NaviAskOrder};
use fleetd_contracts::prim::List;

use super::bridge::{asks_from, is_navi, project_title};
use crate::hub::api::{Caller, Hub, Registry, ToolError, readable, require, unknown_project};
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
    // An archived Navi's asks still read.
    if !is_navi(&hub.db, &r, true)? {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("{} on {} is not a Navi.", r.project_id, r.machine_id),
        )
        .with_fix("Only a Navi asks other projects for work; read a project's own orders with orders_board."));
    }
    let all = asks_from(&hub.db, &r)?;
    let truncated = (all.len() > NAVI_ASKS_MAX).then_some(true);
    let mut asks = Vec::new();
    for a in all.into_iter().take(NAVI_ASKS_MAX) {
        // An ask may go to a project on another machine: the caller reads its title and orders only with read there,
        // as order_get does; else the ask shows the Navi's own words and the project's id.
        let shown = readable(&caller, &a.to.machine_id);
        let mut orders = Vec::new();
        for id in a.orders.iter().filter(|_| shown) {
            if let Some(w) = hub
                .leads
                .records
                .workstream_get(id)?
                .filter(|w| readable(&caller, &w.project_ref.machine_id))
            {
                orders.push(NaviAskOrder {
                    workstream_id: w.workstream_id,
                    title: w.title.to_string(),
                    state: w.state,
                    headline: w.headline.map(|h| h.to_string()).filter(|h| !h.is_empty()),
                });
            }
        }
        asks.push(NaviAsk {
            to_title: match shown {
                true => project_title(&hub, &a.to),
                false => a.to.project_id.to_string(),
            },
            handle: a.handle,
            to: a.to,
            text: a.text,
            at: Timestamp(iso_ms(a.at_ms)),
            orders,
        });
    }
    let next = if asks.is_empty() {
        Some("This Navi has asked no other project for anything yet.".to_owned())
    } else {
        truncated.map(|_| {
            format!("These are its newest {NAVI_ASKS_MAX} asks; older ones aren't listed.")
        })
    };
    Ok(NaviAsksOutput {
        navi: r,
        asks: List::unchecked(asks),
        next,
        truncated,
    })
}
