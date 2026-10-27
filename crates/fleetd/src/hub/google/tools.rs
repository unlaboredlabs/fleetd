//! `google_get`, `google_client_set`, `google_client_test`, `google_connect` and `google_disconnect`: the app's calls
//! for a Navi's Google connection. Each relays to a node and keeps what the node answers: a fingerprint, an address.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::google::{
    GOOGLE_REDIRECT, GOOGLE_SCOPES, GoogleAccount, GoogleAnswer, GoogleCall, GoogleClient,
    GooglePubsub, MailWake, MailWakeRule,
};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::mcp::{
    ErrorCode, GoogleClientSetInput, GoogleClientSetOutput, GoogleClientTestInput,
    GoogleClientTestOutput, GoogleConnectInput, GoogleConnectOutput, GoogleDisconnectInput,
    GoogleDisconnectOutput, GoogleGetInput, GoogleGetOutput, GoogleMailSetInput,
    GoogleMailSetOutput, GooglePubsubSetInput, GooglePubsubSetOutput,
};
use fleetd_contracts::mcp_servers::McpSealedOn;
use fleetd_contracts::node_link::{CAP_GOOGLE, CAP_GOOGLE_MAIL};

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, is_human, offline, require,
    unknown_project,
};
use crate::hub::executor::tools::from_executor;

pub fn register(tools: &mut Registry) {
    tools.add("google_get", get);
    tools.add("google_client_set", client_set);
    tools.add("google_client_test", client_test);
    tools.add("google_connect", connect);
    tools.add("google_disconnect", disconnect);
    tools.add("google_pubsub_set", pubsub_set);
    tools.add("google_mail_set", mail_set);
}

/// The node can take Google calls: online and new enough.
fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_GOOGLE) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{m}'s node is too old for Google."),
        )
        .with_fix(format!("Update fleetd on {m} and restart its node.")));
    }
    Ok(())
}

/// The node can take new-mail calls too.
fn mail_node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    node_ready(hub, m)?;
    if !hub.link.node_can(m, CAP_GOOGLE_MAIL) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{m}'s node is too old for real-time mail."),
        )
        .with_fix(format!("Update fleetd on {m} and restart its node.")));
    }
    Ok(())
}

fn unexpected(m: &MachineId) -> ToolError {
    ToolError::new(
        ErrorCode::Failed,
        format!("{m}'s node gave an answer that doesn't fit the call."),
    )
}

async fn ask(hub: &Hub, m: &MachineId, call: GoogleCall) -> Result<GoogleAnswer, ToolError> {
    hub.executors.google(m, call).await.map_err(from_executor)
}

/// A person with operate on the project's machine; the project is a Navi.
fn navi(hub: &Hub, caller: &Caller, r: &ProjectRef) -> Result<(), ToolError> {
    if !is_human(caller) || !allows(caller, Role::Operate, Some(&r.machine_id)) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person connects their Google account, with operate on the Navi's machine.",
        )
        .with_fix("Connect it in the desktop app, on the Navi's Integrations."));
    }
    if hub.store.project_get(r)?.is_none() {
        return Err(unknown_project(r));
    }
    if !crate::hub::navi::bridge::is_navi(&hub.db, r, false)? {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Google connects only to a Navi: its lead asks you before it sends, invites or shares anything, where a \
             coding project's lead would act unasked.",
        )
        .with_fix("Make a Navi for it, and connect Google there."));
    }
    Ok(())
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleGetInput,
) -> Result<GoogleGetOutput, ToolError> {
    require(&caller, Role::Read, None)?;
    let store = hub.db.google();
    let account = match &input.project {
        None => None,
        Some(r) => {
            require(&caller, Role::Read, Some(&r.machine_id))?;
            let mut account = store.account(r)?;
            // Whether Google still takes it is the node's to say; an offline node leaves it unsaid.
            if let Some(a) = account.as_mut()
                && node_ready(&hub, &r.machine_id).is_ok()
            {
                let call = GoogleCall::Status {
                    project_id: r.project_id.clone(),
                };
                if let Ok(GoogleAnswer::Status { connected, lapsed }) =
                    ask(&hub, &r.machine_id, call).await
                {
                    a.lapsed = if connected {
                        lapsed
                    } else {
                        Some("the Navi's machine holds no tokens for it".into())
                    };
                }
            }
            account
        }
    };
    let client = store.client()?;
    let (mail_mode, mail_problem) = super::mail::mode(&hub, client.as_ref())?;
    Ok(GoogleGetOutput {
        client,
        account,
        scopes: GOOGLE_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
        redirect: GOOGLE_REDIRECT.to_owned(),
        mail_mode,
        mail_problem,
        next: None,
        truncated: None,
    })
}

