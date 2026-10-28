//! `github_app_get` for everyone; `github_app_manifest`, `github_app_create`, `github_app_test` and
//! `github_app_remove` for an owner's or admin's device (Settings › Hub accounts › GitHub); `github_connect` and
//! `github_disconnect` for a person's own devices (Settings › Your accounts › GitHub). No key, secret or token crosses any of them.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::github_app::GITHUB_APP_PERMISSIONS;
use fleetd_contracts::mcp::{
    ErrorCode, GithubAppCreateInput, GithubAppCreateOutput, GithubAppGetInput, GithubAppGetOutput,
    GithubAppManifestInput, GithubAppManifestOutput, GithubAppRemoveInput, GithubAppRemoveOutput,
    GithubAppTestInput, GithubAppTestOutput, GithubConnectInput, GithubConnectOutput,
    GithubDisconnectInput, GithubDisconnectOutput,
};

use super::{manifest as app_manifest, new_app_page};
use fleetd_contracts::people::PersonId;

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human, require};
use crate::hub::people::tools::administrator;

pub fn register(tools: &mut Registry) {
    tools.add("github_app_get", get);
    tools.add("github_app_manifest", manifest);
    tools.add("github_app_create", create);
    tools.add("github_app_test", test);
    tools.add("github_app_remove", remove);
    tools.add("github_connect", connect);
    tools.add("github_disconnect", disconnect);
}

/// The person behind a human key: only a person connects their own GitHub.
fn me(hub: &Hub, caller: &Caller) -> Result<PersonId, ToolError> {
    let person = match caller.person.as_ref().filter(|_| is_human(caller)) {
        Some(p) => crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
            .get(&p.person_id)?
            .filter(|p| p.removed_at.is_none()),
        None => None,
    };
    person.map(|p| p.person_id).ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only a person connects their own GitHub, from one of their own devices.",
            "Open Settings › Your accounts › GitHub in the desktop app.",
        )
    })
}

fn require_administrator(hub: &Hub, caller: &Caller) -> Result<(), ToolError> {
    administrator(hub, caller)?.map(|_| ()).ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only the hub's owners and admins set up the hub's GitHub App.",
            "Ask an owner or admin; they set it up on the Hub pages of the app's Settings, or with `fleetd github-app create` on the hub machine.",
        )
    })
}

fn none_yet() -> ToolError {
    error(
        ErrorCode::NotFound,
        "This hub has no GitHub App yet.",
        "Create one in Settings › Hub accounts › GitHub.",
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
    let me = match caller.person.as_ref().filter(|_| is_human(&caller)) {
        Some(p) => hub.github_app.account(&p.person_id)?,
        None => None,
    };
    Ok(GithubAppGetOutput {
        app: hub.db.github_app().get()?,
        me,
        authorize_url: format!("{}/login/oauth/authorize", hub.github_app.endpoints().web),
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
    // What it handed to orders' agents goes too: they use the machine's own login, as before the App.
    super::sessions::withdraw_all(&hub).await;
    Ok(GithubAppRemoveOutput {
        settings_url: app.ok_or_else(none_yet)?.settings_url.into_inner(),
        next: None,
        truncated: None,
    })
}

async fn connect(
    hub: Arc<Hub>,
    caller: Caller,
    input: GithubConnectInput,
) -> Result<GithubConnectOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let me = hub
        .github_app
        .connect(
            &person,
            &input.code,
            &input.code_verifier,
            &input.redirect_uri,
        )
        .await
        .map_err(failed)?;
    Ok(GithubConnectOutput {
        me,
        next: Some("The PRs agents open for your orders open as you from their next turn.".into()),
        truncated: None,
    })
}

async fn disconnect(
    hub: Arc<Hub>,
    caller: Caller,
    _: GithubDisconnectInput,
) -> Result<GithubDisconnectOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let revoked = hub.github_app.disconnect(&person).await.map_err(failed)?;
    // Their open orders' agents no longer hold it.
    super::sessions::withdraw_person(&hub, &person).await;
    Ok(GithubDisconnectOutput {
        revoked,
        next: None,
        truncated: None,
    })
}
