//! pair_code_create: the app's Pair a phone. A person's device mints a `fleetd pair` code for one more device of
//! theirs, and the link to show as a QR, with the hub at an address a phone reaches.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::mcp::{ErrorCode, PairCodeCreateInput, PairCodeCreateOutput};

use super::PairCodes;
use crate::cli::pair::{deep_link, local_hub_urls, loopback_only_fix, phone_url};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, error, is_human};

pub fn register(tools: &mut Registry) {
    tools.add("pair_code_create", pair_code_create);
}

/// The most the caller's key may do on every machine: the paired device gets no more.
fn role_everywhere(caller: &Caller) -> Role {
    [Role::Admin, Role::Operate]
        .into_iter()
        .find(|&role| allows_everywhere(caller, role))
        .unwrap_or(Role::Read)
}

/// Where a phone reaches the hub: the address the app reaches it at, else the hub's own (its `--url`, the one setup
/// saved, its tailnet and LAN addresses), never a loopback one. None when it has only those.
pub fn phone_hub_url(hub: &Hub, app_url: Option<&str>) -> Option<String> {
    let own = local_hub_urls(&hub.config.home).unwrap_or_default();
    let candidates = app_url
        .into_iter()
        .chain(hub.config.url.as_deref())
        .chain(own.iter().map(String::as_str));
    let url = phone_url(candidates)?.trim_end_matches('/');
    // The phone opens the link's hub as a URL: an address saved without its scheme gets http's.
    Some(if url.contains("://") {
        url.to_owned()
    } else {
        format!("http://{url}")
    })
}

async fn pair_code_create(
    hub: Arc<Hub>,
    caller: Caller,
    input: PairCodeCreateInput,
) -> Result<PairCodeCreateOutput, ToolError> {
    let person = caller
        .person
        .as_ref()
        .filter(|_| is_human(&caller))
        .ok_or_else(|| {
            error(
                ErrorCode::Forbidden,
                "Only a person's own device pairs a phone.",
                "Open Pair a phone in the fleetd app, or run `fleetd pair` on the hub.",
            )
        })?;
    let app_url = input.hub_url.as_ref().map(|url| url.as_str());
    let hub_url = phone_hub_url(&hub, app_url).ok_or_else(|| {
        error(
            ErrorCode::Failed,
            format!(
                "The hub is only at {}, which a phone can't reach.",
                app_url.map_or_else(|| hub.config.url(), str::to_owned)
            ),
            loopback_only_fix(),
        )
    })?;
    let minted = PairCodes::new(hub.db.clone(), hub.clock.clone())
        .create_for(&person.person_id, role_everywhere(&caller))?;
    Ok(PairCodeCreateOutput {
        link: deep_link(&hub_url, &minted.code),
        code: minted.code,
        hub_url,
        expires_at: Timestamp(minted.expires_at),
        next: Some(
            "Scan the QR with the fleetd app on the phone. The code works once, for 15 minutes."
                .into(),
        ),
        truncated: None,
    })
}