async fn client_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleClientSetInput,
) -> Result<GoogleClientSetOutput, ToolError> {
    if !is_human(&caller) || !allows_everywhere(&caller, Role::Operate) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person with operate on every machine saves the hub's Google OAuth client.",
        )
        .with_fix("Save it in the desktop app: Administration › Google."));
    }
    let mut sealed_on = Vec::new();
    let mut missing_on = Vec::new();
    let mut problems = Vec::new();
    for seal in &input.sealed {
        let m = &seal.machine_id;
        if let Err(e) = node_ready(&hub, m) {
            problems.push(e.message);
            missing_on.push(m.clone());
            continue;
        }
        let call = GoogleCall::ClientSet {
            client_id: input.client_id.clone(),
            sealed: Some(seal.sealed.clone()),
        };
        match ask(&hub, m, call).await {
            Ok(GoogleAnswer::ClientSaved {
                fingerprint: Some(fingerprint),
            }) => sealed_on.push(McpSealedOn {
                machine_id: m.clone(),
                fingerprint,
            }),
            Ok(_) => return Err(unexpected(m)),
            Err(e) => {
                problems.push(format!("{m}: {}", e.message));
                missing_on.push(m.clone());
            }
        }
    }
    if sealed_on.is_empty() {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("No machine took the client. {}", problems.join(" ")),
        )
        .with_fix("Save it again while the machines that run Navis are online."));
    }
    sealed_on.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
    let client = GoogleClient {
        client_id: input.client_id,
        sealed_on,
        updated_at: crate::hub::mcp_servers::now(&hub),
        pubsub: hub.db.google().client()?.and_then(|c| c.pubsub),
    };
    hub.db.google().put_client(&client)?;
    let mut next = "Test it, then connect a Google account from a Navi's Integrations.".to_owned();
    if !problems.is_empty() {
        next = format!("{next} {}", problems.join(" "));
    }
    Ok(GoogleClientSetOutput {
        client,
        missing_on,
        next: Some(next),
        truncated: None,
    })
}

fn no_client() -> ToolError {
    ToolError::new(
        ErrorCode::Invalid,
        "The hub has no Google OAuth client yet.",
    )
    .with_fix("The hub's admin saves one in Administration › Google.")
}

async fn client_test(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleClientTestInput,
) -> Result<GoogleClientTestOutput, ToolError> {
    let client = hub.db.google().client()?.ok_or_else(no_client)?;
    let machine_id = match input.machine_id {
        Some(m) => m,
        None => client
            .sealed_on
            .iter()
            .map(|s| s.machine_id.clone())
            .find(|m| node_ready(&hub, m).is_ok())
            .ok_or_else(|| {
                ToolError::new(
                    ErrorCode::MachineOffline,
                    "No machine holding the client is online to test it on.",
                )
                .with_fix("Start one's node, then test again.")
            })?,
    };
    require(&caller, Role::Operate, Some(&machine_id))?;
    node_ready(&hub, &machine_id)?;
    match ask(&hub, &machine_id, GoogleCall::ClientTest).await? {
        GoogleAnswer::ClientTested(check) => Ok(GoogleClientTestOutput {
            machine_id,
            check,
            next: None,
            truncated: None,
        }),
        _ => Err(unexpected(&machine_id)),
    }
}

async fn connect(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleConnectInput,
) -> Result<GoogleConnectOutput, ToolError> {
    let r = &input.project;
    navi(&hub, &caller, r)?;
    let client = hub.db.google().client()?.ok_or_else(no_client)?;
    if !client
        .sealed_on
        .iter()
        .any(|s| s.machine_id == r.machine_id)
    {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} doesn't hold the hub's Google OAuth client.",
                r.machine_id
            ),
        )
        .with_fix(format!(
            "The hub's admin saves the client again in Administration › Google while {} is online.",
            r.machine_id
        )));
    }
    node_ready(&hub, &r.machine_id)?;
    let call = GoogleCall::Connect {
        project_id: r.project_id.clone(),
        code: input.code,
        code_verifier: input.code_verifier,
        redirect_uri: input.redirect_uri,
        in_use: hub.db.google().others_in_use(r)?,
    };
    let GoogleAnswer::Connected { email, scopes } = ask(&hub, &r.machine_id, call).await? else {
        return Err(unexpected(&r.machine_id));
    };
    // A reconnect keeps the person's mail rule; the watch starts again.
    let mail = hub
        .db
        .google()
        .account(r)?
        .map(|a| MailWake {
            watch_expires_ms: None,
            ..a.mail
        })
        .unwrap_or_default();
    let account = GoogleAccount {
        project_ref: r.clone(),
        email,
        scopes,
        connected_at: crate::hub::mcp_servers::now(&hub),
        mail,
        lapsed: None,
    };
    hub.db.google().put_account(&account)?;
    Ok(GoogleConnectOutput {
        account,
        next: Some(
            "The Navi gets its Google tools from its next start, after its next message. Reads and drafts run at \
             once; a send, reply, invitation, upload or share asks you first."
                .into(),
        ),
        truncated: None,
    })
}

