//! The hub link tools. On the hub whose projects a link reaches, a person mints and revokes links (their own; an admin
//! anyone's). On the hub with the Navi, a person adds a link to a Navi, its key sealed to this hub, and removes it.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, HubLinkAddInput, HubLinkAddOutput, HubLinkMintInput, HubLinkMintOutput,
    HubLinkRemoveInput, HubLinkRemoveOutput, HubLinkRevokeInput, HubLinkRevokeOutput,
    HubLinksGetInput, HubLinksGetOutput,
};

use super::{box_key, check_url, client, issued, issued_get, keep, kept, kept_get, mint};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, is_human, require, unknown_project,
};

pub fn register(tools: &mut Registry) {
    tools.add("hub_links_get", get);
    tools.add("hub_link_mint", mint_link);
    tools.add("hub_link_revoke", revoke);
    tools.add("hub_link_add", add);
    tools.add("hub_link_remove", remove);
}

fn person_only(caller: &Caller) -> Result<(), ToolError> {
    if is_human(caller) {
        return Ok(());
    }
    Err(ToolError::new(
        ErrorCode::Forbidden,
        "Only a person links hubs: a link acts as them on the other hub.",
    )
    .with_fix("Do it in the desktop app."))
}

fn box_failed(e: std::io::Error) -> ToolError {
    tracing::error!(error = %e, "hub box key");
    ToolError::new(ErrorCode::Failed, "The hub can't read its box key.")
        .with_fix("Check the hub's home directory is writable, then try again.")
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubLinksGetInput,
) -> Result<HubLinksGetOutput, ToolError> {
    let links = match &input.navi {
        Some(navi) => {
            require(&caller, Role::Read, Some(&navi.machine_id))?;
            kept(&hub.db, Some(navi))?
                .iter()
                .map(super::Kept::info)
                .collect()
        }
        None => Vec::new(),
    };
    let mine = (!allows_everywhere(&caller, Role::Admin))
        .then(|| (caller.key_id.as_str(), caller.person.as_ref()));
    Ok(HubLinksGetOutput {
        links,
        issued: issued(&hub.db, mine)?,
        box_pub_key: box_key(&hub).map_err(box_failed)?.public_key(),
        next: None,
        truncated: None,
    })
}

async fn mint_link(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubLinkMintInput,
) -> Result<HubLinkMintOutput, ToolError> {
    person_only(&caller)?;
    if let Some(projects) = &input.projects {
        if projects.is_empty() {
            return Err(ToolError::new(
                ErrorCode::Invalid,
                "A link limited to no project reaches nothing.",
            )
            .with_fix("Name at least one project, or leave projects out for all of yours."));
        }
        for p in projects {
            if hub.store.project_get(p)?.is_none() {
                return Err(unknown_project(p));
            }
            require(&caller, Role::Operate, Some(&p.machine_id))?;
        }
    }
    let (link, key) = mint(&hub, &caller, &input.label, input.projects.as_deref())?;
    Ok(HubLinkMintOutput {
        link,
        key,
        next: Some(
            "Shown once: paste it into the other hub's Navi, Linked hubs. It acts as you there, at this device's \
             grants; revoke it here at any time."
                .into(),
        ),
        truncated: None,
    })
}

async fn revoke(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubLinkRevokeInput,
) -> Result<HubLinkRevokeOutput, ToolError> {
    person_only(&caller)?;
    let not_found = || {
        ToolError::new(
            ErrorCode::NotFound,
            format!("No link {} on this hub.", input.link_id),
        )
        .with_fix("hub_links_get lists yours.")
    };
    let link = issued_get(&hub.db, input.link_id.as_str())?.ok_or_else(not_found)?;
    let own = link.key_id == caller.key_id.as_str()
        || caller
            .person
            .as_ref()
            .is_some_and(|p| link.person.as_ref().map(|q| &q.person_id) == Some(&p.person_id));
    if !own && !allows_everywhere(&caller, Role::Admin) {
        return Err(not_found());
    }
    super::revoke_issued(&hub, input.link_id.as_str())?;
    Ok(HubLinkRevokeOutput {
        link: issued_get(&hub.db, input.link_id.as_str())?.ok_or_else(not_found)?,
        next: Some("Revoked: its next request is refused.".into()),
        truncated: None,
    })
}

async fn add(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubLinkAddInput,
) -> Result<HubLinkAddOutput, ToolError> {
    person_only(&caller)?;
    let navi = &input.navi;
    require(&caller, Role::Operate, Some(&navi.machine_id))?;
    if hub.store.project_get(navi)?.is_none() {
        return Err(unknown_project(navi));
    }
    crate::hub::navi::bridge::may_use(&hub.db, navi)?;
    let url = check_url(input.url.as_str())?;
    let url = url.as_str().trim_end_matches('/').to_owned();
    let sealed = STANDARD
        .decode(input.sealed.as_str())
        .map_err(|_| ToolError::new(ErrorCode::Invalid, "sealed is not base64."))?;
    let key = box_key(&hub)
        .map_err(box_failed)?
        .open(&sealed)
        .and_then(|plain| String::from_utf8(plain.to_vec()).ok())
        .map(zeroize::Zeroizing::new)
        .ok_or_else(|| {
            ToolError::new(ErrorCode::Invalid, "The key wasn't sealed to this hub.")
                .with_fix("Seal it to boxPubKey from hub_links_get.")
        })?;
    let hello = client::hello(input.label.as_str(), &url, key.trim()).await?;
    let Some(link_id) = keep(&hub, navi, &input.label, &url, &sealed, hello.cursor)? else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("This Navi has a linked hub called {} already.", input.label),
        )
        .with_fix("Pick another label, or remove that link first."));
    };
    tokio::spawn(client::follow(hub.clone(), link_id.clone()));
    let link = kept_get(&hub.db, &link_id)?
        .map(|k| k.info())
        .ok_or_else(crate::hub::api::internal_error)?;
    Ok(HubLinkAddOutput {
        next: Some(format!(
            "The Navi reaches {} project(s) on {}: factory_status and project_message with hub \"{}\".",
            hello.projects.len(),
            input.label,
            input.label
        )),
        link,
        projects: hello.projects,
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubLinkRemoveInput,
) -> Result<HubLinkRemoveOutput, ToolError> {
    person_only(&caller)?;
    let Some(link) = kept_get(&hub.db, input.link_id.as_str())? else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No linked hub {} here.", input.link_id),
        )
        .with_fix("hub_links_get with the Navi lists its links."));
    };
    if !allows(&caller, Role::Operate, Some(&link.navi.machine_id)) {
        return Err(crate::hub::api::forbidden(
            Role::Operate,
            Some(&link.navi.machine_id),
        ));
    }
    // The key goes first, so nothing more goes through it; then the other hub is asked to revoke it too.
    super::forget(&hub.db, &link.link_id)?;
    let revoked_there = client::revoke_there(&hub, &link).await;
    Ok(HubLinkRemoveOutput {
        next: (!revoked_there).then(|| {
            format!(
                "{} didn't answer, so the link still shows there until someone revokes it; it can't be used.",
                link.label
            )
        }),
        revoked_there,
        truncated: None,
    })
}
