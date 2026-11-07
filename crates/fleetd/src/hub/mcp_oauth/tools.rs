//! `mcp_oauth_start`: a person opens the sign-in of a saved server. Only a person, with operate on the project's
//! machine, as for saving the server.
use std::sync::Arc;

use fleetd_contracts::mcp::{
    ErrorCode, McpOauthNeedsClient, McpOauthStartInput, McpOauthStartOutput,
};
use fleetd_contracts::mcp_servers::McpScope;
use zeroize::Zeroizing;

use super::{OwnClient, Started};
use crate::hub::api::{Caller, Hub, Registry, ToolError};
use crate::hub::mcp_servers::tools::{may_change, not_found, project_of};

pub fn register(tools: &mut Registry) {
    tools.add("mcp_oauth_start", start);
}

/// Where the service sends the browser back: `<hub>/oauth/callback`, at the address the app reaches the hub by, else
/// the hub's own.
pub fn redirect_uri(hub: &Hub, app_url: Option<&str>) -> Result<String, ToolError> {
    let base = match app_url {
        Some(url) => url.trim().to_owned(),
        None => crate::hub::setup::tools::hub_url(hub),
    };
    let base = if base.contains("://") {
        base
    } else {
        format!("http://{base}")
    };
    let parsed = url::Url::parse(&base)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
        .ok_or_else(|| {
            ToolError::new(
                ErrorCode::Invalid,
                format!("{base} isn't the hub's address."),
            )
            .with_fix("Pass hubUrl as the app reaches the hub: http://<host>:<port>.")
        })?;
    Ok(format!(
        "{}/oauth/callback",
        parsed.as_str().trim_end_matches('/')
    ))
}

async fn start(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpOauthStartInput,
) -> Result<McpOauthStartOutput, ToolError> {
    may_change(&caller, &input.scope)?;
    if matches!(input.scope, McpScope::Global) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "Signing in connects one project's server, with your own account; a global server reaches every \
             teammate's agents.",
        )
        .with_fix("Add the server to the project (a project's Integrations), then sign in."));
    }
    project_of(&hub, &input.scope)?;
    let Some(server) = hub.db.mcp_servers().get(&input.scope, &input.name)? else {
        return Err(not_found(&input.scope, &input.name));
    };
    if super::url_of(&server).is_none() {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} is a command; only a server reached by URL signs in.",
                input.name
            ),
        )
        .with_fix("Give a command server its key in its environment instead."));
    }
    let redirect = redirect_uri(&hub, input.hub_url.as_ref().map(|u| u.as_str()))?;
    let own = match &input.client {
        None => None,
        Some(client) => {
            let secret = match &client.sealed_secret {
                None => None,
                Some(sealed) => {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(sealed.as_str())
                        .unwrap_or_default();
                    let opened = crate::hub::hub_links::box_key(&hub)
                        .ok()
                        .and_then(|k| k.open(&bytes))
                        .and_then(|p| String::from_utf8(p.to_vec()).ok())
                        .ok_or_else(|| {
                            ToolError::new(
                                ErrorCode::Invalid,
                                "The client secret wasn't sealed to this hub's key.",
                            )
                            .with_fix(
                                "Type it again: the app seals it to the key mcp_oauth_start gives.",
                            )
                        })?;
                    Some(Zeroizing::new(opened.trim().to_owned()))
                }
            };
            Some(OwnClient {
                id: client.client_id.as_str().trim().to_owned(),
                secret,
            })
        }
    };
    let started = super::start(&hub, &server, &redirect, own)
        .await
        .map_err(|why| {
            ToolError::new(
                ErrorCode::Failed,
                format!("{} can't sign in: {why}.", input.name),
            )
            .with_fix("Check the URL. If the service gives keys instead, add the server with one.")
        })?;
    Ok(match started {
        Started::SignIn { authorize_url } => McpOauthStartOutput {
            authorize_url: Some(authorize_url),
            redirect_uri: redirect,
            needs_client: None,
            next: Some(
                "Open authorizeUrl in the person's browser. Once they sign in, the server's oauth shows connected \
                 (event mcp.oauth); then test it."
                    .into(),
            ),
            truncated: None,
        },
        Started::NeedsClient { issuer } => McpOauthStartOutput {
            authorize_url: None,
            redirect_uri: redirect,
            needs_client: Some(McpOauthNeedsClient {
                issuer,
                box_pub_key: crate::hub::hub_links::box_key(&hub)
                    .map_err(|e| {
                        ToolError::new(ErrorCode::Failed, format!("The hub's box key can't be read: {e}."))
                    })?
                    .public_key(),
            }),
            next: Some(
                "The service lets no app register itself: make an OAuth client there allowing redirectUri, then \
                 start again with client."
                    .into(),
            ),
            truncated: None,
        },
    })
}