async fn disconnect(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleDisconnectInput,
) -> Result<GoogleDisconnectOutput, ToolError> {
    let r = &input.project;
    if !is_human(&caller) || !allows(&caller, Role::Operate, Some(&r.machine_id)) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person disconnects a Navi's Google account, with operate on its machine.",
        ));
    }
    let Some(account) = hub.db.google().account(r)? else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            "This Navi has no Google account.",
        ));
    };
    // Google revokes a whole grant: while another Navi uses the account, only this one's tokens go.
    let shared = hub
        .db
        .google()
        .others_in_use(r)?
        .iter()
        .any(|e| e.as_str().eq_ignore_ascii_case(account.email.as_str()));
    // The tokens are on the Navi's machine: it deletes them, or nothing changes.
    node_ready(&hub, &r.machine_id)?;
    let call = GoogleCall::Disconnect {
        project_id: r.project_id.clone(),
        revoke: !shared,
    };
    let GoogleAnswer::Disconnected { revoked } = ask(&hub, &r.machine_id, call).await? else {
        return Err(unexpected(&r.machine_id));
    };
    hub.db.google().remove_account(r)?;
    Ok(GoogleDisconnectOutput {
        revoked,
        next: Some(if shared {
            format!(
                "The Navi's tokens are deleted. Another Navi still uses {}, so its access at Google stays.",
                account.email
            )
        } else if revoked {
            "Google revoked the Navi's access. It goes without its Google tools from its next start.".into()
        } else {
            "The Navi's tokens are deleted, but Google didn't confirm the revoke: remove the app at \
             myaccount.google.com/permissions to be sure."
                .into()
        }),
        truncated: None,
    })
}

async fn pubsub_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: GooglePubsubSetInput,
) -> Result<GooglePubsubSetOutput, ToolError> {
    if !is_human(&caller) || !allows_everywhere(&caller, Role::Operate) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person with operate on every machine sets up real-time mail.",
        )
        .with_fix("Real-time mail is set up in Administration › Google."));
    }
    let store = hub.db.google();
    let mut client = store.client()?.ok_or_else(no_client)?;
    let before = client.pubsub.take();
    // The new machine takes the key first: when it can't, nothing changes.
    if let Some(p) = input.pubsub {
        mail_node_ready(&hub, &p.machine_id)?;
        let call = GoogleCall::PubsubSet {
            subscription: p.subscription.clone(),
            sealed: Some(p.sealed),
        };
        let GoogleAnswer::PubsubSaved {
            fingerprint: Some(fingerprint),
        } = ask(&hub, &p.machine_id, call).await?
        else {
            return Err(unexpected(&p.machine_id));
        };
        client.pubsub = Some(GooglePubsub {
            topic: p.topic,
            subscription: p.subscription,
            machine_id: p.machine_id,
            fingerprint,
        });
    }
    // Then the machine that held it before forgets it.
    if let Some(before) = before
        && client
            .pubsub
            .as_ref()
            .is_none_or(|p| p.machine_id != before.machine_id)
        && mail_node_ready(&hub, &before.machine_id).is_ok()
    {
        let call = GoogleCall::PubsubSet {
            subscription: before.subscription.clone(),
            sealed: None,
        };
        if let Err(e) = ask(&hub, &before.machine_id, call).await {
            tracing::warn!(machine_id = %before.machine_id, "Pub/Sub key not forgotten: {}", e.message);
        }
    }
    client.updated_at = crate::hub::mcp_servers::now(&hub);
    store.put_client(&client)?;
    super::mail::reset(&hub)?;
    let next = if client.pubsub.is_some() {
        "Navis whose mail wakes them start watching their inbox within a minute; new mail reaches them in seconds."
    } else {
        "The hub checks the mail of each Navi whose mail wakes it about every minute."
    };
    Ok(GooglePubsubSetOutput {
        client,
        next: Some(next.into()),
        truncated: None,
    })
}

async fn mail_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: GoogleMailSetInput,
) -> Result<GoogleMailSetOutput, ToolError> {
    let r = &input.project;
    if !is_human(&caller) || !allows(&caller, Role::Operate, Some(&r.machine_id)) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person sets when their mail wakes a Navi, with operate on its machine.",
        ));
    }
    let store = hub.db.google();
    let mut account = store.account(r)?.ok_or_else(|| {
        ToolError::new(ErrorCode::NotFound, "This Navi has no Google account.")
            .with_fix("Connect Google first.")
    })?;
    if input.rule == MailWakeRule::Query && input.query.is_none() {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "A query rule needs its query, in Gmail's search syntax.",
        ));
    }
    account.mail = MailWake {
        rule: input.rule,
        query: (input.rule == MailWakeRule::Query)
            .then_some(input.query)
            .flatten(),
        watch_expires_ms: account.mail.watch_expires_ms,
    };
    store.put_account(&account)?;
    Ok(GoogleMailSetOutput {
        account,
        next: Some(
            match input.rule {
                MailWakeRule::Off => "New mail no longer wakes the Navi.",
                MailWakeRule::All => "Each new message in the inbox wakes the Navi.",
                MailWakeRule::Query => "New mail matching the query wakes the Navi.",
            }
            .into(),
        ),
        truncated: None,
    })
}
