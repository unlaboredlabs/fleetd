//! `github_app_get` for everyone; `github_app_manifest`, `github_app_create`, `github_app_test` and
//! `github_app_remove` for an owner's or admin's device (Administration › GitHub). No key or secret of the App crosses
//! any of them.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::github_app::GITHUB_APP_PERMISSIONS;
use fleetd_contracts::mcp::{
    ErrorCode, GithubAppCreateInput, GithubAppCreateOutput, GithubAppGetInput, GithubAppGetOutput,
    GithubAppManifestInput, GithubAppManifestOutput, GithubAppRemoveInput, GithubAppRemoveOutput,
    GithubAppTestInput, GithubAppTestOutput,
};

use super::{manifest as app_manifest, new_app_page};
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, require};
use crate::hub::people::tools::administrator;

pub fn register(tools: &mut Registry) {
    tools.add("github_app_get", get);
    tools.add("github_app_manifest", manifest);
    tools.add("github_app_create", create);
    tools.add("github_app_test", test);
    tools.add("github_app_remove", remove);
}

fn require_administrator(hub: &Hub, caller: &Caller) -> Result<(), ToolError> {
    administrator(hub, caller)?.map(|_| ()).ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only the hub's owners and admins set up the hub's GitHub App.",
            "Ask an owner or admin; they set it up on the app's Administration page, or with `fleetd github-app create` on the hub machine.",
        )
    })
}

fn none_yet() -> ToolError {
    error(
        ErrorCode::NotFound,
        "This hub has no GitHub App yet.",
        "Create one in Administration › GitHub.",
    )
}

fn failed(said: String) -> ToolError {
    ToolError::new(ErrorCode::Failed, said)
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    _: GithubAppGetInput,
) -> Result<GithubAppGetOutput, ToolError> {
    require(&caller, Role::Read, None)?;
    Ok(GithubAppGetOutput {
        app: hub.db.github_app().get()?,
        permissions: GITHUB_APP_PERMISSIONS
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        next: None,
        truncated: None,
    })
}

async fn manifest(
    hub: Arc<Hub>,
    caller: Caller,
    input: GithubAppManifestInput,
) -> Result<GithubAppManifestOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let web = hub.github_app.endpoints().web;
    Ok(GithubAppManifestOutput {
        post_to: new_app_page(&web, input.organization.as_deref()),
        manifest: app_manifest(&input.name, &hub.config.url(), &input.redirect).to_string(),
        next: None,
        truncated: None,
    })
}

async fn create(
    hub: Arc<Hub>,
    caller: Caller,
    input: GithubAppCreateInput,
) -> Result<GithubAppCreateOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let app = hub.github_app.create(&input.code).await.map_err(failed)?;
    Ok(GithubAppCreateOutput {
        app,
        next: None,
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    _: GithubAppTestInput,
) -> Result<GithubAppTestOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let app = hub.github_app.test().await.map_err(failed)?;
    Ok(GithubAppTestOutput {
        app: app.ok_or_else(none_yet)?,
        next: None,
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    _: GithubAppRemoveInput,
) -> Result<GithubAppRemoveOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let app = hub.github_app.remove().await.map_err(failed)?;
    Ok(GithubAppRemoveOutput {
        settings_url: app.ok_or_else(none_yet)?.settings_url.into_inner(),
        next: None,
        truncated: None,
    })
}
