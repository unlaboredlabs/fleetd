//! navi_create, navi_list, navi_rename, navi_archive, navi_sites, navi_site_revoke, navi_approvals, navi_approvals_set
//! and navi_signins_forget: thin over
//! the Navi service. And
//! navi_asks: the app's read of what a Navi asked other projects for (`project_message`), with each order opened for
//! it, its state and whether a PR of it merged. Read-only; the app calls it on a hub that names the `navi_asks` feature.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::mcp::{
    NaviApprovalsInput, NaviApprovalsOutput, NaviApprovalsSetInput, NaviApprovalsSetOutput,
    NaviArchiveInput, NaviArchiveOutput, NaviAsksInput, NaviAsksOutput, NaviCreateInput,
    NaviCreateOutput, NaviListInput, NaviListOutput, NaviRenameInput, NaviRenameOutput,
    NaviSigninsForgetInput, NaviSigninsForgetOutput, NaviSiteRevokeInput, NaviSiteRevokeOutput,
    NaviSitesInput, NaviSitesOutput,
};
use fleetd_contracts::navi::{NAVI_ASKS_MAX, NaviAsk, NaviAskOrder};
use fleetd_contracts::prim::List;

use super::bridge::{asks_from, project_title};
use crate::hub::api::{Caller, Hub, Registry, ToolError, readable, require, unknown_project};
use crate::hub::store::iso_ms;

pub fn register(tools: &mut Registry) {
    // Each under its project name (D310), and its old navi_* name for one release.
    tools.add("navi_create", create);
    tools.add("navi_list", list);
    tools.add("navi_rename", rename);
    for name in ["project_archive", "navi_archive"] {
        tools.add(name, archive);
    }
    for name in ["project_sites", "navi_sites"] {
        tools.add(name, sites);
    }
    for name in ["project_site_revoke", "navi_site_revoke"] {
        tools.add(name, revoke_site);
    }
    for name in ["project_approvals", "navi_approvals"] {
        tools.add(name, approvals);
    }
    for name in ["project_approvals_set", "navi_approvals_set"] {
        tools.add(name, set_approvals);
    }
    for name in ["project_signins_forget", "navi_signins_forget"] {
        tools.add(name, forget_signins);
    }
    for name in ["project_asks", "navi_asks"] {
        tools.add(name, navi_asks);
    }
    super::purchases::register(tools);
}

async fn navi_asks(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviAsksInput,
) -> Result<NaviAsksOutput, ToolError> {
    let r = input.project_ref().clone();
    require(&caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    // Any project's asks read (D310), an archived one's too.
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
                let merged = hub
                    .train
                    .records()
                    .any_merged(&w.project_ref, w.workstream_id.as_str());
                orders.push(NaviAskOrder {
                    workstream_id: w.workstream_id,
                    title: w.title.to_string(),
                    state: w.state,
                    headline: w.headline.map(|h| h.to_string()).filter(|h| !h.is_empty()),
                    merged: merged.then_some(true),
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
        Some("This project has asked no other project for anything yet.".to_owned())
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

async fn create(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviCreateInput,
) -> Result<NaviCreateOutput, ToolError> {
    super::create(&hub, &caller, input).await
}

async fn list(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviListInput,
) -> Result<NaviListOutput, ToolError> {
    super::list(&hub, &caller, input)
}

async fn rename(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviRenameInput,
) -> Result<NaviRenameOutput, ToolError> {
    super::rename(&hub, &caller, input).await
}

async fn archive(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviArchiveInput,
) -> Result<NaviArchiveOutput, ToolError> {
    super::archive(&hub, &caller, input).await
}

async fn sites(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviSitesInput,
) -> Result<NaviSitesOutput, ToolError> {
    super::sites(&hub, &caller, input)
}

async fn revoke_site(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviSiteRevokeInput,
) -> Result<NaviSiteRevokeOutput, ToolError> {
    super::revoke_site(&hub, &caller, input)
}

async fn approvals(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviApprovalsInput,
) -> Result<NaviApprovalsOutput, ToolError> {
    super::approvals(&hub, &caller, input)
}

async fn set_approvals(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviApprovalsSetInput,
) -> Result<NaviApprovalsSetOutput, ToolError> {
    super::set_approvals(&hub, &caller, input)
}

async fn forget_signins(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviSigninsForgetInput,
) -> Result<NaviSigninsForgetOutput, ToolError> {
    super::forget_signins(&hub, &caller, input).await
}
